// getRandomValues, not randomUUID: the latter is undefined in insecure contexts (live-reload on a LAN IP), and WKWebView rejects a polyfill on the readonly Crypto.

const HEX = "0123456789abcdef";

/** Random v4 UUID. */
export function newId(): string {
	const b = new Uint8Array(16);
	crypto.getRandomValues(b);
	b[6] = (b[6] & 0x0f) | 0x40; // version 4
	b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
	let out = "";
	for (let i = 0; i < 16; i++) {
		if (i === 4 || i === 6 || i === 8 || i === 10) out += "-";
		out += HEX[(b[i] >> 4) & 0x0f] + HEX[b[i] & 0x0f];
	}
	return out;
}
