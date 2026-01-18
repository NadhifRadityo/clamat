export * from "rollup";
export * from "@rollup/pluginutils";
export * from "@rollup/plugin-json";
export { default as json } from "@rollup/plugin-json";
export * from "@rollup/plugin-swc";
export { default as swc } from "@rollup/plugin-swc";
export * from "@rollup/plugin-commonjs";
export { default as commonjs } from "@rollup/plugin-commonjs";
export * from "@rollup/plugin-node-resolve";
export { default as nodeResolve } from "@rollup/plugin-node-resolve";
export { importMetaAssets } from "@web/rollup-plugin-import-meta-assets";
export { bundleStats } from "rollup-plugin-bundle-stats";
export { default as progress } from "rollup-plugin-progress";
export * from "estree-toolkit";
export * from "estree-walker";
export { default as MagicString } from "magic-string";

import fs0 from "fs";
import fs from "fs/promises";
import path from "path";
import { createFilter, FilterPattern } from "@rollup/pluginutils";
import { Expression, CallExpression, TemplateLiteral, BinaryExpression } from "estree";
import { is } from "estree-toolkit";
import { asyncWalk } from "estree-walker";
import fastGlob from "fast-glob";
import MagicString from "magic-string";
import picomatch from "picomatch";
import { Plugin } from "rollup";

declare module "estree" {
	interface BaseNodeWithoutComments {
		start: number;
		end: number;
	}
}

export async function findPackageJson(filePath: string) {
	let directory = path.dirname(filePath);
	while(true) {
		const packageJsonPath = path.join(directory, "package.json");
		if(fs0.existsSync(packageJsonPath))
			return JSON.parse(await fs.readFile(packageJsonPath, "utf-8"));
		const parentDirectory = path.dirname(directory);
		if(directory == parentDirectory)
			break;
		directory = parentDirectory;
	}
	return {};
}

export function dynamicRequireDependencies(
	{ include, exclude, errorWhenNoDependenciesFound }:
	{ include?: FilterPattern, exclude?: FilterPattern, errorWhenNoDependenciesFound?: boolean }
) {
	const filter = createFilter(include, exclude);
	function sanitizeString(string: string): string {
		if(string == "")
			return string;
		if(string.includes("*"))
			throw new Error("A dynamic import cannot contain * characters.");
		return fastGlob.escapePath(string);
	}
	function templateLiteralToGlob(node: TemplateLiteral): string {
		let glob = "";
		for(let i = 0; i < node.quasis.length; i += 1) {
			glob += sanitizeString(node.quasis[i].value.raw);
			if(node.expressions.at(i) != null)
				glob += expressionToGlob(node.expressions[i]);
		}
		return glob;
	}
	function callExpressionToGlob(node: CallExpression): string {
		if(is.memberExpression(node.callee) && is.identifier(node.callee.property) && node.callee.property.name == "concat") {
			if(is.super(node.callee.object))
				return `*${node.arguments.map(expressionToGlob).join("")}`;
			return `${expressionToGlob(node.callee.object)}${node.arguments.map(expressionToGlob).join("")}`;
		}
		return "*";
	}
	function binaryExpressionToGlob(node: BinaryExpression): string {
		if(node.operator == "+") {
			if(is.privateIdentifier(node.left))
				return `*${expressionToGlob(node.right)}`;
			return `${expressionToGlob(node.left)}${expressionToGlob(node.right)}`;
		}
		throw new Error(`${node.operator} operator is not supported.`);
	}
	function expressionToGlob(node: Expression): string {
		if(is.templateLiteral(node))
			return templateLiteralToGlob(node);
		if(is.callExpression(node))
			return callExpressionToGlob(node);
		if(is.binaryExpression(node))
			return binaryExpressionToGlob(node);
		if(is.literal(node))
			return sanitizeString(`${node.value}`);
		return "*";
	}
	return {
		name: "rollup-plugin-dynamic-require-dependencies",
		async transform(code, id) {
			if(!filter(id))
				return null;
			const parsed = this.parse(code);
			let ms = null as MagicString | null;
			let possibleDependencies = null as string[] | null;
			let count = -1;
			await asyncWalk(parsed, {
				enter: async node => {
					if(!is.callExpression(node))
						return;
					if(!is.identifier(node.callee) || node.callee.name != "require")
						return;
					const firstArgument = node.arguments.at(0);
					if(firstArgument == null || !is.expression(firstArgument))
						return;
					count++;
					const glob = expressionToGlob(firstArgument).replace(/\*\*/g, "*");
					if(!glob.includes("*") || glob == "*" || glob.startsWith("/") || glob.startsWith("./") || glob.startsWith("../"))
						return;
					const matcher = picomatch(glob);
					possibleDependencies ??= (packageJson => [...new Set([
						...(Object.keys(packageJson.dependencies ?? {})),
						...(Object.keys(packageJson.devDependencies ?? {})),
						...(Object.keys(packageJson.peerDependencies ?? {})),
						...(Object.keys(packageJson.optionalDependencies ?? {}))
					])])(await findPackageJson(id));
					const matchedDependencies = (await Promise.all(possibleDependencies.filter(d => matcher(d))
						.map(async d => [d, await this.resolve(d, id, { skipSelf: true })] as const)))
						.filter(([_, r]) => r != null).map(([d]) => d);
					if(matchedDependencies.length == 0) {
						if(errorWhenNoDependenciesFound == true)
							this.error(new Error(`No dependencies found in ${glob} when trying to dynamically load concatted string from ${id}`));
						return;
					}
					ms ??= new MagicString(code);
					ms.prepend(
						`function __dynamicRequireDependencies${count}__(id) {
	switch(id) {
${matchedDependencies.map(d =>
	`		case ${JSON.stringify(d)}: return require(${JSON.stringify(d)})`
).join("\n")}
		default: throw new Error("Unknown dynamic require dependencies: " + id);
	}
}`
					);
					ms.overwrite(
						node.start,
						node.start + node.callee.name.length,
						`__dynamicRequireDependencies${count}__`
					);
				}
			});
			if(ms == null)
				return null;
			return {
				code: ms.toString(),
				map: ms.generateMap({
					file: id,
					includeContent: true,
					hires: true
				})
			};
		}
	} as Plugin;
}
export function nativeAddonLoader(
	{ include, exclude }:
	{ include?: FilterPattern, exclude?: FilterPattern } = {}
) {
	const filter = createFilter(include, exclude);
	return {
		name: "rollup-plugin-native-addon-loader",
		async load(id) {
			if(!filter(id))
				return null;
			if(!/\.node$/.test(id))
				return null;
			this.addWatchFile(id);
			const ref = this.emitFile({
				type: "asset",
				name: path.basename(id),
				source: await fs.readFile(id)
			});
			const code =
				`import { createRequire } from "module";
import { fileURLToPath } from "url";
const require = createRequire(import.meta.url);
const module = require(fileURLToPath(import.meta.ROLLUP_FILE_URL_OBJ_${ref}));
export default module.default;
export const __synthetic = module;`;
			return {
				code: code,
				syntheticNamedExports: "__synthetic"
			};
		}
	} as Plugin;
}
