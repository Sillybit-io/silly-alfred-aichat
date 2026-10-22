const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const LOOKUP: number[] = (() => {
  const table: number[] = new Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) table[ALPHABET.charCodeAt(i)] = i;
  return table;
})();

export function encodeBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    const chunk = (a << 16) | (b << 8) | c;
    parts.push(
      ALPHABET[(chunk >> 18) & 63]! +
        ALPHABET[(chunk >> 12) & 63]! +
        (i + 1 < bytes.length ? ALPHABET[(chunk >> 6) & 63]! : "=") +
        (i + 2 < bytes.length ? ALPHABET[chunk & 63]! : "="),
    );
  }
  return parts.join("");
}

export function decodeBase64(text: string): Uint8Array {
  const symbols: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 61) break;
    if (code === 10 || code === 13 || code === 32 || code === 9) continue;
    const value = code < 128 ? LOOKUP[code]! : -1;
    if (value < 0) throw new Error(`invalid base64 character at ${i}`);
    symbols.push(value);
  }
  if (symbols.length % 4 === 1) throw new Error("invalid base64 length");
  const out = new Uint8Array(Math.floor((symbols.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < symbols.length; i += 4) {
    const s0 = symbols[i]!;
    const s1 = symbols[i + 1]!;
    const s2 = i + 2 < symbols.length ? symbols[i + 2]! : 0;
    const s3 = i + 3 < symbols.length ? symbols[i + 3]! : 0;
    const chunk = (s0 << 18) | (s1 << 12) | (s2 << 6) | s3;
    if (o < out.length) out[o++] = (chunk >> 16) & 255;
    if (o < out.length) out[o++] = (chunk >> 8) & 255;
    if (o < out.length) out[o++] = chunk & 255;
  }
  return out;
}
