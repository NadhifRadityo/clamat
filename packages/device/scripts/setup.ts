import fs from "fs/promises";
import path from "path";
import { Option, Command } from "@clamat/build-tools/commander";
import { $, bindCleanup } from "@clamat/build-tools/dax";
import ejs from "@clamat/build-tools/ejs";

bindCleanup();

const cli = new Command()
	.addOption(new Option("-p, --platform <Platform>", "Platform to build against").makeOptionMandatory())
	.addOption(new Option("--toolchain-raspios-name <Name>", "Raspios toolchain docker image"))
	.parse();
const cliOptions = cli.opts<{
	platform: string;
	toolchainRaspiosName?: string;
}>();

const baseDirectory = path.join(import.meta.dirname, "..");
if(["raspios-linux-arm64"].includes(cliOptions.platform)) {
	const toolchainName = cliOptions.toolchainRaspiosName;
	if(typeof toolchainName == "undefined")
		throw new Error("Please specify --toolchain-raspios-name <Name>");
	console.log(`Checking if docker image ${toolchainName} exists`);
	await $`docker image inspect ${toolchainName}`.quiet("stdout");
	const prunedMonorepoPath = path.join(baseDirectory, "dist/docker/app");
	console.log(`Generating pruned monorepo to ${prunedMonorepoPath}`);
	await $`turbo prune @clamat/device --docker --out-dir ${prunedMonorepoPath}`;
	const dockerfileTemplate = path.join(import.meta.dirname, "setup-raspios.template.dockerfile");
	const dockerfileRendered = await ejs.renderFile(dockerfileTemplate, {
		platform: cliOptions.platform,
		toolchainName: toolchainName
	}, { async: true });
	const dockerImageDir = path.join(baseDirectory, "dist/image");
	await fs.mkdir(dockerImageDir, { recursive: true });
	const dockerfilePath = path.join(dockerImageDir, "Dockerfile");
	console.log(`Writing dockerfile script to ${dockerfilePath}`);
	await fs.writeFile(dockerfilePath, dockerfileRendered, "utf-8");
} else
	throw new Error(`Unsupported platform ${cliOptions.platform}`);
