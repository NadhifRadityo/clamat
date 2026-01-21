import fs0 from "fs";
import fs from "fs/promises";
import path from "path";
import { Writable } from "stream";
import { Option, Command } from "@clamat/build-tools/commander";
import { $, stream, addCleanup, bindCleanup, SSH_TARGET_REGEX, runCleanupAndExit, ChildProcessTracker } from "@clamat/build-tools/dax";

bindCleanup();

const cli = new Command()
	.addOption(new Option("-t, --target <Target>", "Raspberry pi ssh target").makeOptionMandatory())
	.addOption(new Option("-e, --export <Export directory>", "Directory to export").makeOptionMandatory())
	.addOption(new Option("-m, --mount <Mount point>", "The mount point that will be available in the target machine").makeOptionMandatory())
	.parse();
const cliOptions = cli.opts<{
	target: string;
	export: string;
	mount: string;
}>();

if(!SSH_TARGET_REGEX.test(cliOptions.target))
	throw new Error(`Invalid ssh target ${cliOptions.target}`);
await Promise.all(["diod", "ssh", "frpc", "id"]
	.map(b => $`which ${b}`.quiet().then(() => {}, () => { throw new Error(`Required binary not found: ${b}`); })));
await fs.mkdir(path.join(import.meta.dirname, "temp"), { recursive: true });
const tempDir = await fs.mkdtemp(path.join(import.meta.dirname, "temp/9p-"));
addCleanup(async () => {
	console.log("Removing temp directory");
	await fs.rm(tempDir, { force: true, recursive: true });
});

if(!fs0.existsSync(cliOptions.export))
	throw new Error("Directory to export does not exist");

console.log("Starting diod process");
const diodPort = 8192 + Math.floor(Math.random() * 16384);
const diodProcessTracker = new ChildProcessTracker();
const diodCommandChild = $`diod --foreground --listen=${`127.0.0.1:${diodPort}`} --no-auth --export=${cliOptions.export}`.env(diodProcessTracker.env()).spawn();
const diodProcess = await diodProcessTracker.first();
diodCommandChild.finally(() => { throw new Error("Diod process exited"); });
console.log(`Diod process started with pid ${diodProcess.pid} at port ${diodPort}`);
addCleanup(async () => {
	console.log("Killing diod process");
	diodCommandChild.kill("SIGTERM");
	addCleanup(diodCommandChild.catch(() => {}));
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
const remoteDiodForwardPort = 8192 + Math.floor(Math.random() * 16384);
const localFrpcTomlPath = path.join(tempDir, "frpc.toml");
await fs.writeFile(localFrpcTomlPath, `
serverAddr = ${JSON.stringify(cliOptions.target.match(SSH_TARGET_REGEX)!.groups!.host)}
serverPort = ${remoteFrpsPort}
transport.protocol = "quic"
auth.method = "token"
auth.token = ${JSON.stringify(remoteFrpsToken)}
[[proxies]]
name = "9p-server"
type = "tcp"
localIP = "127.0.0.1"
localPort = ${diodPort}
remotePort = ${remoteDiodForwardPort}
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

console.log("Connecting to 9p and setting up 9p mount");
await $`ssh ${cliOptions.target} ${`
set -e
sudo mkdir -p ${JSON.stringify(cliOptions.mount)}
sudo mount -t 9p -n -o version=9p2000.L,trans=tcp -o aname=${JSON.stringify(cliOptions.export)},uname=${JSON.stringify(process.env.USER)},access=any,port=${remoteDiodForwardPort} 127.0.0.1 ${JSON.stringify(cliOptions.mount)}`}`;
addCleanup(async () => {
	console.log("Clearing 9p mount and disconnect 9p");
	await $`ssh ${cliOptions.target} ${`sudo umount -l ${JSON.stringify(cliOptions.mount)} && sudo rm -r ${JSON.stringify(cliOptions.mount)}`}`;
});

console.log("Ready");
await Promise.race([
	diodCommandChild,
	remoteFrpsCommandChild,
	localFrpcCommandChild
]);

await runCleanupAndExit();
