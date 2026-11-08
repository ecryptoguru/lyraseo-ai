import { publicHttpsTransport } from "./transport";

/** Exact-origin proof files are small and never follow redirects. */
export async function observeSiteProof(
  url: string,
  beforeSocket: () => Promise<void>,
) {
  const signal = AbortSignal.timeout(10000);
  const response = await publicHttpsTransport(url, signal, beforeSocket);
  const reader = response.body?.getReader();
  let body = "",
    size = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    if (reader)
      while (true) {
        signal.throwIfAborted();
        const chunk = await reader.read();
        if (chunk.done) {
          body += decoder.decode();
          break;
        }
        size += chunk.value.byteLength;
        if (size > 256) throw new Error("INVALID_SITE_PROOF");
        body += decoder.decode(chunk.value, { stream: true });
      }
    return { url, status: response.status, body };
  } finally {
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
  }
}
