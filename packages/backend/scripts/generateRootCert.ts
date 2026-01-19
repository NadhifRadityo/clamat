import fs from "fs/promises";
import path from "path";
import { Option, Command } from "@clamat/build-tools/commander";
import { x509, webcrypto } from "@clamat/shared/crypto";

const cli = new Command()
	.addOption(new Option("-o, --out-dir <dir>", "Output directory").makeOptionMandatory().default(path.join(import.meta.dirname, "./certs/")))
	.addOption(new Option("-n, --common-name <name>", "Common Name (CN)").makeOptionMandatory().default("Clamat Root CA"))
	.addOption(new Option("-d, --days <n>", "Validity days").makeOptionMandatory().argParser(v => parseInt(v)).default(3650))
	.addOption(new Option("-b, --bits <n>", "RSA key size").makeOptionMandatory().argParser(v => parseInt(v)).default(4096))
	.parse();
const cliOptions = cli.opts<{
	outDir: string;
	commonName: string;
	days: number;
	bits: number;
}>();

const rootKeys = await webcrypto.subtle.generateKey(
	{
		name: "RSASSA-PKCS1-v1_5",
		modulusLength: cliOptions.bits,
		publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
		hash: "SHA-256"
	},
	true,
	["sign", "verify"]
);
const rootCert = await x509.X509CertificateGenerator.createSelfSigned({
	keys: rootKeys,
	signingAlgorithm: rootKeys.privateKey.algorithm,
	name: [
		{ "CN": [cliOptions.commonName] }
	],
	serialNumber: webcrypto.getRandomValues(new Uint8Array(16)).toHex(),
	notBefore: new Date(Date.now()),
	notAfter: new Date(Date.now() + cliOptions.days * 24 * 60 * 60 * 1000),
	extensions: [
		new x509.BasicConstraintsExtension(true, 2, true),
		new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign | x509.KeyUsageFlags.digitalSignature, true),
		await x509.SubjectKeyIdentifierExtension.create(rootKeys.publicKey)
	]
});
if(!await rootCert.verify())
	throw new Error("Root certificate verification failed");

await fs.mkdir(cliOptions.outDir, { recursive: true });
const rootKeyDer = new Uint8Array(await webcrypto.subtle.exportKey("pkcs8", rootKeys.privateKey));
const rootCertDer = new Uint8Array(rootCert.rawData);
await fs.writeFile(path.join(cliOptions.outDir, "rootCA.key.der"), rootKeyDer, "utf8");
await fs.writeFile(path.join(cliOptions.outDir, "rootCA.crt.der"), rootCertDer, "utf8");
console.log("Root CA generated:");
console.log(" -", path.join(cliOptions.outDir, "rootCA.key.der"));
console.log(" -", path.join(cliOptions.outDir, "rootCA.crt.der"));
