import fs from "fs/promises";
import path from "path";
import { Command } from "commander";
import forge from "node-forge";

const cli = new Command()
	.requiredOption("-c, --csr <file>", "CSR file to sign")
	.requiredOption("-k, --root-key <file>", "Root CA private key PEM", path.join(import.meta.dirname, "./certs/rootCA.key.pem"))
	.requiredOption("-r, --root-cert <file>", "Root CA cert PEM", path.join(import.meta.dirname, "./certs/rootCA.crt.pem"))
	.requiredOption("-o, --out-dir <dir>", "Output directory", path.join(import.meta.dirname, "./certs/"))
	.requiredOption("-d, --days <n>", "Validity days", v => parseInt(v), 365)
	.parse();
const cliOptions = cli.opts();

const csrPem = await fs.readFile(path.resolve(cliOptions.csr), "utf8");
const rootKeyPem = await fs.readFile(path.resolve(cliOptions.rootKey), "utf8");
const rootCertPem = await fs.readFile(path.resolve(cliOptions.rootCert), "utf8");
const csr = forge.pki.certificationRequestFromPem(csrPem);
if(!csr.verify())
	throw new Error("CSR verification failed");
const rootKey = forge.pki.privateKeyFromPem(rootKeyPem);
const rootCert = forge.pki.certificateFromPem(rootCertPem);
const cert = forge.pki.createCertificate();
cert.publicKey = csr.publicKey!;
cert.serialNumber = forge.util.bytesToHex(forge.random.getBytesSync(16));
const now = new Date();
cert.validity.notBefore = now;
cert.validity.notAfter = new Date(now.getTime() + cliOptions.days * 24 * 60 * 60 * 1000);
cert.setSubject(csr.subject.attributes);
cert.setIssuer(rootCert.subject.attributes);
cert.setExtensions([
	{ name: "basicConstraints", cA: false },
	{ name: "keyUsage", digitalSignature: true, keyEncipherment: true },
	{ name: "extKeyUsage", clientAuth: true },
	{ name: "subjectKeyIdentifier" },
	{ name: "authorityKeyIdentifier", keyIdentifier: true }
]);
cert.sign(rootKey, forge.md.sha256.create());

const outDir = path.resolve(cliOptions.outDir);
await fs.mkdir(outDir, { recursive: true });
const cnAttr = csr.subject.attributes.find(a => a.name === "commonName");
const nameBase = typeof cnAttr?.value == "string" ? cnAttr.value.replace(/[^a-zA-Z0-9_.-]/g, "_") : `client-${cert.serialNumber}`;
const certPem = forge.pki.certificateToPem(cert);
const chainPem = certPem + "\n" + rootCertPem;
await fs.writeFile(path.join(outDir, `${nameBase}.crt.pem`), certPem, "utf8");
await fs.writeFile(path.join(outDir, `${nameBase}.chain.pem`), chainPem, "utf8");
console.log("Signed client certificate:");
console.log(" -", path.join(outDir, `${nameBase}.crt.pem`));
console.log(" -", path.join(outDir, `${nameBase}.chain.pem`));
