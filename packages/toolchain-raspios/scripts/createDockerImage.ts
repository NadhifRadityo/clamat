import fs0 from "fs";
import fs from "fs/promises";
import path from "path";
import { Option, Command } from "commander";
import { $ } from "dax";

$.setPrintCommand(true);

const cli = new Command()
	.addOption(new Option("-u, --url <URL>"))
	.addOption(new Option("-f, --file <File>"))
	.addOption(new Option("-n, --name <Name>").makeOptionMandatory())
	.parse();
const cliOptions = cli.opts<{
	file?: string;
	url?: string;
	name: string;
}>();
// eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
if(!!cliOptions.url == !!cliOptions.file)
	throw new Error("Specify exactly one of --url or --file");
if(!/^[a-z][a-z0-9 ._-]{11,64}$/g.test(cliOptions.name))
	throw new Error("Name must match with regex /^[a-z_][a-z0-9 ._-]{11,64}$/g");

await Promise.all(["unxz", "kpartx", "mount", "umount", "dmsetup", "losetup", "docker", "file", "tar"]
	.map(b => $`which ${b}`.quiet().then(() => {}, () => { throw new Error(`Required binary not found: ${b}`); })));
const tempDir = await fs.mkdtemp(path.join(import.meta.dirname, "temp/docker-"));
let imagePath = path.join(tempDir, `${cliOptions.name}.img`);
const rootMountPath = path.join(tempDir, `${cliOptions.name}/`);
const bootMountPath = path.join(rootMountPath, "boot/");

if(typeof cliOptions.url != "undefined") {
	console.log(`Downloading and decompressing ${cliOptions.url}`);
	const imageRequest = $.request(cliOptions.url).showProgress();
	await $`unxz -c < ${imageRequest} > ${imagePath}`;
} else {
	const file = path.resolve(cliOptions.file!);
	if(!fs0.existsSync(file))
		throw new Error(`Cannot find file ${file}`);
	if((await $`file ${file}`.text()).includes("XZ compressed data")) {
		console.log(`Decompressing file ${cliOptions.file}`);
		await $`unxz -c ${file} > ${imagePath}`;
	} else
		imagePath = file;
}

console.log("Mapping partitions");
await $`sudo kpartx -d ${imagePath}`.then(() => {}, () => {});
const partitionMapping = await $`sudo kpartx -v -a ${imagePath}`.text();
console.log(`Detected partitions:\n${partitionMapping}\n`);
const rootPartition = partitionMapping.match(/(loop\d+p2)/)?.[1];
const bootPartition = partitionMapping.match(/(loop\d+p1)/)?.[1];
let rootMounted = false;
let bootMounted = false;
try {
	if(rootPartition == null)
		throw new Error("Unable to locate root partition");
	await fs.mkdir(rootMountPath, { recursive: true });
	if(bootPartition != null)
		await fs.mkdir(bootMountPath, { recursive: true });
	console.log(`Mounting root partition /dev/mapper/${rootPartition} to ${rootMountPath}`);
	await $`sudo mount -o ro -t ext4 ${`/dev/mapper/${rootPartition}`} ${rootMountPath}`;
	rootMounted = true;
	if(bootPartition != null) {
		console.log(`Mounting boot partition /dev/mapper/${bootPartition} to ${bootMountPath}`);
		await $`sudo mount -o ro -t vfat ${`/dev/mapper/${bootPartition}`} ${bootMountPath}`;
		bootMounted = true;
	}
	const detectBinary = await $`file ${path.join(rootMountPath, "bin/bash")}`.quiet("stdout");
	console.log(`Detected binary architecture:\n${detectBinary.stdout}\n`);
	if(!detectBinary.stdout.includes("aarch64"))
		throw new Error(`Unsupported architecture: ${detectBinary.stdout}`);
	const imageName = `local/raspios:${cliOptions.name}`;
	console.log(`Importing docker image ${imageName}`);
	await $`sudo tar -C ${rootMountPath} -c . | docker import --platform linux/arm64 - ${imageName}`;
} finally {
	if(bootMounted) {
		console.log(`Unmounting boot partition ${bootMountPath}`);
		await $`sudo umount ${bootMountPath}`.then(() => {}, () => {});
	}
	if(rootMounted) {
		console.log(`Unmounting root partition ${rootMountPath}`);
		await $`sudo umount ${rootMountPath}`.then(() => {}, () => {});
	}
	await $`sudo kpartx -d ${imagePath}`.then(() => {}, () => {});
	if(rootPartition != null) {
		console.log(`Unmapping root partition ${rootPartition}`);
		await $`sudo dmsetup remove ${rootPartition}`.then(() => {}, () => {});
	}
	if(bootPartition != null) {
		console.log(`Unmapping boot partition ${bootPartition}`);
		await $`sudo dmsetup remove ${bootPartition}`.then(() => {}, () => {});
	}
	if(rootPartition != null && bootPartition != null) {
		const loopDevice = `/dev/${(rootPartition ?? bootPartition).slice(0, -"p2".length)}`;
		console.log(`Removing loop device ${loopDevice}`);
		await $`sudo losetup -d ${loopDevice}`.then(() => {}, () => {});
	}
}

await fs.rm(tempDir, { force: true, recursive: true });
