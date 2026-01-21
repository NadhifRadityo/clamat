import fs from "fs/promises";
import path from "path";
import { Option, Command } from "@clamat/build-tools/commander";
import { $, addCleanup, bindCleanup, runCleanupAndExit, compareDockerEtagLabels, DOCKER_IMAGE_NAME_REGEX } from "@clamat/build-tools/dax";
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

if(!DOCKER_IMAGE_NAME_REGEX.test(cliOptions.name))
	throw new Error("Docker image name is not valid");
await Promise.all(["docker", "sha256sum", "awk"]
	.map(b => $`which ${b}`.quiet().then(() => {}, () => { throw new Error(`Required binary not found: ${b}`); })));
await fs.mkdir(path.join(import.meta.dirname, "temp"), { recursive: true });
const tempDir = await fs.mkdtemp(path.join(import.meta.dirname, "temp/docker-"));
addCleanup(async () => {
	console.log("Removing temp directory");
	await fs.rm(tempDir, { force: true, recursive: true });
});

console.log("Checking if image is already created");
const createdImageLabels = await $`docker image inspect -f '{{json .Config.Labels}}' ${cliOptions.name}`.json<Record<string, string> | null>()
	.catch(() => ({ "NOT-AVAILABLE": "1" } as Record<string, string>)) ?? {};
let etagCompatible = true;
if(etagCompatible && "NOT-AVAILABLE" in createdImageLabels)
	etagCompatible = false;

console.log(`Checking if docker image ${cliOptions.base} exists`);
const baseImageLabels = await $`docker image inspect -f '{{json .Config.Labels}}' ${cliOptions.base}`.json<Record<string, string> | null>();
if(etagCompatible && baseImageLabels != null && !compareDockerEtagLabels({ check: createdImageLabels, checkPrefix: "ETAG_BASE", against: baseImageLabels, againstPrefix: "ETAG" }))
	etagCompatible = false;

const dockerImageDir = path.join(tempDir, "image");
await fs.mkdir(dockerImageDir, { recursive: true });
const dockerfileTemplate = path.join(import.meta.dirname, "devel.template.dockerfile");
const dockerfileTemplateEtag = await $`sha256sum ${dockerfileTemplate} | awk '{print $1}'`.text();
if(etagCompatible && createdImageLabels.ETAG_TEMPLATE != dockerfileTemplateEtag)
	etagCompatible = false;

if(!etagCompatible) {
	console.log("Rendering dockerfile template because etags aren't compatible");
	const dockerfileRendered = await ejs.renderFile(dockerfileTemplate, {
		baseImage: cliOptions.base,
		baseImageLabels: baseImageLabels,
		dockerfileTemplateEtag: dockerfileTemplateEtag
	}, { async: true });
	const dockerfilePath = path.join(dockerImageDir, "Dockerfile");
	console.log(`Writing dockerfile script to ${dockerfilePath}`);
	await fs.writeFile(dockerfilePath, dockerfileRendered, "utf-8");
	console.log(`Building docker image ${cliOptions.name}`);
	await $`docker build -t ${cliOptions.name} ${dockerImageDir}`;
} else
	console.log("Image already created and etags are compatible. Not rebuilding docker image");

await runCleanupAndExit();
