import fs from "fs/promises";
import path from "path";
import { swc, json, rollup, commonjs, progress, bundleStats, nodeResolve, importMetaAssets, nativeAddonLoader, dynamicRequireDependencies } from "@clamat/build-tools/rollup";
import { Option, Command } from "commander";

const cli = new Command()
	.addOption(new Option("-m, --mode <mode>").makeOptionMandatory().choices(["compile", "clean"]))
	.parse();
const cliOptions = cli.opts();

if(cliOptions.mode == "compile") {
	const build = await rollup({
		input: path.join(import.meta.dirname, "src/index.ts"),
		plugins: [
			json(),
			swc(),
			dynamicRequireDependencies({
				errorWhenNoDependenciesFound: true
			}),
			commonjs({
				ignoreDynamicRequires: true
			}),
			nodeResolve({
				extensions: [".ts", ".mts", ".js", ".mjs"],
				preferBuiltins: true
			}),
			nativeAddonLoader(),
			importMetaAssets(),
			progress(),
			bundleStats()
		]
	});
	await build.write({
		dir: path.join(import.meta.dirname, "dist"),
		format: "esm",
		entryFileNames: "[name].mjs",
		sourcemap: true
	});
	await build.close();
}
if(cliOptions.mode == "clean")
	await fs.rm(path.join(import.meta.dirname, "dist"), { force: true, recursive: true });
