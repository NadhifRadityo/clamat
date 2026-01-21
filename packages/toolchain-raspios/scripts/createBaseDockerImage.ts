import fs0 from "fs";
import fs from "fs/promises";
import os from "os";
import path from "path";
import url from "url";
import { Option, Command } from "@clamat/build-tools/commander";
import { $, addCleanup, bindCleanup, runCleanupAndExit, compareDockerEtagLabels, DOCKER_IMAGE_NAME_REGEX } from "@clamat/build-tools/dax";

bindCleanup();

const cli = new Command()
	.addOption(new Option("-u, --url <URL>", "URL to Raspberry Pi OS image. Can accept file:// protocol").makeOptionMandatory())
	.addOption(new Option("-n, --name <Name>", "Name for the created docker image").makeOptionMandatory())
	.parse();
const cliOptions = cli.opts<{
	url: string;
	name: string;
}>();

if(!DOCKER_IMAGE_NAME_REGEX.test(cliOptions.name))
	throw new Error("Docker image name is not valid");
await Promise.all(["unxz", "kpartx", "mount", "umount", "dmsetup", "losetup", "docker", "file", "tar", "sha256sum", "awk"]
	.map(b => $`which ${b}`.quiet().then(() => {}, () => { throw new Error(`Required binary not found: ${b}`); })));
await fs.mkdir(path.join(import.meta.dirname, "temp"), { recursive: true });
const tempDir = await fs.mkdtemp(path.join(import.meta.dirname, "temp/docker-"));
addCleanup(async () => {
	console.log("Removing temp directory");
	await fs.rm(tempDir, { force: true, recursive: true });
});

console.log("Checking if image is already created");
const createdImageLabels = await $`docker image inspect -f '{{json .Config.Labels}}' ${cliOptions.name}`.json<Record<string, string> | null>().catch(() => "NOT-AVAILABLE" as const);
const checkIfImageAlreadyCreated = async () => {
	if(createdImageLabels == "NOT-AVAILABLE" || createdImageLabels == null)
		return;
	if(!compareDockerEtagLabels({ check: createdImageLabels, checkPrefix: "ETAG_IMAGE", against: imageEtags }))
		return;
	console.log("Image already created. Exiting...");
	await runCleanupAndExit();
};
const imageUrl = new URL(cliOptions.url);
const imageEtags = [] as string[];
let imagePath = path.join(tempDir, "raspios.img");
if(imageUrl.protocol == "http:" || imageUrl.protocol == "https:") {
	const response = await fetch(imageUrl, { method: "HEAD" });
	if(!response.ok)
		throw new Error(`Cannot fetch ${imageUrl.href}: ${response.status} ${response.statusText}\n${await response.text()}`);
	if(response.headers.has("ETag")) {
		imageEtags.push(response.headers.get("ETag")!.slice(1, -1));
		await checkIfImageAlreadyCreated();
	}
	console.log(`Downloading ${cliOptions.url}`);
	const imageXzPath = path.join(tempDir, "raspios.img.xz");
	await $.request(cliOptions.url).pipeToPath(imageXzPath);
	imageEtags.push(await $`sha256sum ${imageXzPath} | awk '{print $1}'`.text());
	await checkIfImageAlreadyCreated();
	console.log(`Decompressing file ${imageXzPath}`);
	await $`unxz -c ${imageXzPath} > ${$.path(imagePath)}`;
	imageEtags.push(await $`sha256sum ${imagePath} | awk '{print $1}'`.text());
	await checkIfImageAlreadyCreated();
} else if(imageUrl.protocol == "file:") {
	const filePath =
		imageUrl.host == "" ? url.fileURLToPath(imageUrl) :
			imageUrl.host == "." ? path.join(process.cwd(), imageUrl.pathname) :
				imageUrl.host == "~" ? path.join(os.homedir(), imageUrl.pathname) :
					null;
	if(filePath == null)
		throw new Error(`Invalid file url ${imageUrl.href}`);
	if(!fs0.existsSync(filePath))
		throw new Error(`Cannot find file ${filePath}`);
	if((await $`file ${filePath}`.text()).includes("XZ compressed data")) {
		imageEtags.push(await $`sha256sum ${filePath} | awk '{print $1}'`.text());
		await checkIfImageAlreadyCreated();
		console.log(`Decompressing file ${filePath}`);
		await $`unxz -c ${filePath} > ${$.path(imagePath)}`;
		imageEtags.push(await $`sha256sum ${imagePath} | awk '{print $1}'`.text());
		await checkIfImageAlreadyCreated();
	} else {
		imagePath = filePath;
		imageEtags.push(await $`sha256sum ${imagePath} | awk '{print $1}'`.text());
		await checkIfImageAlreadyCreated();
	}
} else
	throw new Error(`Unsupported protocol ${imageUrl.protocol}`);
if(createdImageLabels != "NOT-AVAILABLE") {
	console.log(`Removing docker image ${cliOptions.name} because no etags matched`);
	await $`docker image rm ${cliOptions.name}`;
}

console.log("Mapping partitions");
await $`sudo kpartx -d ${imagePath}`;
const partitionMapping = await $`sudo kpartx -v -a ${imagePath}`.text();
addCleanup(async () => {
	console.log("Deleting partition mapping");
	await $`sudo kpartx -d ${imagePath}`;
});
console.log(`Detected partitions:\n${partitionMapping}\n`);
const rootPartition = partitionMapping.match(/(loop\d+p2)/)?.[1];
const bootPartition = partitionMapping.match(/(loop\d+p1)/)?.[1];
if(rootPartition != null) {
	addCleanup(async () => {
		console.log(`Unmapping root partition ${rootPartition}`);
		await $`sudo dmsetup remove ${rootPartition}`;
	});
}
if(bootPartition != null) {
	addCleanup(async () => {
		console.log(`Unmapping boot partition ${bootPartition}`);
		await $`sudo dmsetup remove ${bootPartition}`;
	});
}
if(rootPartition != null && bootPartition != null) {
	addCleanup(async () => {
		const loopDevice = `/dev/${(rootPartition ?? bootPartition).slice(0, -"p2".length)}`;
		console.log(`Removing loop device ${loopDevice}`);
		await $`sudo losetup -d ${loopDevice}`;
	});
}
if(rootPartition == null)
	throw new Error("Unable to locate root partition");
const rootMountPath = path.join(tempDir, "root/");
const bootMountPath = path.join(rootMountPath, "boot/");
await fs.mkdir(rootMountPath, { recursive: true });
if(bootPartition != null)
	await fs.mkdir(bootMountPath, { recursive: true });
console.log(`Mounting root partition /dev/mapper/${rootPartition} to ${rootMountPath}`);
await $`sudo mount -o ro -t ext4 ${`/dev/mapper/${rootPartition}`} ${rootMountPath}`;
addCleanup(async () => {
	console.log(`Unmounting root partition ${rootMountPath}`);
	await $`sudo umount ${rootMountPath}`;
});
if(bootPartition != null) {
	console.log(`Mounting boot partition /dev/mapper/${bootPartition} to ${bootMountPath}`);
	await $`sudo mount -o ro -t vfat ${`/dev/mapper/${bootPartition}`} ${bootMountPath}`;
	addCleanup(async () => {
		console.log(`Unmounting boot partition ${bootMountPath}`);
		await $`sudo umount ${bootMountPath}`;
	});
}
const detectBinary = await $`file ${path.join(rootMountPath, "bin/bash")}`.text();
console.log(`Detected binary architecture:\n${detectBinary}\n`);
if(!detectBinary.includes("aarch64"))
	throw new Error(`Unsupported architecture: ${detectBinary}`);
console.log(`Importing docker image ${cliOptions.name}`);
await $`sudo tar -C ${rootMountPath} -c . | docker import --platform linux/arm64 ${imageEtags.flatMap((e, i) => ["--change", `LABEL ETAG_IMAGE_${i}=${e}`])} - ${cliOptions.name}`;

await runCleanupAndExit();
