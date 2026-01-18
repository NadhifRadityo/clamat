import type { Config } from "drizzle-kit";

export default {
	schema: "./src/db.ts",
	out: "./migrations",
	dialect: "turso",
	verbose: true
} satisfies Config;
