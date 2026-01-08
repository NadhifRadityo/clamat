import crypto from "crypto";
import forge from "node-forge";

export function generateSerialNumberFromPublicKey(publicKey: forge.pki.PublicKey) {
	const asn1 = forge.pki.publicKeyToAsn1(publicKey);
	const derBytes = forge.asn1.toDer(asn1).getBytes();
	const derBuffer = Buffer.from(derBytes, "binary");
	const hash = crypto.createHash("sha256").update(derBuffer).digest();
	const payload = hash.subarray(0, 17);
	const checksum = crypto.createHash("sha256").update(payload).digest().subarray(0, 1);
	return Buffer.concat([payload, checksum]);
}
export function validateSerialNumber(serialNumber: Buffer) {
	const payload = serialNumber.subarray(0, 17);
	const checksum = serialNumber.subarray(17, 18);
	const expectedChecksum = crypto.createHash("sha256").update(payload).digest().subarray(0, 1);
	return checksum.equals(expectedChecksum);
}
