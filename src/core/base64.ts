const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const PAD = 61;
const CHUNK = 8190;

const CODES = Uint8Array.from(ALPHABET, (c) => c.charCodeAt(0));

const LOOKUP: Int8Array = (() => {
  const table = new Int8Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) table[ALPHABET.charCodeAt(i)] = i;
  return table;
})();

// Text built from byte values in slices, so a large file never becomes millions of small strings.
function ascii(codes: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < codes.length; i += CHUNK) parts.push(String.fromCharCode.apply(null, codes.subarray(i, i + CHUNK) as unknown as number[]));
  return parts.join("");
}

export function encodeBase64(bytes: Uint8Array): string {
  const out = new Uint8Array(Math.ceil(bytes.length / 3) * 4);
  let o = 0;
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const chunk = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out[o++] = CODES[(chunk >> 18) & 63]!;
    out[o++] = CODES[(chunk >> 12) & 63]!;
    out[o++] = CODES[(chunk >> 6) & 63]!;
    out[o++] = CODES[chunk & 63]!;
  }
  const rest = bytes.length - i;
  if (rest > 0) {
    const chunk = (bytes[i]! << 16) | (rest > 1 ? bytes[i + 1]! << 8 : 0);
    out[o++] = CODES[(chunk >> 18) & 63]!;
    out[o++] = CODES[(chunk >> 12) & 63]!;
    out[o++] = rest > 1 ? CODES[(chunk >> 6) & 63]! : PAD;
    out[o++] = PAD;
  }
  return ascii(out);
}

export function decodeBase64(text: string): Uint8Array {
  const symbols = new Uint8Array(text.length);
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === PAD) break;
    if (code === 10 || code === 13 || code === 32 || code === 9) continue;
    const value = code < 128 ? LOOKUP[code]! : -1;
    if (value < 0) throw new Error(`invalid base64 character at ${i}`);
    symbols[n++] = value;
  }
  if (n % 4 === 1) throw new Error("invalid base64 length");
  const out = new Uint8Array(Math.floor((n * 3) / 4));
  let o = 0;
  for (let i = 0; i < n; i += 4) {
    const chunk = (symbols[i]! << 18) | (symbols[i + 1]! << 12) | ((i + 2 < n ? symbols[i + 2]! : 0) << 6) | (i + 3 < n ? symbols[i + 3]! : 0);
    if (o < out.length) out[o++] = (chunk >> 16) & 255;
    if (o < out.length) out[o++] = (chunk >> 8) & 255;
    if (o < out.length) out[o++] = chunk & 255;
  }
  return out;
}
