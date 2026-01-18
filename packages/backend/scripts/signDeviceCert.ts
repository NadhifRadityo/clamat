import fs from "fs/promises";
import path from "path";
import { Option, Command } from "commander";
import { x509, webcrypto } from "packages/shared/src/crypto";

const cli = new Command()
	.addOption(new Option("-c, --csr <file>", "CSR file to sign").makeOptionMandatory())
	.addOption(new Option("-k, --root-key <file>", "Root CA private key DER").makeOptionMandatory().default(path.join(import.meta.dirname, "./certs/rootCA.key.der")))
	.addOption(new Option("-r, --root-cert <file>", "Root CA cert DER").makeOptionMandatory().default(path.join(import.meta.dirname, "./certs/rootCA.crt.der")))
	.addOption(new Option("-o, --out-dir <dir>", "Output directory").makeOptionMandatory().default(path.join(import.meta.dirname, "./certs/")))
	.addOption(new Option("-d, --days <n>", "Validity days").makeOptionMandatory().argParser(v => parseInt(v)).default(365))
	.parse();
const cliOptions = cli.opts();

const deviceCertRequestDer = await fs.readFile(cliOptions.csr);
const rootKeyDer = await fs.readFile(cliOptions.rootKey);
const rootCertDer = await fs.readFile(cliOptions.rootCert);
const deviceCertRequest = new x509.Pkcs10CertificateRequest(deviceCertRequestDer);
if(!await deviceCertRequest.verify())
	throw new Error("Device certificate request verification failed");
const rootKey = await webcrypto.subtle.importKey(
	"pkcs8",
	rootKeyDer,
	{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
	false,
	["sign"]
);
const rootCert = new x509.X509Certificate(rootCertDer);
const deviceCertRequestKeyUsageExtensions = deviceCertRequest.extensions.find(e => e instanceof x509.KeyUsagesExtension);
const deviceCertRequestExtendedKeyUsageExtension = deviceCertRequest.extensions.find(e => e instanceof x509.ExtendedKeyUsageExtension);
const deviceCertRequestSubjectKeyIdentifierExtension = deviceCertRequest.extensions.find(e => e instanceof x509.SubjectKeyIdentifierExtension);
const deviceCert = await x509.X509CertificateGenerator.create({
	signingKey: rootKey,
	signingAlgorithm: { name: "SHA-256" },
	issuer: rootCert.issuerName,
	publicKey: deviceCertRequest.publicKey,
	subject: deviceCertRequest.subjectName,
	serialNumber: webcrypto.getRandomValues(new Uint8Array(16)).toHex(),
	notBefore: new Date(Date.now()),
	notAfter: new Date(Date.now() + cliOptions.days * 24 * 60 * 60 * 1000),
	extensions: [
		new x509.BasicConstraintsExtension(false, 0, true),
		...(deviceCertRequestKeyUsageExtensions != null ? [new x509.KeyUsagesExtension(deviceCertRequestKeyUsageExtensions.usages & (x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.dataEncipherment), deviceCertRequestKeyUsageExtensions.critical)] : []),
		...(deviceCertRequestExtendedKeyUsageExtension != null ? [new x509.ExtendedKeyUsageExtension(deviceCertRequestExtendedKeyUsageExtension.usages.filter(u => [x509.ExtendedKeyUsage.serverAuth, x509.ExtendedKeyUsage.clientAuth].includes(u as any)), deviceCertRequestExtendedKeyUsageExtension.critical)] : []),
		...(deviceCertRequestSubjectKeyIdentifierExtension != null ? [await x509.SubjectKeyIdentifierExtension.create(deviceCertRequest.publicKey, deviceCertRequestSubjectKeyIdentifierExtension.critical)] : []),
		await x509.AuthorityKeyIdentifierExtension.create(rootCert.publicKey)
	]
});
if(!await deviceCert.verify({ publicKey: rootCert.publicKey }))
	throw new Error("Device certificate verification failed");
const deviceCertChain = new x509.X509Certificates([deviceCert, rootCert]);
if(deviceCertChain.length != 2)
	throw new Error("Device certificate chain must contain at least device cert and root cert");
for(let i = 0; i < deviceCertChain.length - 1; i++) {
	if(await deviceCertChain[i].verify({ publicKey: deviceCertChain[i + 1].publicKey }))
		continue;
	throw new Error("Device certificate chain verification failed");
}

await fs.mkdir(cliOptions.outDir, { recursive: true });
const commonNameAttribute = deviceCertRequest.subjectName.getField("CN")[0];
const nameBase = typeof commonNameAttribute == "string" ? commonNameAttribute.replace(/[^a-zA-Z0-9_.-]/g, "_") : `device-${deviceCert.serialNumber}`;
const deviceCertDer = new Uint8Array(deviceCert.rawData);
const deviceCertChainDer = new Uint8Array(deviceCertChain.export("raw"));
await fs.writeFile(path.join(cliOptions.outDir, `${nameBase}.crt.der`), deviceCertDer, "utf8");
await fs.writeFile(path.join(cliOptions.outDir, `${nameBase}.chain.der`), deviceCertChainDer, "utf8");
console.log("Signed device certificate:");
console.log(" -", path.join(cliOptions.outDir, `${nameBase}.crt.der`));
console.log(" -", path.join(cliOptions.outDir, `${nameBase}.chain.der`));
