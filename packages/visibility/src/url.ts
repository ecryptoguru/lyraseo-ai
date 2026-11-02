/** Stable URL identity for a confirmed same-origin audit manifest. */
export function normalizeUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Enter a valid HTTPS URL.");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error(
      "Only public HTTPS URLs without credentials are supported.",
    );
  }
  if (url.port || url.hostname.length === 0 || input.length > 2048) {
    throw new Error("The URL is unsupported or too long.");
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  // Reject all literal IPs and local suffixes. DNS/redirect isolation is a
  // separate acquisition-layer obligation; this function never fetches a URL.
  if (
    host.includes(":") ||
    /^\d+\.\d+\.\d+\.\d+$/.test(host) ||
    !host.includes(".") ||
    /(^|\.)(localhost|local|internal|invalid|test)$/.test(host)
  ) {
    throw new Error("Only public DNS hostnames are supported.");
  }
  url.hostname = host;
  url.pathname = url.pathname.replace(/%[0-9a-f]{2}/gi, (encoded) => {
    const char = String.fromCharCode(parseInt(encoded.slice(1), 16));
    return /[A-Za-z0-9._~-]/.test(char) ? char : encoded.toUpperCase();
  });
  url.hash = "";
  return url.href;
}

export function sameOrigin(a: string, b: string): boolean {
  return new URL(normalizeUrl(a)).origin === new URL(normalizeUrl(b)).origin;
}
