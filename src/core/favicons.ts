// Pure helpers for the sources row: which domains are safe to look up, and what a downloaded icon must look like.

export function domainOf(url: string): string | null {
  const match = /^https?:\/\/([^/:?#\s]+)/i.exec(url.trim());
  if (!match) return null;
  const host = match[1]!.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  return isSafeDomain(host) ? host : null;
}

// A public DNS name only: no IP address, no single-label host, nothing local or internal.
export function isSafeDomain(host: string): boolean {
  if (host.length < 4 || host.length > 253) return false;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) return false;
  if (/^\d+(\.\d+)*$/.test(host) || /^[0-9]+$/.test(host.slice(host.lastIndexOf(".") + 1))) return false;
  const last = host.slice(host.lastIndexOf(".") + 1);
  if (["local", "localhost", "internal", "lan", "home", "corp", "intranet", "test", "invalid", "example"].indexOf(last) >= 0) return false;
  return true;
}

export const MAX_ICON_BYTES = 64 * 1024;

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return bytes.length >= signature.length && signature.every((value, i) => bytes[i] === value);
}

// Only raster icon formats pass; SVG, HTML, and anything else is rejected before any tool reads it.
export function isRasterIcon(bytes: Uint8Array): boolean {
  if (bytes.length === 0 || bytes.length > MAX_ICON_BYTES) return false;
  return (
    startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) ||
    startsWith(bytes, [0x00, 0x00, 0x01, 0x00]) ||
    startsWith(bytes, [0x47, 0x49, 0x46, 0x38]) ||
    startsWith(bytes, [0xff, 0xd8, 0xff])
  );
}

export type SourceLink = { url: string; title: string };

export type SourcesStyle = {
  cap: number;
  // Show each site's icon before its link. Alfred cannot put an image inside a link, so the icon is not itself a link.
  icons: boolean;
  // The local icon file for a domain, or null while it is missing.
  icon(domain: string): string | null;
};

function labelOf(url: string): string {
  const domain = domainOf(url);
  const host = domain ?? (/^https?:\/\/([^/?#]+)/i.exec(url)?.[1] ?? "link");
  return host.replace(/([\\_*`\[\]])/g, "\\$1");
}

// One paragraph: a short link per site (first link of each), with the site icon before it when asked for.
export function sourcesRow(sources: SourceLink[], style: SourcesStyle): string {
  const seen = new Set<string>();
  const unique = sources.filter((source) => {
    const key = labelOf(source.url);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const shown = unique.slice(0, style.cap);
  const links = shown.map((source) => {
    const domain = domainOf(source.url);
    const icon = style.icons && domain !== null ? style.icon(domain) : null;
    const link = `[${labelOf(source.url)}](${source.url.replace(/\s/g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29")})`;
    return icon === null ? link : `![](${icon}) ${link}`;
  });
  const more = unique.length > shown.length ? `  ·  +${unique.length - shown.length} more with \`/sources\`` : "";
  return `**Sources**  ${links.join("  ·  ")}${more}`;
}
