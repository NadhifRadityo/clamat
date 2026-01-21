import fs0 from "fs";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { Writable } from "stream";
import url from "url";
import { Option, Command } from "@clamat/build-tools/commander";
import { $, stream, addCleanup, bindCleanup, sizeToBytes, SSH_TARGET_REGEX, runCleanupAndExit, ChildProcessTracker } from "@clamat/build-tools/dax";

bindCleanup();

const cli = new Command()
	.addOption(new Option("-t, --target <Target>", "Raspberry pi ssh target").makeOptionMandatory())
	.addOption(new Option("-r, --ram <Ram source url>", "Whether to store the ram block as a host ram (ramfs:///mnt/rpi-nbd-ram-0) or as a disk file (file://~/Documents/rpi-nbd-ram-0)").makeOptionMandatory())
	.addOption(new Option("-s, --size <Size>", "Ram block size").makeOptionMandatory().argParser(v => sizeToBytes(v)))
	.parse();
const cliOptions = cli.opts<{
	target: string;
	ram: string;
	size: number;
}>();

if(!SSH_TARGET_REGEX.test(cliOptions.target))
	throw new Error(`Invalid ssh target ${cliOptions.target}`);
await Promise.all(["mount", "umount", "chown", "truncate", "mkswap", "nbdkit", "ssh", "frpc"]
	.map(b => $`which ${b}`.quiet().then(() => {}, () => { throw new Error(`Required binary not found: ${b}`); })));
await fs.mkdir(path.join(import.meta.dirname, "temp"), { recursive: true });
const tempDir = await fs.mkdtemp(path.join(import.meta.dirname, "temp/nbd-"));
addCleanup(async () => {
	console.log("Removing temp directory");
	await fs.rm(tempDir, { force: true, recursive: true });
});

const ramUrl = new URL(cliOptions.ram);
const mountPath =
	ramUrl.host == "" ? url.fileURLToPath(ramUrl) :
		ramUrl.host == "." ? path.join(process.cwd(), ramUrl.pathname) :
			ramUrl.host == "~" ? path.join(os.homedir(), ramUrl.pathname) :
				null;
if(mountPath == null)
	throw new Error(`Invalid ram url ${ramUrl.href}`);
if(fs0.existsSync(mountPath))
	throw new Error("Mount path already exists");
await fs.mkdir(mountPath, { recursive: true });
addCleanup(async () => {
	await fs.rm(mountPath, { recursive: true, force: true });
});
const swapFile = path.join(mountPath, "swap");
if(ramUrl.protocol == "ramfs:") {
	console.log(`Mounting ramfs to ${mountPath}`);
	await $`sudo mount -t ramfs ramfs ${mountPath}`;
	addCleanup(async () => {
		console.log(`Unmounting ramfs from ${mountPath}`);
		await $`sudo umount ${mountPath}`;
	});
	await $`sudo chown $USER:$USER ${mountPath}`;
} else if(ramUrl.protocol == "file:") {
	// noop
} else
	throw new Error(`Unsupported protocol ${ramUrl.protocol}`);
await $`truncate -s ${cliOptions.size} ${swapFile}`;
await $`mkswap ${swapFile}`;

console.log("Starting nbdkit process");
const nbdkitPort = 8192 + Math.floor(Math.random() * 16384);
const nbdkitProcessTracker = new ChildProcessTracker();
const nbdkitCommandChild = $`nbdkit --foreground --ip-addr 127.0.0.1 --port ${nbdkitPort} file ${swapFile} --filter=truncate`.env(nbdkitProcessTracker.env()).spawn();
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

console.log("Connecting to nbd and setting up swap file");
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
sudo swapon --priority 50 "/dev/\${NBD_DEVICE}"
echo "NBD device is: \${NBD_DEVICE}"
`}`.stdout(remoteNbdDeviceStreams.writable);
addCleanup(async () => {
	console.log("Clearing swap file and disconnect nbd");
	const nbdDevice = remoteNbdDeviceStreams.text().match(/^NBD device is: (.+)$/m)![1];
	await $`ssh ${cliOptions.target} ${`sudo swapoff ${`/dev/${nbdDevice}`} && sudo nbd-client -d ${JSON.stringify(`/dev/${nbdDevice}`)}`}`;
});

console.log("Ready");
await Promise.race([
	nbdkitCommandChild,
	remoteFrpsCommandChild,
	localFrpcCommandChild
]);

await runCleanupAndExit();
