import fs from "fs/promises";
import path from "path";
import { Option, Command } from "@clamat/build-tools/commander";
import { $, runCleanup, bindCleanup, cleanupCallbacks } from "@clamat/build-tools/dax";
import ejs from "@clamat/build-tools/ejs";

bindCleanup();

const cli = new Command()
	.addOption(new Option("-b, --base <Name>", "Name for the base docker image").makeOptionMandatory())
	.addOption(new Option("-n, --name <Name>", "Name for the devel docker image").makeOptionMandatory())
	.parse();
const cliOptions = cli.opts<{
	base: string;
	name: string;
}>();

if(!/^([a-z0-9]+(?:[._-][a-z0-9]+)*\/)([a-z0-9]+(?:[._-][a-z0-9]+)*)(?::([a-zA-Z0-9_][a-zA-Z0-9._-]{0,127}))?$/g.test(cliOptions.name))
	throw new Error("Docker image name is not valid");
await Promise.all(["docker"]
	.map(b => $`which ${b}`.quiet().then(() => {}, () => { throw new Error(`Required binary not found: ${b}`); })));
const tempDir = await fs.mkdtemp(path.join(import.meta.dirname, "temp/docker-"));
cleanupCallbacks.push(async () => {
	console.log("Removing temp directory");
	await fs.rm(tempDir, { force: true, recursive: true });
});

console.log(`Checking if docker image ${cliOptions.base} exists`);
const baseImageLabels = await $`docker image inspect -f '{{json .Config.Labels}}' ${cliOptions.base}`.json<Record<string, string> | null>();
const baseImageEtags = Object.entries(baseImageLabels ?? {}).filter(([k]) => k.startsWith("ETAG_")).map(([_, v]) => v);

console.log("Checking if image is already created");
const createdImageLabels = await $`docker image inspect -f '{{json .Config.Labels}}' ${cliOptions.name}`.json<Record<string, string> | null>().catch(() => "NOT-AVAILABLE" as const);
if(createdImageLabels != "NOT-AVAILABLE" && createdImageLabels != null) {
	if(Object.entries(createdImageLabels).filter(([k]) => k.startsWith("ETAG_")).map(([_, v]) => v).some(e => baseImageEtags.includes(e))) {
		console.log("Image already created. Exiting...");
		await runCleanup();
		process.exit(0);
	}
}
if(createdImageLabels != "NOT-AVAILABLE") {
	console.log(`Removing docker image ${cliOptions.name} because no etags matched`);
	await $`docker image rm ${cliOptions.name}`;
}

const dockerfileTemplate = path.join(import.meta.dirname, "devel.template.dockerfile");
const dockerfileRendered = await ejs.renderFile(dockerfileTemplate, {
	baseImage: cliOptions.base,
	baseImageEtags: baseImageEtags
}, { async: true });
const dockerImageDir = path.join(tempDir, "image");
await fs.mkdir(dockerImageDir, { recursive: true });
const dockerfilePath = path.join(dockerImageDir, "Dockerfile");
console.log(`Writing dockerfile script to ${dockerfilePath}`);
await fs.writeFile(dockerfilePath, dockerfileRendered, "utf-8");

console.log(`Building docker image ${cliOptions.name}`);
await $`docker build -t ${cliOptions.name} ${dockerImageDir}`;

await runCleanup();
