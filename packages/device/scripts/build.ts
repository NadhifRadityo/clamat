import path from "path";
import { Command } from "@clamat/build-tools/commander";
import { swc, json, rollup, replace, commonjs, progress, bundleStats, nodeResolve, importMetaAssets, nativeAddonLoader, generateBuildMetadata, dynamicRequireDependencies } from "@clamat/build-tools/rollup";

const cli = new Command()
	.parse();
const cliOptions = cli.opts();

const baseDirectory = path.join(import.meta.dirname, "..");
const build = await rollup({
	input: path.join(baseDirectory, "src/index.ts"),
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
		replace({
			preventAssignment: true,
			values: Object.fromEntries(Object.entries(await generateBuildMetadata({ base: baseDirectory }))
				.map(([k, v]) => [`import.meta.env.${k}`, JSON.stringify(v)] as const))
		}),
		progress(),
		bundleStats()
	]
});
await build.write({
	dir: path.join(baseDirectory, "dist/bin/bundle"),
	format: "esm",
	entryFileNames: "[name].mjs",
	sourcemap: true
});
await build.close();
