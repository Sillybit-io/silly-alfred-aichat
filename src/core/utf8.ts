
function continuation(bytes: Uint8Array, index: number, low = 0x80, high = 0xbf): boolean {
  return index < bytes.length && bytes[index]! >= low && bytes[index]! <= high;
}

// Decodes complete bytes as UTF-8 per the WHATWG decoder: each ill-formed
// sequence becomes U+FFFD and decoding resumes at the first byte that cannot
// belong to it. Callers hand over whole lines, so nothing is carried across calls.
export function decodeUtf8(bytes: Uint8Array): string {
  const parts: string[] = [];
  let run: number[] = [];
  const flush = () => {
    if (run.length > 0) {
      parts.push(String.fromCharCode(...run));
      run = [];
    }
  };
  const push = (codePoint: number) => {
    if (codePoint > 0xffff) {
      const offset = codePoint - 0x10000;
      run.push(0xd800 + (offset >> 10), 0xdc00 + (offset & 0x3ff));
    } else {
      run.push(codePoint);
    }
    if (run.length >= 4096) flush();
  };

  let i = 0;
  while (i < bytes.length) {
    const lead = bytes[i]!;
    if (lead < 0x80) {
      push(lead);
      i += 1;
    } else if (lead >= 0xc2 && lead <= 0xdf) {
      if (continuation(bytes, i + 1)) {
        push(((lead & 0x1f) << 6) | (bytes[i + 1]! & 0x3f));
        i += 2;
      } else {
        push(0xfffd);
        i += 1;
      }
    } else if (lead >= 0xe0 && lead <= 0xef) {
      const low = lead === 0xe0 ? 0xa0 : 0x80;
      const high = lead === 0xed ? 0x9f : 0xbf;
      if (!continuation(bytes, i + 1, low, high)) {
        push(0xfffd);
        i += 1;
      } else if (!continuation(bytes, i + 2)) {
        push(0xfffd);
        i += 2;
      } else {
        push(((lead & 0x0f) << 12) | ((bytes[i + 1]! & 0x3f) << 6) | (bytes[i + 2]! & 0x3f));
        i += 3;
      }
    } else if (lead >= 0xf0 && lead <= 0xf4) {
      const low = lead === 0xf0 ? 0x90 : 0x80;
      const high = lead === 0xf4 ? 0x8f : 0xbf;
      if (!continuation(bytes, i + 1, low, high)) {
        push(0xfffd);
        i += 1;
      } else if (!continuation(bytes, i + 2)) {
        push(0xfffd);
        i += 2;
      } else if (!continuation(bytes, i + 3)) {
        push(0xfffd);
        i += 3;
      } else {
        push(
          ((lead & 0x07) << 18) |
            ((bytes[i + 1]! & 0x3f) << 12) |
            ((bytes[i + 2]! & 0x3f) << 6) |
            (bytes[i + 3]! & 0x3f),
        );
        i += 4;
      }
    } else {
      push(0xfffd);
      i += 1;
    }
  }
  flush();
  return parts.join("");
}

