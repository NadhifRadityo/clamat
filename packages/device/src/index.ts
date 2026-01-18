import dgram from "dgram";
import fs0 from "fs";
import fs from "fs/promises";
import https from "https";
import net from "net";
import os from "os";
import path from "path";
import url from "url";
import { x509, derToPem, webcrypto, serialNumberFromPublicKey, encryptionKeyFromPrivateKey } from "@clamat/shared/crypto";
import { serve, HttpBindings } from "@hono/node-server";
import { createClient as dbCreateClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate as drizzleMigrate } from "drizzle-orm/libsql/migrator";
import { Hono } from "hono";
import makeMdns from "multicast-dns";

import * as dbSchema from "./db";

declare global {
	interface ImportMetaEnv {
		readonly BUILD_ID: string;
	}
	interface ImportMeta {
		readonly env: ImportMetaEnv;
	}
}

const homeDirectory = path.join(process.env.CLAMAT_HOME_DIRECTORY!, import.meta.env.BUILD_ID);
const deviceKeyDer = await fs.readFile(path.join(homeDirectory, "device.key.der"));
const deviceCertChainDer = await fs.readFile(path.join(homeDirectory, "device.chain.der"));
const deviceKey = await webcrypto.subtle.importKey(
	"pkcs8",
	deviceKeyDer,
	{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
	false,
	["sign"]
);
const deviceCertChain = new x509.X509Certificates(deviceCertChainDer);
if(deviceCertChain.length != 2)
	throw new Error("Device certificate chain must contain at least device cert and root cert");
for(let i = 0; i < deviceCertChain.length - 1; i++) {
	if(await deviceCertChain[i].verify({ publicKey: deviceCertChain[i + 1].publicKey }))
		continue;
	throw new Error("Device certificate chain verification failed");
}
const deviceCert = deviceCertChain[0];
const intermediateCerts = deviceCertChain.slice(1, -1);
const rootCert = deviceCertChain.at(-1)!;
const serialNumber = serialNumberFromPublicKey(await deviceCert.publicKey.export());
const dbPath = path.join(homeDirectory, `databases/${serialNumber}-core/database.db`);
const dbClient = dbCreateClient({ url: `file:${dbPath}`, encryptionKey: await encryptionKeyFromPrivateKey(deviceKey, "core-db") });
const db = drizzle(dbClient, { schema: dbSchema });

await dbClient.execute("PRAGMA journal_mode = WAL");
const getMigrationFiles = async (filePath: string) => {
	const dirname = path.dirname(filePath);
	const basename = path.basename(filePath);
	if(dirname == "/meta" && basename == "_journal.json")
		return fs.readFile(url.fileURLToPath(new URL("../migrations/meta/_journal.json", import.meta.url)), "utf-8");
	if(dirname == "/" && basename.endsWith(".sql"))
		return fs.readFile(url.fileURLToPath(new URL(`../migrations/${basename.slice(0, ".sql".length)}.sql`, import.meta.url)), "utf-8");
	throw new Error(`Cannot find migration file with path ${filePath}`);
};
await (async () => {
	const migrationsFolder = path.join(homeDirectory, `databases/${serialNumber}-core/migrations/`);
	if(!fs0.existsSync(path.join(migrationsFolder, "/meta/_journal.json"))) {
		const journal = JSON.parse(await getMigrationFiles("/meta/_journal.json"));
		for(let i = 0; i < journal.entries.length; i++) {
			const migrationContent = await getMigrationFiles(`/${journal.entries[i].tag}.sql`);
			await fs.writeFile(path.join(migrationsFolder, `/${journal.entries[i].tag}.sql`), migrationContent, "utf-8");
		}
		await fs.writeFile(path.join(migrationsFolder, "/meta/_journal.json"), JSON.stringify(journal, null, 4), "utf-8");
		await drizzleMigrate(db, { migrationsFolder: migrationsFolder });
		return;
	}
	const localJournal = JSON.parse(await fs.readFile(path.join(migrationsFolder, "/meta/_journal.json"), "utf-8"));
	const journal = JSON.parse(await getMigrationFiles("/meta/_journal.json"));
	if(localJournal.version != journal.version)
		throw new Error("Incompatible journal version");
	if(localJournal.dialect != journal.dialect)
		throw new Error("Incompatible journal dialect");
	if(localJournal.entries.length > journal.entries.length)
		throw new Error("Incompatible journal entries");
	for(let i = 0; i < localJournal.entries.length; i++) {
		if(JSON.stringify(localJournal.entries[i]) != JSON.stringify(journal.entries[i]))
			throw new Error("Incompatible journal entries");
		const localMigrationContent = await fs.readFile(path.join(migrationsFolder, `/${localJournal.entries[i].tag}.sql`), "utf-8");
		const migrationContent = await getMigrationFiles(`/${journal.entries[i].tag}.sql`);
		if(localMigrationContent != migrationContent)
			throw new Error("Incompatible journal entries");
	}
	for(let i = localJournal.entries.length; i < journal.entries.length; i++) {
		const migrationContent = await getMigrationFiles(`/${journal.entries[i].tag}.sql`);
		await fs.writeFile(path.join(migrationsFolder, `/${journal.entries[i].tag}.sql`), migrationContent, "utf-8");
	}
	await fs.writeFile(path.join(migrationsFolder, "/meta/_journal.json"), JSON.stringify(journal, null, 4), "utf-8");
	await drizzleMigrate(db, { migrationsFolder: migrationsFolder });
})();

type DnsQuestion = makeMdns.QueryPacket["questions"][number];
type DnsAnswer = makeMdns.ResponsePacket["answers"][number];
const getMdnsResponse = (question: DnsQuestion, httpsServiceAddressInfo: net.AddressInfo): DnsAnswer[] => {
	if(question.name == "_services._dns-sd._udp.local" && question.type == "PTR") {
		return [
			{ type: "PTR", name: "_services._dns-sd._udp.local", data: "_https._tcp.local" }
		];
	}
	if(question.name == "_https._tcp.local" && question.type == "PTR") {
		return [
			{ type: "PTR", name: "_https._tcp.local", data: `${serialNumber}-clamat-device._https._tcp.local` }
		];
	}
	if(question.name == `${serialNumber}-clamat-device._https._tcp.local` && question.type == "SRV") {
		return [
			{ type: "SRV", name: `${serialNumber}-clamat-device._https._tcp.local`, data: { target: `${serialNumber}-clamat-device.local`, port: httpsServiceAddressInfo.port } },
			...(httpsServiceAddressInfo.family == "IPv4" ? [
				{ type: "A", name: `${serialNumber}.clamat-device.local`, data: httpsServiceAddressInfo.address }
			] as DnsAnswer[] : []),
			...(httpsServiceAddressInfo.family == "IPv6" ? [
				{ type: "AAAA", name: `${serialNumber}.clamat-device.local`, data: httpsServiceAddressInfo.address }
			] as DnsAnswer[] : [])
		];
	}
	if(question.name == `${serialNumber}.clamat-device.local` && question.type == "A" && httpsServiceAddressInfo.family == "IPv4") {
		return [
			{ type: "A", name: `${serialNumber}.clamat-device.local`, data: httpsServiceAddressInfo.address }
		];
	}
	if(question.name == `${serialNumber}.clamat-device.local` && question.type == "AAAA" && httpsServiceAddressInfo.family == "IPv6") {
		return [
			{ type: "AAAA", name: `${serialNumber}.clamat-device.local`, data: httpsServiceAddressInfo.address }
		];
	}
	if(question.name == `${serialNumber}.clamat-device.local` && question.type == "CERT") {
		return [
			{ type: "CERT", name: `${serialNumber}.clamat-device.local`, data: Buffer.from(deviceCert.rawData) }
		];
	}
	return [];
};

const httpsApp = new Hono<{ Bindings: HttpBindings }>();

for(let i = 0; `DEVICE_INTERFACE_${i}` in process.env; i++) {
	const networkInterface = process.env[`DEVICE_INTERFACE_${i}`]!;
	const [networkIp, networkScope] = networkInterface.split("%");
	const isIpv4 = net.isIPv4(networkIp);
	const getInterfaceIpv4 = () => networkIp != "0.0.0.0" ? networkIp : networkScope != null ? os.networkInterfaces()[networkScope]?.find(a => a.family == "IPv4")?.address : undefined;
	const getInterfaceIpv6 = () => networkIp != "::" ? networkIp : networkScope != null ? os.networkInterfaces()[networkScope]?.find(a => a.family == "IPv6")?.address ??
		Object.values(os.networkInterfaces()).flat().find(a => a?.family == "IPv6" && `${a.scopeid}` == networkScope)?.address : undefined;
	const mdnsSocket = dgram.createSocket({
		type: isIpv4 ? "udp4" : "udp6",
		reuseAddr: true,
		reusePort: true
	});
	const mdnsServiceOptions = {
		type: isIpv4 ? "udp4" : "udp6",
		socket: mdnsSocket,
		interface: isIpv4 ? networkIp == "0.0.0.0" ? getInterfaceIpv4() : networkIp : `${networkIp}${networkScope != null ? `%${networkScope}` : ""}`,
		ip: isIpv4 ? "224.0.0.251" : "ff02::fb",
		port: 5353
	} as makeMdns.Options;
	const mdnsService = makeMdns(mdnsServiceOptions);
	console.log(`MDNS service listening on ${mdnsServiceOptions.interface}${isIpv4 && networkScope != null ? `%${networkScope}` : ""}:${mdnsServiceOptions.port}`);
	let httpsServiceListen: string | null = null;
	let httpsService: https.Server | null = null;
	const updateHttpsService = () => {
		const listen = isIpv4 ? getInterfaceIpv4() : getInterfaceIpv6();
		if(httpsService != null) {
			if(httpsServiceListen == listen)
				return;
			httpsService.closeAllConnections();
			httpsService.close();
		}
		httpsServiceListen = listen ?? null;
		httpsService = serve({
			fetch: httpsApp.fetch,
			createServer: https.createServer,
			serverOptions: {
				ca: derToPem(new Uint8Array(rootCert.rawData), "CERTIFICATE"),
				key: derToPem(deviceKeyDer, "PRIVATE KEY"),
				cert: [deviceCert, ...intermediateCerts].map(cert => derToPem(new Uint8Array(cert.rawData), "CERTIFICATE")).join("\n")
			},
			hostname: listen,
			port: 0
		}, address => {
			console.log(`HTTPS service listening on ${address.address}${networkScope != null ? `%${networkScope}` : ""}:${address.port}`);
		}) as https.Server;
	};
	updateHttpsService();
	if(networkIp == "0.0.0.0") {
		setInterval(() => {
			const interfaceIp = getInterfaceIpv4();
			if(interfaceIp != mdnsServiceOptions.interface) {
				// options is not copied, so we can update them without creating a new one.
				mdnsServiceOptions.interface = interfaceIp;
				(mdnsService as any).update();
				console.log(`MDNS service listening on ${mdnsServiceOptions.interface}${isIpv4 && networkScope != null ? `%${networkScope}` : ""}:${mdnsServiceOptions.port}`);
			}
			updateHttpsService();
		}, 1000 * 5);
	}
	if(networkIp == "::") {
		setInterval(() => {
			updateHttpsService();
		}, 1000 * 5);
	}
	mdnsService.addListener("query", (query, remoteInfo) => {
		const httpsServiceAddress = httpsService?.address();
		if(typeof httpsServiceAddress != "object" || httpsServiceAddress == null)
			return;
		const response = query.questions.map(q => getMdnsResponse(q, httpsServiceAddress)).flat();
		mdnsService.respond(response, remoteInfo);
	});
}

// const httpsServer = https.createServer({ key: deviceKeyPem, cert: deviceCertPem }, httpsApp.fetch);
// httpsServer.listen(() => {
// 	console.log("HTTPS Server listening on");
// });

// const CERT_PATH = process.env.CERTIFICATE_FILE || "";
// const KEY_PATH = process.env.PRIVATE_KEY_FILE || "";
// const INTERVAL_SECONDS = Number(process.env.MDNS_INTERVAL || process.env.MDNS_INTERVAL_SECONDS || 30);
// const SERVICE_NAME = (process.env.SERVICE_NAME || os.hostname()) + ".local";
// const COUNTER_FILE = process.env.COUNTER_FILE || path.join(process.cwd(), "mdns-counter.json");

// const certPem = "";
// let privateKeyPem = "";

// async function loadKeys() {
// 	if(CERT_PATH) deviceCertPem = String(await fs.readFile(CERT_PATH, "utf8"));
// 	if(KEY_PATH) privateKeyPem = String(await fs.readFile(KEY_PATH, "utf8"));
// }

// let counter = 0;
// async function loadCounter() {
// 	try {
// 		const raw = await fs.readFile(COUNTER_FILE, "utf8");
// 		const parsed = JSON.parse(raw);
// 		if(typeof parsed.counter === "number") counter = parsed.counter;
// 	} catch (e) {
// 		counter = 0;
// 	}
// }

// async function saveCounter() {
// 	await fs.writeFile(COUNTER_FILE, JSON.stringify({ counter }), "utf8");
// }

// async function incrementCounter() {
// 	counter++;
// 	await saveCounter();
// 	return counter;
// }

// function signMessage(msg: string) {
// 	if(!privateKeyPem) return "";
// 	const sign = crypto.createSign("SHA256");
// 	sign.update(msg);
// 	sign.end();
// 	return sign.sign(privateKeyPem, "base64");
// }

// async function makeAnswers(ip: string) {
// 	const c = await incrementCounter();
// 	const payload = `${c}.${ip}`;
// 	const signature = signMessage(payload);
// 	const txtValue = `${payload}.${signature}`;

// 	const answers: any[] = [];
// 	if(net.isIPv4(ip))
// 		answers.push({ name: SERVICE_NAME, type: "A", ttl: 120, data: ip });
// 	else if(net.isIPv6(ip))
// 		answers.push({ name: SERVICE_NAME, type: "AAAA", ttl: 120, data: ip });

// 	if(deviceCertPem) {
// 		// include PEM as CERT record data (some resolvers may interpret differently)
// 		answers.push({ name: SERVICE_NAME, type: "CERT", ttl: 120, data: Buffer.from(deviceCertPem, "utf8") });
// 	}

// 	answers.push({ name: SERVICE_NAME, type: "TXT", ttl: 120, data: [txtValue] });
// 	return answers;
// }

// async function respondWithAnswers(svc: MdnsService) {
// 	try {
// 		const answers = await makeAnswers(svc.ip);
// 		svc.mdns.respond({ answers });
// 	} catch (e) {
// 		// ignore
// 	}
// }

// await loadKeys();
// await loadCounter();

// // set up listeners and periodic advertisements
// for(const svc of mdnsServices) {
// 	svc.mdns.on("query", async query => {
// 		try {
// 			// If any question targets our service name (or asks ANY), respond
// 			const wants = (query.questions || []).some((q: any) => {
// 				const qname = String(q.name || "");
// 				const qtype = String(q.type || "");
// 				return qname === SERVICE_NAME || qname === "" || qtype === "ANY";
// 			});
// 			if(wants) await respondWithAnswers(svc);
// 		} catch (e) {
// 			// ignore
// 		}
// 	});

// 	// passive advertisements
// 	setInterval(() => void respondWithAnswers(svc), Math.max(1, INTERVAL_SECONDS) * 1000);

// 	// initial announcement
// 	void respondWithAnswers(svc);
// }

// // expose nothing; module runs with side-effects
