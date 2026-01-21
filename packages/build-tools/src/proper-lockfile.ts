export { default as default } from "proper-lockfile";
export * from "proper-lockfile";

import { LockOptions } from "proper-lockfile";

export const defaultLockOptions = {
	realpath: false,
	retries: { retries: 20, factor: 1.2, minTimeout: 100, maxTimeout: 500 }
} as LockOptions;
