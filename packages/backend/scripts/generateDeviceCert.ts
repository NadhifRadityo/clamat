import fs from "fs/promises";
import path from "path";
import { Option, Command } from "commander";
import { x509, webcrypto } from "packages/shared/src/crypto";

const cli = new Command()
	.addOption(new Option("-o, --out-dir <dir>", "Output directory").makeOptionMandatory().default(path.join(import.meta.dirname, "./certs/")))
	.addOption(new Option("-n, --common-name <name>", "Common Name (CN)").makeOptionMandatory())
	.addOption(new Option("-b, --bits <n>", "RSA key size").makeOptionMandatory().argParser(v => parseInt(v)).default(2048))
	.parse();
const cliOptions = cli.opts();

const deviceKeys = await webcrypto.subtle.generateKey(
	{
		name: "RSASSA-PKCS1-v1_5",
		modulusLength: cliOptions.bits,
		publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
		hash: "SHA-256"
	},
	true,
	["sign", "verify"]
);
const deviceCertRequest = await x509.Pkcs10CertificateRequestGenerator.create({
	keys: deviceKeys,
	signingAlgorithm: deviceKeys.privateKey.algorithm,
	name: [
		{ "CN": [cliOptions.commonName] }
	],
	extensions: [
		new x509.BasicConstraintsExtension(false, 0, true),
		new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.dataEncipherment, true),
		new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth, x509.ExtendedKeyUsage.clientAuth]),
		await x509.SubjectKeyIdentifierExtension.create(deviceKeys.publicKey)
	]
});
if(!await deviceCertRequest.verify())
	throw new Error("Device certificate request verification failed");

await fs.mkdir(cliOptions.outDir, { recursive: true });
const nameBase = cliOptions.commonName.replace(/[^a-zA-Z0-9_.-]/g, "_");
const deviceKeyDer = new Uint8Array(await webcrypto.subtle.exportKey("pkcs8", deviceKeys.privateKey));
const deviceCertRequestDer = new Uint8Array(deviceCertRequest.rawData);
await fs.writeFile(path.join(cliOptions.outDir, `${nameBase}.key.der`), deviceKeyDer, "utf8");
await fs.writeFile(path.join(cliOptions.outDir, `${nameBase}.csr.der`), deviceCertRequestDer, "utf8");
console.log("Device key and CSR generated:");
console.log(" -", path.join(cliOptions.outDir, `${nameBase}.key.der`));
console.log(" -", path.join(cliOptions.outDir, `${nameBase}.csr.der`));
