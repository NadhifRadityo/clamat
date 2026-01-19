export * from "dax";

import { build$, KillController } from "dax";

export const cleanupCallbacks = [] as (() => void | Promise<void>)[];
let cleanupRunning = false;
export const runCleanup = async (exitCode = 0) => {
	if(cleanupRunning) return;
	cleanupRunning = true;
	killController.kill(exitCode == 130 ? "SIGINT" : "SIGTERM");
	await $.sleep(100);
	console.log("\nRunning cleanup callbacks...");
	for(const fn of cleanupCallbacks.reverse())
		try { await fn(); } catch(error) { console.error("Cleanup failed:", error); }
	process.exit(exitCode);
};
let cleanupBound = false;
export const bindCleanup = () => {
	if(cleanupBound) return;
	cleanupBound = true;
	process.on("SIGINT", () => runCleanup(130));
	process.on("SIGTERM", () => runCleanup(143));
	process.on("uncaughtException", error => { console.error("Uncaught exception:", error); runCleanup(1); });
	process.on("unhandledRejection", error => { console.error("Unhandled rejection:", error); runCleanup(1); });
};

const killController = new KillController();
export const $ = build$({
	commandBuilder: builder => {
		if(cleanupRunning)
			return builder;
		return builder.signal(killController.signal);
	},
	requestBuilder: builder => {
		if(cleanupRunning)
			return builder;
		return builder.showProgress(true);
	}
});
$.setPrintCommand(true);
