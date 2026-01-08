import fs from "fs/promises";
import path from "path";
import { Command } from "commander";
import forge from "node-forge";

const cli = new Command()
	.requiredOption("-o, --out-dir <dir>", "Output directory", path.join(import.meta.dirname, "./certs/"))
	.requiredOption("-n, --common-name <name>", "Common Name (CN)")
	.requiredOption("-b, --bits <n>", "RSA key size", v => parseInt(v), 2048)
	.parse();
const cliOptions = cli.opts();

const keys = forge.pki.rsa.generateKeyPair({ bits: cliOptions.bits, e: 0x10001 });
const csr = forge.pki.createCertificationRequest();
csr.publicKey = keys.publicKey;
const attrs = [{ name: "commonName", value: cliOptions.commonName }];
csr.setSubject(attrs);
csr.sign(keys.privateKey, forge.md.sha256.create());
if(!csr.verify())
	throw new Error("CSR verification failed");

const outDir = path.resolve(cliOptions.outDir);
await fs.mkdir(outDir, { recursive: true });
const nameBase = cliOptions.commonName.replace(/[^a-zA-Z0-9_.-]/g, "_");
const privPem = forge.pki.privateKeyToPem(keys.privateKey);
const csrPem = forge.pki.certificationRequestToPem(csr);
await fs.writeFile(path.join(outDir, `${nameBase}.key.pem`), privPem, "utf8");
await fs.writeFile(path.join(outDir, `${nameBase}.csr.pem`), csrPem, "utf8");
console.log("Client key and CSR generated:");
console.log(" -", path.join(outDir, `${nameBase}.key.pem`));
console.log(" -", path.join(outDir, `${nameBase}.csr.pem`));
