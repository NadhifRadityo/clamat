import fs from "fs/promises";
import path from "path";
import { Option, Command } from "@clamat/build-tools/commander";
import { $, bindCleanup, runCleanupAndExit, compareDockerEtagLabels, DOCKER_IMAGE_NAME_REGEX } from "@clamat/build-tools/dax";
import ejs from "@clamat/build-tools/ejs";

bindCleanup();

const cli = new Command()
	.addOption(new Option("-p, --platform <Platform>", "Platform to build against").makeOptionMandatory())
	.addOption(new Option("--toolchain-raspios <Name>", "Raspios toolchain docker image"))
	.addOption(new Option("-n, --name <Name>", "Name for the docker image").makeOptionMandatory())
	.parse();
const cliOptions = cli.opts<{
	platform: string;
	toolchainRaspios?: string;
	name: string;
}>();

await Promise.all(["docker", "sha256sum", "awk", "tar", "turbo"]
	.map(b => $`which ${b}`.quiet().then(() => {}, () => { throw new Error(`Required binary not found: ${b}`); })));

const baseDirectory = path.join(import.meta.dirname, "..");
if(["raspios-linux-arm64"].includes(cliOptions.platform)) {
	const toolchainImage = cliOptions.toolchainRaspios;
	if(typeof toolchainImage == "undefined")
		throw new Error("Please specify --toolchain-raspios <Name>");
	if(!DOCKER_IMAGE_NAME_REGEX.test(toolchainImage))
		throw new Error("Docker image name is not valid");

	console.log("Checking if image is already created");
	const createdImageLabels = await $`docker image inspect -f '{{json .Config.Labels}}' ${cliOptions.name}`.json<Record<string, string> | null>()
		.catch(() => ({ "NOT-AVAILABLE": "1" } as Record<string, string>)) ?? {};
	let etagCompatible = true;
	if(etagCompatible && "NOT-AVAILABLE" in createdImageLabels)
		etagCompatible = false;

	console.log(`Checking if docker image ${toolchainImage} exists`);
	const toolchainImageLabels = await $`docker image inspect -f '{{json .Config.Labels}}' ${toolchainImage}`.json<Record<string, string> | null>();
	if(etagCompatible && toolchainImageLabels != null && !compareDockerEtagLabels({ check: createdImageLabels, checkPrefix: "ETAG_TOOLCHAIN", against: toolchainImageLabels, againstPrefix: "ETAG" }))
		etagCompatible = false;

	const dockerImageDir = path.join(baseDirectory, "dist/docker");
	await fs.mkdir(dockerImageDir, { recursive: true });
	const dockerfileTemplate = path.join(import.meta.dirname, "build-raspios.template.dockerfile");
	const dockerfileTemplateEtag = await $`sha256sum ${dockerfileTemplate} | awk '{print $1}'`.text();
	if(etagCompatible && createdImageLabels.ETAG_TEMPLATE != dockerfileTemplateEtag)
		etagCompatible = false;

	const prunedMonorepoPath = path.join(dockerImageDir, "app");
	console.log(`Generating pruned monorepo to ${prunedMonorepoPath}`);
	await $`turbo prune @clamat/device --docker --out-dir ${prunedMonorepoPath}`;
	const prunedMonorepoEtag = await $`tar -c --sort=name --owner=0 --group=0 --numeric-owner --mtime='1970-01-01' -C ${path.join(prunedMonorepoPath, "json")} . | sha256sum | awk '{print $1}'`.text();
	if(etagCompatible && createdImageLabels.ETAG_JSON != prunedMonorepoEtag)
		etagCompatible = false;

	if(!etagCompatible) {
		console.log("Rendering dockerfile template because etags aren't compatible");
		const dockerfileRendered = await ejs.renderFile(dockerfileTemplate, {
			platform: cliOptions.platform,
			toolchainImage: toolchainImage,
			toolchainImageLabels: toolchainImageLabels,
			dockerfileTemplateEtag: dockerfileTemplateEtag,
			prunedMonorepoEtag: prunedMonorepoEtag
		}, { async: true });
		const dockerfilePath = path.join(dockerImageDir, "Dockerfile");
		console.log(`Writing dockerfile script to ${dockerfilePath}`);
		await fs.writeFile(dockerfilePath, dockerfileRendered, "utf-8");
		console.log(`Building docker image ${cliOptions.name}`);
		await $`docker build -t ${cliOptions.name} ${dockerImageDir}`;
	} else
		console.log("Image already created and etags are compatible. Not rebuilding docker image");
	await $`docker run --platform linux/arm64 --rm --net=host --mount ${`type=bind,source=${path.join(prunedMonorepoPath, "full")},target=${"/root/app"}`} -it ${cliOptions.name}`;
} else
	throw new Error(`Unsupported platform ${cliOptions.platform}`);

await runCleanupAndExit();
