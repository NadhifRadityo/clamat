import crypto from "crypto";
import forge from "node-forge";

export const SERIAL_NUMBER_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const SERIAL_NUMBER_BASE = SERIAL_NUMBER_ALPHABET.length;
export function generateSerialNumberFromPublicKey(publicKey: forge.pki.PublicKey) {
	const asn1 = forge.pki.publicKeyToAsn1(publicKey);
	const derBytes = forge.asn1.toDer(asn1).getBytes();
	const derBuffer = Buffer.from(derBytes, "binary");
	const hash = crypto.createHash("sha256").update(derBuffer).digest();
	const payload = [...hash.subarray(0, 15)].map(v => SERIAL_NUMBER_ALPHABET[v % SERIAL_NUMBER_BASE]).join("");
	const checksum = SERIAL_NUMBER_ALPHABET[crypto.createHash("sha256").update(payload).digest()[0] % SERIAL_NUMBER_BASE];
	return (payload + checksum).match(/.{1,4}/g)!.join("-");
}
export function validateSerialNumber(serialNumber: string) {
	serialNumber = serialNumber.replace(/-/g, "").toUpperCase();
	if(serialNumber.length != 16)
		return false;
	const payload = serialNumber.slice(0, 15);
	const checksum = serialNumber[15];
	const expectedChecksum = SERIAL_NUMBER_ALPHABET[crypto.createHash("sha256").update(payload).digest()[0] % SERIAL_NUMBER_BASE];
	return checksum == expectedChecksum;
}
