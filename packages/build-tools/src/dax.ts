export * from "dax";

import { SpawnOptions } from "child_process";
import { ChildProcess } from "child_process";
import EventEmitter from "events";
import { build$, KillController } from "dax";

export const SSH_TARGET_REGEX = /^(?:(?<user>[a-zA-Z0-9._-]+)@)?(?<host>(?:localhost|(?:[a-zA-Z0-9-]+\.)*[a-zA-Z0-9-]+|\d{1,3}(?:\.\d{1,3}){3}|\[(?:[0-9a-fA-F:]+)\]))(?::(?<port>6553[0-5]|655[0-2]\d|65[0-4]\d{2}|6[0-4]\d{3}|[1-5]?\d{1,4}))?$/;
export const DOCKER_IMAGE_NAME_REGEX = /^([a-z0-9]+(?:[._-][a-z0-9]+)*\/)([a-z0-9]+(?:[._-][a-z0-9]+)*)(?::([a-zA-Z0-9_][a-zA-Z0-9._-]{0,127}))?$/;

const cleanups = [] as ((() => void | Promise<void>) | Promise<any>)[];
export function addCleanup<C extends (typeof cleanups)[number]>(cleanup: C) {
	if(typeof cleanup == "function") {
		let cleaned = false;
		let removed = false;
		const wrappedCleanup = (() => {
			if(cleaned || removed) return;
			cleaned = true;
			const index = cleanups.indexOf(wrappedCleanup);
			if(index != -1)
				cleanups.splice(index, 1);
			return cleanup();
		}) as C & { remove: () => void };
		wrappedCleanup.remove = () => {
			if(cleaned || removed) return;
			removed = true;
			const index = cleanups.indexOf(wrappedCleanup);
			if(index != -1)
				cleanups.splice(index, 1);
		};
		cleanups.push(wrappedCleanup);
		return wrappedCleanup;
	}
	let cleaned = false;
	let removed = false;
	const resolvers = Promise.withResolvers();
	const wrappedCleanup = resolvers.promise as any as C & { remove: () => void };
	cleanup.then(
		value => {
			if(cleaned || removed) return;
			cleaned = true;
			const index = cleanups.indexOf(wrappedCleanup);
			if(index != -1)
				cleanups.splice(index, 1);
			return value;
		},
		reason => {
			if(cleaned || removed) return;
			cleaned = true;
			const index = cleanups.indexOf(wrappedCleanup);
			if(index != -1)
				cleanups.splice(index, 1);
			throw reason;
		}
	);
	wrappedCleanup.remove = () => {
		if(cleaned || removed) return;
		removed = true;
		const index = cleanups.indexOf(wrappedCleanup);
		if(index != -1)
			cleanups.splice(index, 1);
		resolvers.resolve(null);
	};
	return wrappedCleanup;
}
let cleanupRunning = false;
export async function runCleanupAndExit(exitCode = 0): Promise<never> {
	if(cleanupRunning)
		return new Promise(() => {});
	cleanupRunning = true;
	killController.kill("SIGTERM");
	await $.sleep(100);
	console.log("\nRunning cleanup callbacks...");
	while(cleanups.length > 0) {
		const cleanup = cleanups.pop()!;
		try {
			if(typeof cleanup == "function")
				await cleanup();
			else
				await cleanup;
		} catch(error) {
			console.error("Cleanup failed:", error);
		}
	}
	await $.sleep(100);
	killControllerCleanup.kill("SIGINT");
	process.exit(exitCode);
}
let cleanupBound = false;
export function bindCleanup() {
	if(cleanupBound) return;
	cleanupBound = true;
	process.on("SIGINT", () => runCleanupAndExit(130));
	process.on("SIGTERM", () => runCleanupAndExit(143));
	process.on("uncaughtException", error => { console.error("Uncaught exception:", error); runCleanupAndExit(1); });
	process.on("unhandledRejection", error => { console.error("Unhandled rejection:", error); runCleanupAndExit(1); });
}

declare module "child_process" {
	interface ChildProcess {
		spawn(options: SpawnOptions): ChildProcess;
	}
}
const childProcessEventEmitter = new EventEmitter();
const childProcessSet = new WeakSet<ChildProcess>();
const childProcessRefs = [] as (WeakRef<ChildProcess> & { options: SpawnOptions })[];
const childProcessFinalizationRegistry = new FinalizationRegistry<(typeof childProcessRefs)[number]>(ref => {
	const index = childProcessRefs.indexOf(ref);
	if(index == -1) return;
	childProcessRefs.splice(index, 1);
});
const originalChildProcessSpawn = ChildProcess.prototype.spawn;
ChildProcess.prototype.spawn = function(this: ChildProcess, options) {
	(this as any).__options = options;
	if(!childProcessSet.has(this)) {
		const ref = new WeakRef(this) as (typeof childProcessRefs)[number];
		ref.options = options;
		childProcessFinalizationRegistry.register(this, ref);
		childProcessRefs.push(ref);
		childProcessSet.add(this);
		childProcessEventEmitter.emit("spawned", this, options, ref);
	}
	return originalChildProcessSpawn.call(this, options);
};
export class ChildProcessTracker {
	#id: string;
	constructor() {
		this.#id = Math.random().toString(36).substring(2, 7);
	}
	env() {
		return { DAX_PID_TRACKER: this.#id };
	}
	track() {
		return childProcessRefs.filter(r => r.options?.env?.DAX_PID_TRACKER == this.#id)
			.map(r => r.deref()).filter(p => p != null);
	}
	first() {
		return new Promise<ChildProcess>((resolve, reject) => {
			const result = this.track().at(0);
			if(result != null) {
				resolve(result);
				return;
			}
			const onSpawned = (childProcess: ChildProcess, options: SpawnOptions) => {
				if(options?.env?.DAX_PID_TRACKER != this.#id)
					return;
				clearTimeout(handle);
				childProcessEventEmitter.off("spawned", onSpawned);
				resolve(childProcess);
			};
			childProcessEventEmitter.on("spawned", onSpawned);
			const handle = setTimeout(() => {
				childProcessEventEmitter.off("spawned", onSpawned);
				const result = this.track().at(0);
				if(result != null)
					resolve(result);
				else
					reject(new Error("Child process not found"));
			}, 100);
		});
	}
}

const killController = new KillController();
const killControllerCleanup = new KillController();
export const $ = build$({
	commandBuilder: builder => {
		if(cleanupRunning)
			return builder.signal(killControllerCleanup.signal);
		return builder.signal(killController.signal);
	},
	requestBuilder: builder => {
		if(cleanupRunning)
			return builder;
		return builder.showProgress(true);
	}
});
$.setPrintCommand(true);

type KeyofRecordType<T, E> = Extract<{ [K in keyof T]: T[K] extends E ? K : never }[keyof T], string>;
type FnStream<R extends Record<string, any>> = (r: R) => R & {
	external: <I extends string, V>(i: I, v: V) =>
	ReturnType<FnStream<R & { [_ in I]: V }>>;
	passthrough: <OW extends string, OR extends string>(ow: OW, or: OR) =>
	ReturnType<FnStream<R & { [_ in OW]: WritableStream<Uint8Array> } & { [_ in OR]: ReadableStream<Uint8Array> }>>;
	tee: <IR extends KeyofRecordType<R, ReadableStream<Uint8Array>>, OR1 extends string, OR2 extends string>(ir: IR, or1: OR1, or2: OR2) =>
	ReturnType<FnStream<Omit<R, IR> & { [_ in OR1]: ReadableStream<Uint8Array> } & { [_ in OR2]: ReadableStream<Uint8Array> }>>;
	pipeTo: <IR extends KeyofRecordType<R, ReadableStream<Uint8Array>>, IW extends KeyofRecordType<R, WritableStream<Uint8Array>>>(ir: IR, iw: IW, options?: StreamPipeOptions) =>
	ReturnType<FnStream<Omit<R, IR | IW> & { [_ in `pipePromise:${IR}->${IW}`]: Promise<void> }>>;
	stringSink: <OW extends string, OS extends string>(ow: OW, os: OS) =>
	ReturnType<FnStream<R & { [_ in OW]: WritableStream<Uint8Array> } & { [_ in OS]: () => string }>>;
	suppressPromise: <IP extends KeyofRecordType<R, Promise<any>>>(ip: IP) =>
	ReturnType<FnStream<R>>;
};
export const stream = <R extends Record<string, any> = object>(r: R = {} as R) => {
	const external = (i: string, v: any) => {
		return stream({
			...r,
			[i]: v
		});
	};
	const passthrough = (ow: string, or: string) => {
		const { writable, readable } = new TransformStream();
		return stream({
			...r,
			[ow]: writable,
			[or]: readable
		});
	};
	const tee = (ir: string, or1: string, or2: string) => {
		const [readableStream1, readableStream2] = r[ir].tee();
		return stream({
			...r,
			[ir]: undefined,
			[or1]: readableStream1,
			[or2]: readableStream2
		});
	};
	const pipeTo = (ir: string, iw: string, options?: StreamPipeOptions) => {
		const readableStream = r[ir];
		const writableStream = r[iw];
		const promise = readableStream.pipeTo(writableStream, options);
		return stream({
			...r,
			[ir]: undefined,
			[iw]: undefined,
			[`pipePromise:${ir}->${iw}`]: promise
		});
	};
	const stringSink = (ow: string, os: string) => {
		let collected = "";
		const { writable, readable } = new TransformStream();
		readable
			.pipeThrough(new TextDecoderStream())
			.pipeTo(new WritableStream({
				write: chunk => { collected += chunk; }
			}));
		return stream({
			...r,
			[ow]: writable,
			[os]: () => collected
		});
	};
	const suppressPromise = (ip: string) => {
		r[ip].catch(() => {});
		return stream({
			...r
		});
	};
	return {
		...r,
		external,
		passthrough,
		tee,
		pipeTo,
		stringSink,
		suppressPromise
	} as ReturnType<FnStream<R>>;
};

export function compareDockerEtagLabels(
	{ check, checkPrefix, against, againstPrefix }:
	(
		{ check: Record<string, string>, checkPrefix?: string } |
		{ check: string[], checkPrefix?: undefined }
	) & (
		{ against: Record<string, string>, againstPrefix?: string } |
		{ against: string[], againstPrefix?: undefined }
	)
) {
	const checkEtags = Array.isArray(check) ? Object.fromEntries(check.map((v, i) => [`_${i}`, v] as const)) :
		checkPrefix != null ? Object.fromEntries(Object.entries(check).filter(([k]) => k.startsWith(checkPrefix)).map(([k, v]) => [k.slice(checkPrefix.length), v] as const)) :
			check;
	const againstEtags = Array.isArray(against) ? Object.fromEntries(against.map((v, i) => [`_${i}`, v] as const)) :
		againstPrefix != null ? Object.fromEntries(Object.entries(against).filter(([k]) => k.startsWith(againstPrefix)).map(([k, v]) => [k.slice(againstPrefix.length), v] as const)) :
			against;
	const keysGroups = Object.values([...new Set([...Object.keys(checkEtags), ...Object.keys(againstEtags)])]
		.reduce((r, c) => { (r[c.replace(/_\d+$/, "")] ??= []).push(c); return r; }, {} as Record<string, string[]>))
		.map(ks => [ks.filter(k => k in checkEtags), ks.filter(k => k in againstEtags)] as const);
	return keysGroups.every(([cks, aks]) => aks.length == 0 || aks.some(ak => cks.some(ck => checkEtags[ck] == againstEtags[ak])));
}

const sizeUnits = {
	"": 1,
	B: 1,
	K: 1e3,
	KB: 1e3,
	M: 1e6,
	MB: 1e6,
	G: 1e9,
	GB: 1e9,
	T: 1e12,
	TB: 1e12,
	P: 1e15,
	PB: 1e15,
	E: 1e18,
	EB: 1e18,
	KIB: 1024 ** 1,
	MIB: 1024 ** 2,
	GIB: 1024 ** 3,
	TIB: 1024 ** 4,
	PIB: 1024 ** 5,
	EIB: 1024 ** 6
};
export function sizeToBytes(input: string) {
	input = input.trim();
	const match = input.match(/^([+-]?\d+(?:\.\d+)?)(?:\s*([a-zA-Z]+))?$/);
	if(match == null)
		throw new Error(`Invalid size format: ${input}`);
	const value = parseFloat(match[1]);
	if(!Number.isFinite(value))
		throw new Error(`Invalid numeric value: ${match[1]}`);
	const unitRaw = (match[2] ?? "").toUpperCase();
	const multiplier = sizeUnits[unitRaw];
	if(multiplier == null)
		throw new Error(`Unknown size unit: ${match[2]}`);
	return Math.ceil(value * multiplier);
}
