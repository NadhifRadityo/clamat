import fs0 from "fs";
import fs from "fs/promises";
import path from "path";
import { Writable } from "stream";
import { Option, Command } from "@clamat/build-tools/commander";
import { $, stream, addCleanup, bindCleanup, sizeToBytes, SSH_TARGET_REGEX, runCleanupAndExit, ChildProcessTracker } from "@clamat/build-tools/dax";
import lockfile, { defaultLockOptions } from "@clamat/build-tools/proper-lockfile";

bindCleanup();

const cli = new Command()
	.addOption(new Option("-t, --target <Target>", "Raspberry pi ssh target").makeOptionMandatory())
	.addOption(new Option("-d, --disk <Disk file>", "Disk file path").makeOptionMandatory())
	.addOption(new Option("-s, --size <Size>", "Preferred disk file size. Will grow the disk image if the value is greater than current disk size").argParser(v => sizeToBytes(v)))
	.addOption(new Option("-m, --mount <Mount point>", "The mount point that will be available in the target machine").default("/mnt/nbd-disk"))
	.parse();
const cliOptions = cli.opts<{
	target: string;
	disk: string;
	size?: number;
	mount: string;
}>();

if(!SSH_TARGET_REGEX.test(cliOptions.target))
	throw new Error(`Invalid ssh target ${cliOptions.target}`);
await Promise.all(["truncate", "parted", "losetup", "mkfs.ext4", "e2fsck", "resize2fs", "nbdkit", "ssh", "frpc"]
	.map(b => $`which ${b}`.quiet().then(() => {}, () => { throw new Error(`Required binary not found: ${b}`); })));
await fs.mkdir(path.join(import.meta.dirname, "temp"), { recursive: true });
const tempDir = await fs.mkdtemp(path.join(import.meta.dirname, "temp/nbd-"));
addCleanup(async () => {
	console.log("Removing temp directory");
	await fs.rm(tempDir, { force: true, recursive: true });
});
if(await lockfile.check(cliOptions.disk, defaultLockOptions))
	throw new Error(`Disk file ${cliOptions.disk} is currently being used`);
console.log(`Locking disk file ${cliOptions.disk}`);
const unlockDiskFile = await lockfile.lock(cliOptions.disk, defaultLockOptions);
addCleanup(async () => {
	console.log(`Unlocking disk file ${cliOptions.disk}`);
	await unlockDiskFile();
});

if(!fs0.existsSync(cliOptions.disk)) {
	console.log("Disk file doesn't exist. Creating a new disk file");
	await $`truncate -s ${cliOptions.size ?? sizeToBytes("8G")} ${cliOptions.disk}`;
	const cleanupCorruptedDisk = addCleanup(async () => {
		console.log("Deleting disk file because operation was aborted");
		await fs.rm(cliOptions.disk, { force: true });
	});
	console.log("Creating partition for disk file");
	await $`parted ${cliOptions.disk} --script mklabel msdos`;
	await $`parted ${cliOptions.disk} --script mkpart primary ext4 1MiB 100%`;
	console.log("Mounting disk file to loop device");
	const loopDevice = await $`sudo losetup --show -fP ${cliOptions.disk}`.text();
	console.log(`Mounted loop device ${loopDevice}`);
	const cleanupLoopDevice = addCleanup(async () => {
		console.log(`Unmounting loop device ${loopDevice}`);
		await $`sudo losetup -d ${loopDevice}`;
	});
	console.log(`Setting up ext4 partition in ${loopDevice}p1`);
	await $`sudo mkfs.ext4 -F ${`${loopDevice}p1`}`;
	await cleanupLoopDevice();
	cleanupCorruptedDisk.remove();
} else if(cliOptions.size != null) {
	console.log("Disk file already exists, checking disk file size");
	const stat = await fs.stat(cliOptions.disk);
	if(stat.size > cliOptions.size) {
		console.log("Disk file size is greater than the preferred size");
		console.log("Not doing anything because shrinking is risky");
	}
	if(stat.size < cliOptions.size) {
		console.log("Disk file size is less than the preferred size");
		console.log("It is important that you do not interrupt this script while the disk file is being modified. Otherwise you will end up with a corrupted disk file");
		if(await $.confirm("Do you want to grow the disk file?")) {
			console.log(`Growing disk file to ${cliOptions.size} bytes`);
			await $`truncate -s ${cliOptions.size} ${cliOptions.disk}`;
			console.log("Mounting disk to loop device");
			const loopDevice = await $`sudo losetup --show -fP ${cliOptions.disk}`.text();
			console.log(`Mounted loop device ${loopDevice}`);
			const cleanupLoopDevice = addCleanup(async () => {
				console.log(`Unmounting loop device ${loopDevice}`);
				await $`sudo losetup -d ${loopDevice}`;
			});
			console.log(`Growing partition in ${loopDevice}`);
			await $`sudo parted ${loopDevice} --script resizepart 1 100%`;
			console.log(`Resizing ext4 parition in ${loopDevice}p1`);
			await $`sudo e2fsck -f ${`${loopDevice}p1`}`;
			await $`sudo resize2fs ${`${loopDevice}p1`}`;
			await cleanupLoopDevice();
		}
	}
}

console.log("Starting nbdkit process");
const nbdkitPort = 8192 + Math.floor(Math.random() * 16384);
const nbdkitProcessTracker = new ChildProcessTracker();
const nbdkitCommandChild = $`nbdkit --foreground --ip-addr 127.0.0.1 --port ${nbdkitPort} file ${cliOptions.disk} --filter=truncate`.env(nbdkitProcessTracker.env()).spawn();
const nbdkitProcess = await nbdkitProcessTracker.first();
nbdkitCommandChild.finally(() => { throw new Error("Nbdkit process exited"); });
console.log(`Nbdkit process started with pid ${nbdkitProcess.pid} at port ${nbdkitPort}`);
addCleanup(async () => {
	console.log("Killing nbdkit process");
	nbdkitCommandChild.kill("SIGTERM");
	addCleanup(nbdkitCommandChild.catch(() => {}));
});

console.log("Starting reverse port forward server on target machine");
const remoteFrpsPort = 8192 + Math.floor(Math.random() * 16384);
const remoteFrpsToken = Math.random().toString(36).substring(2, 7);
const remoteFrpsProcessTracker = new ChildProcessTracker();
const remoteFrpsStreams = stream()
	.passthrough("writable", "readable").tee("readable", "readableForStdout", "readableForStringSink")
	.external("stdoutWritable", Writable.toWeb(process.stdout))
	.pipeTo("readableForStdout", "stdoutWritable", { preventAbort: true, preventClose: true })
	.suppressPromise("pipePromise:readableForStdout->stdoutWritable")
	.stringSink("stringSinkWritable", "text")
	.pipeTo("readableForStringSink", "stringSinkWritable", { preventAbort: true })
	.suppressPromise("pipePromise:readableForStringSink->stringSinkWritable");
const remoteFrpsCommandChild = $`ssh -tt ${cliOptions.target} ${`
set -e
FRPS_TOML_PATH=$(mktemp)
trap 'rm -f "\${FRPS_TOML_PATH}"' EXIT
cat <<EOF > "\${FRPS_TOML_PATH}"
bindPort = ${remoteFrpsPort}
quicBindPort = ${remoteFrpsPort}
auth.method = "token"
auth.token = ${JSON.stringify(remoteFrpsToken)}
EOF
frps -c "\${FRPS_TOML_PATH}"
`}`.env(remoteFrpsProcessTracker.env()).stdin("null").stdout(remoteFrpsStreams.writable).spawn();
const remoteFrpsProcess = await remoteFrpsProcessTracker.first();
remoteFrpsCommandChild.finally(() => { throw new Error("Remote frps process exited"); });
console.log(`Remote frps process started with pid ${remoteFrpsProcess.pid}`);
addCleanup(() => {
	console.log("Killing remote frps process");
	remoteFrpsCommandChild.kill("SIGTERM");
	addCleanup(remoteFrpsCommandChild.catch(() => {}));
});
for(let i = 0; i < 30; i++) {
	if(remoteFrpsProcess.exitCode != null)
		throw new Error("Remote frps process exited before it was even ready");
	await $.sleep(1000);
	if(remoteFrpsStreams.text().includes("frps started successfully"))
		break;
	if(i == 29)
		throw new Error("Timed out while waiting remote frps process to be ready");
}

console.log("Starting reverse port forward client");
const remoteNbdkitForwardPort = 8192 + Math.floor(Math.random() * 16384);
const localFrpcTomlPath = path.join(tempDir, "frpc.toml");
await fs.writeFile(localFrpcTomlPath, `
serverAddr = ${JSON.stringify(cliOptions.target.match(SSH_TARGET_REGEX)!.groups!.host)}
serverPort = ${remoteFrpsPort}
transport.protocol = "quic"
auth.method = "token"
auth.token = ${JSON.stringify(remoteFrpsToken)}
[[proxies]]
name = "nbd-server"
type = "tcp"
localIP = "127.0.0.1"
localPort = ${nbdkitPort}
remotePort = ${remoteNbdkitForwardPort}
`, "utf-8");
const localFrpcProcessTracker = new ChildProcessTracker();
const localFrpcStreams = stream()
	.passthrough("writable", "readable").tee("readable", "readableForStdout", "readableForStringSink")
	.external("stdoutWritable", Writable.toWeb(process.stdout))
	.pipeTo("readableForStdout", "stdoutWritable", { preventAbort: true, preventClose: true })
	.suppressPromise("pipePromise:readableForStdout->stdoutWritable")
	.stringSink("stringSinkWritable", "text")
	.pipeTo("readableForStringSink", "stringSinkWritable", { preventAbort: true })
	.suppressPromise("pipePromise:readableForStringSink->stringSinkWritable");
const localFrpcCommandChild = $`frpc -c ${localFrpcTomlPath}`.env(localFrpcProcessTracker.env()).stdout(localFrpcStreams.writable).spawn();
const localFrpcProcess = await localFrpcProcessTracker.first();
localFrpcCommandChild.finally(() => { throw new Error("Local frpc process exited"); });
console.log(`Local frpc process started with pid ${localFrpcProcess.pid}`);
addCleanup(() => {
	console.log("Killing local frpc process");
	localFrpcCommandChild.kill("SIGTERM");
	addCleanup(localFrpcCommandChild.catch(() => {}));
});
for(let i = 0; i < 30; i++) {
	if(localFrpcProcess.exitCode != null)
		throw new Error("Local frpc process exited before it was even ready");
	await $.sleep(1000);
	if(localFrpcStreams.text().includes("login to server success"))
		break;
	if(i == 29)
		throw new Error("Timed out while waiting local frpc process to be ready");
}

console.log("Connecting to nbd and mounting disk partition");
const remoteNbdDeviceStreams = stream()
	.passthrough("writable", "readable").tee("readable", "readableForStdout", "readableForStringSink")
	.external("stdoutWritable", Writable.toWeb(process.stdout))
	.pipeTo("readableForStdout", "stdoutWritable", { preventAbort: true, preventClose: true })
	.suppressPromise("pipePromise:readableForStdout->stdoutWritable")
	.stringSink("stringSinkWritable", "text")
	.pipeTo("readableForStringSink", "stringSinkWritable", { preventAbort: true })
	.suppressPromise("pipePromise:readableForStringSink->stringSinkWritable");
await $`ssh ${cliOptions.target} ${`
set -e
for i in $(seq 0 15); do
    if sudo nbd-client 127.0.0.1 ${remoteNbdkitForwardPort} "/dev/nbd\${i}"; then
        NBD_DEVICE="nbd\${i}"
        break
    fi
done
[ -n "\${NBD_DEVICE}" ] || { echo "No free nbd devices"; exit 1; }
sudo partprobe "/dev/\${NBD_DEVICE}"
sudo mkdir -p ${JSON.stringify(cliOptions.mount)}
sudo mount "/dev/\${NBD_DEVICE}p1" ${JSON.stringify(cliOptions.mount)}
sudo chmod 755 ${JSON.stringify(cliOptions.mount)}
echo "NBD device is: \${NBD_DEVICE}"
`}`.stdout(remoteNbdDeviceStreams.writable);
addCleanup(async () => {
	console.log("Unmounting disk partition and disconnect nbd");
	const nbdDevice = remoteNbdDeviceStreams.text().match(/^NBD device is: (.+)$/m)![1];
	await $`ssh ${cliOptions.target} ${`sudo umount -l ${JSON.stringify(cliOptions.mount)} && sudo rm -r ${JSON.stringify(cliOptions.mount)} && sudo nbd-client -d ${JSON.stringify(`/dev/${nbdDevice}`)}`}`;
});

console.log("Ready");
await Promise.race([
	nbdkitCommandChild,
	remoteFrpsCommandChild,
	localFrpcCommandChild
]);

await runCleanupAndExit();
