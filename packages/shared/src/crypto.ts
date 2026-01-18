export * as nodecrypto from "crypto";
export const webcrypto = globalThis.crypto;
export * as asn1schema from "@peculiar/asn1-schema";
export * as asn1rsa from "@peculiar/asn1-rsa";
export * as asn1x509 from "@peculiar/asn1-x509";
export * as asn1csr from "@peculiar/asn1-csr";
export * as x509 from "@peculiar/x509";

import * as nodecrypto from "crypto";

export function derToPem(der: Uint8Array, label: string): string {
	const lines = der.toBase64().match(/.{1,64}/g)!.join("\n");
	return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----\n`;
}

export const SERIAL_NUMBER_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const SERIAL_NUMBER_BASE = SERIAL_NUMBER_ALPHABET.length;
export async function serialNumberFromPublicKey(publicKey: CryptoKey) {
	if(publicKey.type != "public")
		throw new Error("The key provided is not a public key");
	const derBuffer = new Uint8Array(await webcrypto.subtle.exportKey("spki", publicKey));
	const hash = nodecrypto.createHash("sha256").update(derBuffer).digest();
	const payload = [...hash.subarray(0, 15)].map(v => SERIAL_NUMBER_ALPHABET[v % SERIAL_NUMBER_BASE]).join("");
	const checksum = SERIAL_NUMBER_ALPHABET[nodecrypto.createHash("sha256").update(payload).digest()[0] % SERIAL_NUMBER_BASE];
	return payload + checksum;
}
export function serialNumberReformat(serialNumber: string) {
	return serialNumber.match(/.{1,4}/g)!.join("-");
}
export async function serialNumberValidate(serialNumber: string) {
	serialNumber = serialNumber.replace(/-/g, "").toUpperCase();
	if(serialNumber.length != 16)
		return false;
	const payload = serialNumber.slice(0, 15);
	const checksum = serialNumber[15];
	const expectedChecksum = SERIAL_NUMBER_ALPHABET[nodecrypto.createHash("sha256").update(payload).digest()[0] % SERIAL_NUMBER_BASE];
	return checksum == expectedChecksum;
}
export async function encryptionKeyFromPrivateKey(privateKey: CryptoKey, usage: string | Uint8Array<ArrayBuffer>) {
	if(privateKey.type != "public")
		throw new Error("The key provided is not a public key");
	if(typeof usage == "string")
		usage = new TextEncoder().encode(usage);
	const signature = new Uint8Array(await webcrypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, usage));
	const hash = nodecrypto.createHash("sha256").update(signature).digest();
	return hash.toString("base64url");
}
