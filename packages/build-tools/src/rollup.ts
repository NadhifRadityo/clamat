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
export { default as replace } from "@rollup/plugin-replace";
export { bundleStats } from "rollup-plugin-bundle-stats";
export { default as progress } from "rollup-plugin-progress";
export * from "estree-toolkit";
export * from "estree-walker";
export { default as MagicString } from "magic-string";

import { execFile } from "child_process";
import crypto from "crypto";
import fs0 from "fs";
import fs from "fs/promises";
import path from "path";
import zlib from "zlib";
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

export async function generateBuildMetadata(options_: { base?: string, allowReadFileDirectly?: boolean, includeUnstaged?: boolean, includeUntracked?: boolean }) {
	const options = {
		base: process.cwd(),
		allowReadFileDirectly: true,
		includeUnstaged: true,
		includeUntracked: true,
		...options_
	};
	const gitRoot = await (async () => {
		const base = options.base;
		const dirRoot = path.parse(base).root;
		let dir = base;
		let attempts = 0;
		while(dir != dirRoot && attempts++ < 30) {
			try {
				await fs.access(path.join(dir, ".git"), fs.constants.R_OK);
				const stat = await fs.stat(path.join(dir, ".git"));
				if(stat.isDirectory()) return dir;
				const gitDirContent = await fs.readFile(path.join(dir, ".git"), "utf8");
				const gitDirIndex = gitDirContent.includes("gitdir:") ? gitDirContent.indexOf("gitdir:") + "gitdir:".length : 0;
				// eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
				const gitDirEndIndex = (gitDirContent.indexOf("\n", gitDirIndex) + 1) || gitDirContent.length;
				const gitDir = gitDirContent.slice(gitDirIndex, gitDirEndIndex).trim();
				return path.join(dir, gitDir);
			} catch(_) {
				dir = path.dirname(dir);
			}
		}
		throw new Error("Cannot find git project");
	})();
	const gitFile = (gitRoot: string, ...args: string[]) => path.join(gitRoot, ".git", ...args);
	const gitArgs = (changeDir: string, gitRoot: string, ...args: string[]) => ["-C", changeDir, `--git-dir=${path.join(gitRoot, ".git")}`, `--work-tree=${gitRoot}`, ...args];
	const generateSHA1 = (string: string) => { const shasum = crypto.createHash("sha1"); shasum.update(string); return shasum.digest("hex"); };
	const runCmd = async (cwd: string, cmd: string, args: string[]) => {
		console.log(`Executing ${JSON.stringify(`${cmd} ${args.join(" ")}`)}`);
		return new Promise<string>((resolve, reject) => {
			const childProcess = execFile(cmd, args, { cwd, encoding: "utf-8" }, (error, stdout, stderr) => {
				if(error == null && childProcess.exitCode != null && childProcess.exitCode < 0)
					error = new Error(`Command failed with exit code ${childProcess.exitCode}: ${cmd} ${args.join(" ")}\n${stderr}`);
				if(error != null) {
					reject(error);
					return;
				}
				resolve(stdout);
			});
			childProcess.addListener("error", e => reject(e));
		});
	};
	const parseGitDate = (timeStamp: string, timeOffset: string) => {
		const timestampMs = parseInt(timeStamp, 10) * 1000;
		const offsetSign = timeOffset[0] == "+" ? 1 : -1;
		const offsetHours = parseInt(timeOffset.slice(1, 3), 10);
		const offsetMinutes = parseInt(timeOffset.slice(3, 5), 10);
		const offsetMs = offsetSign * (offsetHours * 3600 + offsetMinutes * 60) * 1000;
		return new Date(timestampMs - offsetMs);
	};
	const parseGitCommitObject = (commitObject: string) => {
		const fullRegex = /^(tree\s+[a-zA-Z0-9]{40})((?:\r?\nparent\s+[a-zA-Z0-9]{40})+)(\r?\nauthor\s(?:[^<]+)\s+<(?:[^>]+)>\s+(?:[0-9]+)\s+(?:[+-][0-9]{4}))(\r?\ncommitter\s(?:[^<]+)\s+<(?:[^>]+)>\s+(?:[0-9]+)\s+(?:[+-][0-9]{4}))(\r?\ngpgsig\s+(?:-+\s*BEGIN\s+[a-zA-Z0-9_.\-$\s]+\s*-+)\s*?(?:\r?\n.*)*?\r?\n\s*(?:-+\s*END\s+[a-zA-Z0-9_.\-$\s]+\s*-+))?\r?\n\r?\n((?:.|\r?\n)+)$/gm;
		const fullMatcher = fullRegex.exec(commitObject);
		if(fullMatcher == null)
			return null;
		const treeRegex = /tree\s+([a-zA-Z0-9]{40})/gm;
		const parentRegex = /parent\s+([a-zA-Z0-9]{40})/gm;
		const authorRegex = /author\s(?<name>[^<]+)\s+<(?<email>[^>]+)>\s+(?<timeStamp>[0-9]+)\s+(?<timeOffset>[+-][0-9]{4})/gm;
		const committerRegex = /committer\s(?<name>[^<]+)\s+<(?<email>[^>]+)>\s+(?<timeStamp>[0-9]+)\s+(?<timeOffset>[+-][0-9]{4})/gm;
		const gpgSigRegex = /gpgsig\s+((?:-+\s*BEGIN\s+[a-zA-Z0-9_.\-$\s]+\s*-+)\s*?(?:\r?\n.*)*?\r?\n\s*(?:-+\s*END\s+[a-zA-Z0-9_.\-$\s]+\s*-+))\s*/gm;
		const tree = treeRegex.exec(fullMatcher[1].trim())![1].trim();
		const parents = [...fullMatcher[2].trim().matchAll(parentRegex)].map(m => m[1].trim());
		const author = authorRegex.exec(fullMatcher[3].trim())!.groups!;
		const committer = committerRegex.exec(fullMatcher[4].trim())!.groups!;
		const gpgSig = fullMatcher[5] != null ? gpgSigRegex.exec(fullMatcher[5].trim())![1] : null;
		author.name = author.name.trim();
		author.email = author.email.trim();
		author.timeStamp = author.timeStamp.trim();
		author.timeOffset = author.timeOffset.trim();
		author.time = parseGitDate(author.timeStamp, author.timeOffset).toISOString();
		committer.name = committer.name.trim();
		committer.email = committer.email.trim();
		committer.timeStamp = committer.timeStamp.trim();
		committer.timeOffset = committer.timeOffset.trim();
		committer.time = parseGitDate(committer.timeStamp, committer.timeOffset).toISOString();
		return { tree, parents, author, committer, gpgSig };
	};
	const getGitHeadCommitId = async (
		{ base, gitRoot, allowReadFileDirectly }:
		{ base: string, gitRoot: string, allowReadFileDirectly: boolean }
	) => {
		let readFileError = null;
		if(allowReadFileDirectly) {
			try {
				const headRefContent = await fs.readFile(gitFile(gitRoot, "HEAD"), "utf-8");
				const headRefIndex = headRefContent.includes("ref:") ? headRefContent.indexOf("ref:") + "ref:".length : 0;
				// eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
				const headRefEndIndex = (headRefContent.indexOf("\n", headRefIndex) + 1) || headRefContent.length;
				const headRef = headRefContent.slice(headRefIndex, headRefEndIndex).trim();
				if(headRef == "")
					throw new Error("Git HEAD file does not have ref");
				const commitId = (await fs.readFile(gitFile(gitRoot, headRef), "utf-8")).trim();
				if(commitId == "")
					throw new Error("Git REF file is empty");
				return commitId;
			} catch(e) {
				readFileError = e;
			}
		}
		try {
			const commitId = (await runCmd(base, "git", gitArgs(base, gitRoot, "rev-parse", "HEAD"))).trim();
			if(commitId == "") throw new Error("Output of `git rev-parse HEAD` is empty");
			return commitId;
		} catch(e) {
			if(readFileError != null)
				e.cause = readFileError;
			throw e;
		}
	};
	const getGitCommitObject = async (
		{ base, gitRoot, commitId, allowReadFileDirectly }:
		{ base: string, gitRoot: string, commitId: string, allowReadFileDirectly: boolean }
	) => {
		let readFileError = null;
		if(allowReadFileDirectly) {
			try {
				const commitObjectFile = gitFile(gitRoot, "objects", commitId.slice(0, 2), commitId.slice(2));
				const commitObject = await new Promise<string>((resolve, reject) => fs.readFile(commitObjectFile).then(
					c => zlib.inflate(c, (e, r) => { if(e != null) reject(e); else resolve(r.toString("utf-8")); }),
					e => reject(e)));
				const parsedCommitObject = parseGitCommitObject(commitObject);
				if(parsedCommitObject == null)
					throw new Error("Cannot parse commit object file");
				return parsedCommitObject;
			} catch(e) {
				readFileError = e;
			}
		}
		try {
			const commitObject = await runCmd(base, "git", gitArgs(base, gitRoot, "cat-file", "-p", commitId));
			const parsedCommitObject = parseGitCommitObject(commitObject);
			if(parsedCommitObject == null)
				throw new Error("Cannot parse commit object file");
			return parsedCommitObject;
		} catch(e) {
			if(readFileError != null)
				e.cause = readFileError;
			throw e;
		}
	};
	const getGitFileStats = async (
		{ base, gitRoot, includeUnstaged, includeUntracked }:
		{ base: string, gitRoot: string, includeUnstaged: boolean, includeUntracked: boolean }
	) => {
		const listFiles = (await runCmd(base, "git", gitArgs(base, gitRoot,
			"ls-files", ...(includeUnstaged ? ["--modified"] : []), ...(includeUntracked ? ["--others"] : []),
			"--exclude-standard", "--exclude='node_modules'", "--exclude='dist'")))
			.split("\n").map(f => f.trim()).filter(f => f.length > 0);
		const fileStatsSettled = await Promise.allSettled(listFiles.map(async f => [f.replaceAll("\\", "/"), await fs.stat(path.join(base, f))] as const));
		const errors = fileStatsSettled.filter((s): s is PromiseRejectedResult => s.status == "rejected" && s.reason.code != "ENOENT").map(s => s.reason);
		if(errors.length > 0)
			throw new Error("Cannot stat files", { cause: errors });
		return fileStatsSettled.filter(s => s.status == "fulfilled").map(s => s.value);
	};
	const staticBuildDate = global.staticBuildDate ??= (new Date()).toISOString();
	const generateBuildMetadata = async () => {
		const { base, allowReadFileDirectly, includeUnstaged, includeUntracked } = options;
		const commitIdPromise = getGitHeadCommitId({ base, gitRoot, allowReadFileDirectly });
		const commitObjectPromise = commitIdPromise.then(v => getGitCommitObject({ base, gitRoot, commitId: v, allowReadFileDirectly }));
		const unstagedUntrackedFileStatsPromise = includeUnstaged || includeUntracked ? getGitFileStats({ base, gitRoot, includeUnstaged, includeUntracked }) : null;
		const [commitId, commitObject, unstagedUntrackedFileStats] = await Promise.all(
			[commitIdPromise, commitObjectPromise, unstagedUntrackedFileStatsPromise]);
		const unstagedUntrackedId = unstagedUntrackedFileStats == null || unstagedUntrackedFileStats.length == 0 ? null :
			generateSHA1(unstagedUntrackedFileStats.map(([f, s]) => `${f}:${s.ino}:${s.size}:${s.blocks}:${s.mtime}`).join("\n"));
		const buildId = `${commitId}${unstagedUntrackedId != null ? `-${unstagedUntrackedId}` : ""}`;
		const buildDate = new Date(Math.max(Date.parse(staticBuildDate), ...(unstagedUntrackedFileStats != null ? unstagedUntrackedFileStats.map(([_, s]) => s.mtime.getTime()) : [])));
		console.log(`Generated new build id: ${buildId} ${buildDate.toISOString()}`);
		const buildMetadata = {
			BUILD_ID: buildId,
			BUILD_DATE: buildDate.toISOString(),
			BUILD_COMMIT_ID: commitId,
			BUILD_COMMIT_TREE: commitObject.tree,
			BUILD_COMMIT_PARENTS: JSON.stringify(commitObject.parents),
			BUILD_COMMIT_AUTHOR_NAME: commitObject.author.name,
			BUILD_COMMIT_AUTHOR_EMAIL: commitObject.author.email,
			BUILD_COMMIT_AUTHOR_TIME: commitObject.author.time,
			BUILD_COMMIT_AUTHOR_TIMESTAMP: commitObject.author.timeStamp,
			BUILD_COMMIT_AUTHOR_TIMEOFFSET: commitObject.author.timeOffset,
			BUILD_COMMIT_COMMITTER_NAME: commitObject.committer.name,
			BUILD_COMMIT_COMMITTER_EMAIL: commitObject.committer.email,
			BUILD_COMMIT_COMMITTER_TIME: commitObject.committer.time,
			BUILD_COMMIT_COMMITTER_TIMESTAMP: commitObject.committer.timeStamp,
			BUILD_COMMIT_COMMITTER_TIMEOFFSET: commitObject.committer.timeOffset,
			BUILD_COMMIT_GPG_SIGNATURE: commitObject.gpgSig ?? ""
		};
		return buildMetadata;
	};
	return await generateBuildMetadata();
}
