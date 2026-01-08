import fs from "fs/promises";
import path from "path";
import { Command } from "commander";
import forge from "node-forge";

const cli = new Command()
	.requiredOption("-o, --out-dir <dir>", "Output directory", path.join(import.meta.dirname, "./certs/"))
	.requiredOption("-n, --common-name <name>", "Common Name (CN)", "Clamat Root CA")
	.requiredOption("-d, --days <n>", "Validity days", v => parseInt(v), 3650)
	.requiredOption("-b, --bits <n>", "RSA key size", v => parseInt(v), 4096)
	.parse();
const cliOptions = cli.opts();

const keys = forge.pki.rsa.generateKeyPair({ bits: cliOptions.bits, e: 0x10001 });
const cert = forge.pki.createCertificate();
cert.publicKey = keys.publicKey;
cert.serialNumber = forge.util.bytesToHex(forge.random.getBytesSync(16));
const now = new Date();
cert.validity.notBefore = now;
cert.validity.notAfter = new Date(now.getTime() + cliOptions.days * 24 * 60 * 60 * 1000);
const attrs = [{ name: "commonName", value: cliOptions.commonName }];
cert.setSubject(attrs);
cert.setIssuer(attrs);
cert.setExtensions([
	{ name: "basicConstraints", cA: true },
	{ name: "keyUsage", keyCertSign: true, cRLSign: true, digitalSignature: true },
	{ name: "subjectKeyIdentifier" }
]);
cert.sign(keys.privateKey, forge.md.sha256.create());

const outDir = path.resolve(cliOptions.outDir);
await fs.mkdir(outDir, { recursive: true });
const privPem = forge.pki.privateKeyToPem(keys.privateKey);
const certPem = forge.pki.certificateToPem(cert);
await fs.writeFile(path.join(outDir, "rootCA.key.pem"), privPem, "utf8");
await fs.writeFile(path.join(outDir, "rootCA.crt.pem"), certPem, "utf8");
console.log("Root CA generated:");
console.log(" -", path.join(outDir, "rootCA.key.pem"));
console.log(" -", path.join(outDir, "rootCA.crt.pem"));
