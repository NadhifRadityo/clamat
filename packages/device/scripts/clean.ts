import fs from "fs/promises";
import path from "path";
import { Command } from "@clamat/build-tools/commander";

const cli = new Command()
	.parse();
const cliOptions = cli.opts();

const baseDirectory = path.join(import.meta.dirname, "..");
await fs.rm(path.join(baseDirectory, "dist"), { force: true, recursive: true });
