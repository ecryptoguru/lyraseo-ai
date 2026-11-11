import { parseDocument, DomUtils } from "htmlparser2";
import { normalizeUrl } from "./url";
import {
  googleRobotsGroup,
  parseRobotsPolicy,
  replayGoogleRobots,
} from "./robots-source";
export { replayGoogleRobots } from "./robots-source";
import type { PageEvidence, RobotsPolicyObservation } from "./types";

export const CRAWLER_AGENT = "LyraseoAudit/1.0";
/** Keep the raw anchor cap in UTF-16 units without splitting an astral code point. */
export function boundedRawAnchorText(value: string): string {
  const bounded = value.slice(0, 500);
  return /[\uD800-\uDBFF]$/.test(bounded) ? bounded.slice(0, -1) : bounded;
}

const HTML_LIMIT = 5 * 1024 * 1024;
const POLICY_LIMIT = 2 * 1024 * 1024;
/** Supplied by a trusted runtime adapter with network-level public-address isolation. */
export type PublicTransport = (
  url: string,
  signal: AbortSignal,
) => Promise<Response>;
export interface AcquisitionReceipt {
  evidence: PageEvidence;
  provenance: {
    channel: "raw-http";
    robotsPolicy: RobotsPolicyObservation;
    requestedUrl: string;
    finalUrl?: string;
    status?: number;
    acquiredAt: string;
    headers: Record<string, string>;
    redirects: string[];
    rawHtml?: string;
    sha256?: string;
    error?: string;
  };
}

// Ephemeral original response bodies never enter JSON, queues or legacy checkpoints.
const observedBodies = new WeakMap<AcquisitionReceipt, Uint8Array>();
const receiptDigests = new WeakMap<AcquisitionReceipt, string>();
export function receiptAttestation(receipt: AcquisitionReceipt) {
  return receiptDigests.get(receipt);
}
export function receiptFacts(receipt: AcquisitionReceipt) {
  return JSON.stringify({
    evidence: receipt.evidence,
    provenance: { ...receipt.provenance, rawHtml: undefined },
  });
}
const observedReceipts = new WeakSet<AcquisitionReceipt>();
export function isOriginalObservation(receipt: AcquisitionReceipt) {
  return observedReceipts.has(receipt);
}
async function sealReceipt(receipt: AcquisitionReceipt) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(receiptFacts(receipt)),
  );
  receiptDigests.set(
    receipt,
    Array.from(new Uint8Array(digest), (v) =>
      v.toString(16).padStart(2, "0"),
    ).join(""),
  );
  return receipt;
}
export function originalBody(receipt: AcquisitionReceipt) {
  return observedBodies.get(receipt);
}

export function unavailablePage(requestedUrl: string): PageEvidence {
  return {
    requestedUrl,
    acquired: false,
    headComplete: false,
    bodyComplete: false,
    titleElements: [],
    headingLevels: [],
    h1Texts: [],
    canonicalUrls: [],
    linkNames: [],
    jsonLd: [],
  };
}

/** Streaming bound applies to decoded response bytes, independent of Content-Length. */
async function boundedBytes(
  response: Response,
  maximum: number,
  signal: AbortSignal,
) {
  // The pinned transport requests identity encoding and records original bytes.
  // Parsing an unexpected encoded response would mislabel it as original HTML.
  const encoding = response.headers.get("content-encoding");
  if (encoding && encoding.trim().toLowerCase() !== "identity") {
    await response.body?.cancel();
    throw new Error("UNSUPPORTED_CONTENT_ENCODING");
  }
  if (Number(response.headers.get("content-length")) > maximum) {
    await response.body?.cancel();
    throw new Error("BODY_TOO_LARGE");
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  let total = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximum) throw new Error("BODY_TOO_LARGE");
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function requestSameOrigin(
  url: string,
  origin: string,
  transport: PublicTransport,
  signal: AbortSignal,
  onRedirect?: (redirects: string[]) => void,
) {
  let current = normalizeUrl(url);
  const redirects: string[] = [];
  for (let hop = 0; hop <= 5; hop++) {
    signal.throwIfAborted();
    if (new URL(current).origin !== origin)
      throw new Error("REDIRECT_OUTSIDE_ORIGIN");
    const response = await transport(current, signal);
    // A runtime adapter must disable automatic redirect following.
    if (
      response.redirected ||
      (response.url && normalizeUrl(response.url) !== current)
    ) {
      await response.body?.cancel();
      throw new Error("UNSAFE_TRANSPORT_REDIRECT");
    }
    if (![301, 302, 303, 307, 308].includes(response.status))
      return { response, finalUrl: current, redirects };
    const location = response.headers.get("location");
    if (!location) return { response, finalUrl: current, redirects };
    await response.body?.cancel();
    if (hop === 5) throw new Error("REDIRECT_LIMIT");
    // Keep the observed, authorized hops even when the next destination is
    // blocked or malformed. Never claim an unrequested target as the final URL.
    const observed = [...redirects, current];
    onRedirect?.(observed);
    let next: string;
    try {
      const target = new URL(location, current);
      if (target.origin !== origin) throw new Error("REDIRECT_OUTSIDE_ORIGIN");
      next = normalizeUrl(target.href);
    } catch (error) {
      if (error instanceof Error && error.message === "REDIRECT_OUTSIDE_ORIGIN")
        throw error;
      throw new Error("REDIRECT_INVALID_LOCATION");
    }
    if (next === current || redirects.includes(next))
      throw new Error("REDIRECT_LOOP");
    redirects.push(current);
    current = next;
  }
  throw new Error("REDIRECT_LIMIT");
}

function headerMetadata(headers: Headers, finalUrl: string) {
  const headerDirectives = headers.get("x-robots-tag")?.split(",") ?? [];
  let agent = "*";
  const taggedHeaders = headerDirectives.map((value) => {
    const scoped = /^\s*([\w-]+)\s*:\s*(.*)$/.exec(value);
    if (
      scoped &&
      ![
        "max-snippet",
        "max-image-preview",
        "max-video-preview",
        "unavailable_after",
      ].includes(scoped[1]!.toLowerCase())
    ) {
      agent = scoped[1]!.toLowerCase();
      return { agent, value: scoped[2]!.trim() };
    }
    return { agent, value: value.trim() };
  });
  const httpCanonicals = Array.from(
    (headers.get("link") ?? "").matchAll(/<([^>]+)>((?:[^<,]|"[^"]*")*)/g),
  ).flatMap((match) => {
    const rel = /(?:^|;)\s*rel\s*=\s*(?:"([^"]*)"|([^;\s]+))/i.exec(
      match[2] ?? "",
    );
    if (
      !(rel?.[1] ?? rel?.[2] ?? "")
        .toLowerCase()
        .split(/\s+/)
        .includes("canonical")
    )
      return [];
    try {
      return [new URL(match[1]!, finalUrl).href];
    } catch {
      return [match[1]!];
    }
  });
  return {
    directivesComplete: true,
    canonicalsComplete: true,
    directives: taggedHeaders,
    canonicalUrls: httpCanonicals,
  };
}

/** Original HTML is retained separately. Rendered visibility remains unavailable. */
export function extractRawHtml(
  html: string,
  requestedUrl: string,
  finalUrl: string,
  headers: Headers,
): PageEvidence {
  const document = parseDocument(html);
  const elements = DomUtils.findAll(
    (node) => node.type === "tag" || node.type === "script",
    document.children,
  );
  const eligible = (node: (typeof elements)[number], inHead = false) => {
    let parent = node.parent;
    let head = false;
    while (parent) {
      if ("name" in parent) {
        if (["template", "svg", "math", "noscript"].includes(parent.name))
          return false;
        if (parent.name === "head") head = true;
      }
      parent = parent.parent;
    }
    return !inHead || head;
  };
  const titles = elements.filter(
    (node) => node.name === "title" && eligible(node, true),
  );
  const canonicals = elements.filter(
    (node) =>
      node.name === "link" &&
      eligible(node, true) &&
      node.attribs.rel?.toLowerCase().split(/\s+/).includes("canonical"),
  );
  const base = elements.find(
    (node) => node.name === "base" && eligible(node, true) && node.attribs.href,
  );
  let baseUrl = finalUrl;
  try {
    if (base) baseUrl = new URL(base.attribs.href!, finalUrl).href;
  } catch {
    /* invalid base ignored */
  }
  const resolve = (value: string) => {
    try {
      return new URL(value, baseUrl).href;
    } catch {
      return value;
    }
  };
  const noindex = elements.some(
    (node) =>
      node.name === "meta" &&
      eligible(node, true) &&
      ["robots", "googlebot"].includes(
        node.attribs.name?.toLowerCase() ?? "",
      ) &&
      /(?:^|[\s,])(noindex|none)(?:$|[\s,])/i.test(node.attribs.content ?? ""),
  );
  const headerDirectives = headers.get("x-robots-tag")?.split(",") ?? [];
  let applies = true;
  const headerNoindex = headerDirectives.some((directive) => {
    const scoped = /^\s*([\w-]+)\s*:\s*(.*)$/.exec(directive);
    if (scoped) applies = scoped[1]?.toLowerCase() === "googlebot";
    return (
      applies &&
      /(?:^|\s)(noindex|none)(?:$|\s)/i.test(scoped?.[2] ?? directive.trim())
    );
  });
  const taggedMeta = elements
    .filter(
      (node) =>
        node.name === "meta" &&
        eligible(node, true) &&
        node.attribs.name &&
        node.attribs.content &&
        /^(robots|googlebot(?:-[\w-]+)?|[\w-]*(?:bot|crawler)|gptbot|google-extended)$/i.test(
          node.attribs.name,
        ),
    )
    .map((node) => ({
      agent: node.attribs.name!.toLowerCase(),
      value: node.attribs.content!,
    }));
  const headerSource = headerMetadata(headers, finalUrl);
  const httpCanonicals = headerSource.canonicalUrls;
  const links = elements
    .filter((node) => node.name === "a" && eligible(node) && node.attribs.href)
    .slice(0, 100)
    .flatMap((node) => {
      try {
        const target = new URL(node.attribs.href!, baseUrl);
        if (
          target.origin !== new URL(finalUrl).origin ||
          target.href.length > 2048
        )
          return [];
        target.hash = "";
        const rawText = (n: (typeof document.children)[number]): string => {
          if (n.type === "text") return n.data;
          if (
            "name" in n &&
            ["script", "style", "template", "svg", "noscript"].includes(n.name)
          )
            return "";
          return "children" in n ? n.children.map(rawText).join("") : "";
        };
        return [
          {
            href: target.href,
            name: boundedRawAnchorText(
              node.children.map(rawText).join("").replace(/\s+/g, " ").trim(),
            ),
          },
        ];
      } catch {
        return [];
      }
    });
  return {
    ...unavailablePage(requestedUrl),
    finalUrl,
    acquired: true,
    // Header and original markup are observed independently. Rendered metadata
    // and computed visibility are unavailable in the raw HTTP profile.
    metadata: {
      headers: headerSource,
      original: {
        directivesComplete: true,
        canonicalsComplete: true,
        directives: taggedMeta,
        canonicalUrls: canonicals.map((node) => {
          const value = node.attribs.href;
          return value?.trim() ? resolve(value) : "";
        }),
      },
    },
    jsonLdComplete: false,
    headComplete: false,
    bodyComplete: false,
    titleElements: titles.map((node) => DomUtils.textContent(node)),
    canonicalUrls: [
      ...canonicals.map((node) => resolve(node.attribs.href ?? "")),
      ...httpCanonicals,
    ],
    linkNames: links,
    explicitNoindex: noindex || headerNoindex,
    jsonLd: elements
      .filter(
        (node) =>
          node.name === "script" &&
          eligible(node) &&
          node.attribs.type?.toLowerCase() === "application/ld+json",
      )
      .map((node) => DomUtils.textContent(node)),
  };
}

export async function acquireRawPage(
  requestedUrl: string,
  siteOrigin: string,
  transport: PublicTransport,
  outer?: AbortSignal,
): Promise<AcquisitionReceipt> {
  const requested = normalizeUrl(requestedUrl),
    origin = new URL(normalizeUrl(siteOrigin)).origin;
  if (new URL(requested).origin !== origin)
    throw new Error("OUTSIDE_MANIFEST_ORIGIN");
  const policyUrl = `${origin}/robots.txt`;
  const policySource: RobotsPolicyObservation = {
    requestedUrl: policyUrl,
    acquiredAt: new Date().toISOString(),
    state: "unavailable",
  };
  const receipt: AcquisitionReceipt = {
    evidence: unavailablePage(requested),
    provenance: {
      channel: "raw-http",
      robotsPolicy: policySource,
      requestedUrl: requested,
      acquiredAt: new Date().toISOString(),
      headers: {},
      redirects: [],
    },
  };
  const deadline = AbortSignal.timeout(15000);
  const signal = outer ? AbortSignal.any([outer, deadline]) : deadline;
  signal.throwIfAborted();
  try {
    const policy = await requestSameOrigin(
      policyUrl,
      origin,
      transport,
      signal,
    );
    policySource.finalUrl = policy.finalUrl;
    policySource.status = policy.response.status;
    policySource.acquiredAt = new Date().toISOString();
    let robotsText = "";
    if (policy.response.status === 404 || policy.response.status === 410) {
      policySource.state = "no-file";
      await policy.response.body?.cancel();
    } else if (policy.response.ok) {
      policySource.state = "indeterminate";
      const bytes = await boundedBytes(policy.response, POLICY_LIMIT, signal);
      policySource.sha256 = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("");
      try {
        robotsText = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new Error("ROBOTS_INDETERMINATE");
      }
    } else {
      await policy.response.body?.cancel();
      throw new Error("ROBOTS_UNAVAILABLE");
    }
    // Ignore comments/extension records. A broken policy response cannot
    // establish permission. Decode only unreserved characters for path matching.
    const lines = robotsText
      .split(/\r\n?|\n/)
      .map((line) => line.split("#")[0]!.trim())
      .filter(Boolean);
    if (
      lines.some(
        (line) =>
          !/^[-\w]+\s*:/.test(line) ||
          /^(allow|disallow)\s*:\s*(?!$)[^/\s*]/i.test(line) ||
          /^(allow|disallow)\s*:.*%(?![a-f\d]{2})/i.test(line),
      )
    )
      throw new Error("ROBOTS_INDETERMINATE");
    const robots = parseRobotsPolicy(policyUrl, robotsText);
    const projected = googleRobotsGroup(robotsText);
    if (projected.complete) {
      policySource.googleGroup = projected.group;
      if (policySource.state !== "no-file") policySource.state = "available";
    } else policySource.state = "evidence-limited";
    const observeGoogle = (url: string, point: "requested" | "final") => {
      const allowed = robots.isAllowed(url, "Googlebot");
      policySource[point] = { url, allowed };
      if (policySource.state === "evidence-limited") return undefined;
      if (replayGoogleRobots(policySource, url) !== allowed) {
        policySource.state = "indeterminate";
        delete receipt.evidence.requestedRobotsGoogleAllowed;
        delete policySource.googleGroup;
        return undefined;
      }
      return allowed;
    };
    receipt.evidence.requestedRobotsGoogleAllowed = observeGoogle(
      requested,
      "requested",
    );
    if (robots.isAllowed(requested, CRAWLER_AGENT) === false)
      throw new Error("ROBOTS_DISALLOWED");
    const page = await requestSameOrigin(
      requested,
      origin,
      async (url, abort) => {
        if (robots.isAllowed(url, CRAWLER_AGENT) === false)
          throw new Error("ROBOTS_DISALLOWED");
        return transport(url, abort);
      },
      signal,
      (redirects) => {
        receipt.provenance.redirects = redirects;
      },
    );
    const { response, finalUrl, redirects } = page;
    receipt.evidence.robotsGoogleAllowed = observeGoogle(finalUrl, "final");
    receipt.evidence.finalUrl = finalUrl;
    receipt.evidence.status = response.status;
    receipt.evidence.contentType =
      response.headers.get("content-type") ?? undefined;
    receipt.provenance.finalUrl = finalUrl;
    receipt.provenance.status = response.status;
    receipt.provenance.redirects = redirects;
    for (const name of [
      "content-type",
      "x-robots-tag",
      "link",
      "last-modified",
    ]) {
      const value = response.headers.get(name);
      if (value) receipt.provenance.headers[name] = value;
    }
    const headerSource = headerMetadata(response.headers, finalUrl);
    if (
      new TextEncoder().encode(JSON.stringify(headerSource)).byteLength > 240000
    )
      throw new Error("EVIDENCE_TOO_LARGE");
    receipt.evidence.metadata = { headers: headerSource };
    if (!response.ok && !(response.status >= 300 && response.status < 400)) {
      await response.body?.cancel();
      throw new Error("HTTP_ERROR");
    }
    if (
      !/^text\/html(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")
    ) {
      await response.body?.cancel();
      throw new Error("UNSUPPORTED_CONTENT_TYPE");
    }
    const bytes = await boundedBytes(response, HTML_LIMIT, signal);
    observedBodies.set(receipt, bytes);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    receipt.provenance.sha256 = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    // Preserve every accepted UTF-8 byte when the source is re-encoded
    // for persistence. HTML parsing consumes a leading BOM as a signature.
    let source: string;
    try {
      source = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(bytes);
    } catch {
      throw new Error("BODY_INVALID_UTF8");
    }
    const html = source.startsWith("\uFEFF") ? source.slice(1) : source;
    // JSONB cannot represent NUL. Keep the original byte digest and an explicit
    // unreadable receipt, never a silently altered copy of the hashed source.
    if (html.includes("\u0000")) throw new Error("BODY_UNREPRESENTABLE");
    if (html.length === 0) throw new Error("EMPTY_HTML_BODY");
    receipt.provenance.rawHtml = source;
    const evidence = {
      ...extractRawHtml(html, requested, finalUrl, response.headers),
      status: response.status,
      contentType: response.headers.get("content-type")!,
      requestedRobotsGoogleAllowed:
        receipt.evidence.requestedRobotsGoogleAllowed,
      robotsGoogleAllowed: receipt.evidence.robotsGoogleAllowed,
    };
    if (new TextEncoder().encode(JSON.stringify(evidence)).byteLength > 262144)
      throw new Error("EVIDENCE_TOO_LARGE");
    receipt.evidence = evidence;
  } catch (error) {
    outer?.throwIfAborted();
    const code =
      deadline.aborted ||
      (error instanceof Error && error.name === "TimeoutError")
        ? "ACQUISITION_TIMEOUT"
        : error instanceof Error
          ? error.message
          : "ACQUISITION_FAILED";
    receipt.provenance.error =
      /^(ACQUISITION_TIMEOUT|EMPTY_HTML_BODY|BODY_INVALID_UTF8|BODY_UNREPRESENTABLE|BODY_TOO_LARGE|EVIDENCE_TOO_LARGE|REDIRECT_\w+|ROBOTS_\w+|HTTP_ERROR|UNSUPPORTED_CONTENT_TYPE|UNSUPPORTED_CONTENT_ENCODING|UNSAFE_TRANSPORT_REDIRECT|DESTINATION_BLOCKED)$/.test(
        code,
      )
        ? code
        : "ACQUISITION_FAILED";
  }
  outer?.throwIfAborted();
  observedReceipts.add(receipt);
  return sealReceipt(receipt);
}

/** Reconstruct the observed receipt for an existing reservation without a transport or a new clock. */
export async function restoreOriginalReceipt(
  provenance: AcquisitionReceipt["provenance"],
  bytes: Uint8Array,
): Promise<AcquisitionReceipt> {
  const { requestedUrl, finalUrl, status, headers, robotsPolicy } = provenance;
  if (
    !finalUrl ||
    !status ||
    !headers["content-type"] ||
    bytes.length > HTML_LIMIT
  )
    throw Error("INVALID_PAGE_EVIDENCE");
  const raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
    bytes,
  );
  if (!raw || raw.includes("\0")) throw Error("INVALID_PAGE_EVIDENCE");
  const receipt = {
    evidence: {
      ...extractRawHtml(
        raw.replace(/^\uFEFF/, ""),
        requestedUrl,
        finalUrl,
        new Headers(headers),
      ),
      status,
      contentType: headers["content-type"],
      requestedRobotsGoogleAllowed: replayGoogleRobots(
        robotsPolicy,
        requestedUrl,
      ),
      robotsGoogleAllowed: replayGoogleRobots(robotsPolicy, finalUrl),
    },
    provenance: { ...provenance, rawHtml: raw },
  };
  observedBodies.set(receipt, bytes);
  return sealReceipt(receipt);
}

/** Rehydrated receipts can replay an already authenticated slot, never establish a new observation. */
export async function restoreUnavailableReceipt(receipt: AcquisitionReceipt) {
  if (
    receipt.evidence.acquired !== false ||
    receipt.provenance.rawHtml !== undefined
  )
    throw Error("INVALID_PAGE_EVIDENCE");
  return sealReceipt(receipt);
}
/** One server-selected page, one observed receipt and one fixed storage
 * adapter. Both browser and bridge provide their already-authorized transition. */
export async function runAuditPage<T>(
  url: string,
  origin: string,
  transport: PublicTransport,
  persist: (receipt: AcquisitionReceipt) => Promise<T>,
  signal?: AbortSignal,
) {
  const receipt = await acquireRawPage(url, origin, transport, signal);
  signal?.throwIfAborted();
  return persist(receipt);
}

/**
 * Discover a bounded candidate list from the homepage, without following any
 * suggested page. This is transient discovery evidence, not an audit result.
 */
export async function discoverCandidates(
  siteOrigin: string,
  transport: PublicTransport,
  assertAccess: () => Promise<void>,
  signal?: AbortSignal,
) {
  const origin = new URL(normalizeUrl(siteOrigin)).origin;
  const homepage = normalizeUrl(`${origin}/`);
  let accessError: unknown;
  const check = async () => {
    try {
      await assertAccess();
    } catch (error) {
      accessError = error;
      throw error;
    }
  };
  await check();
  const receipt = await acquireRawPage(
    homepage,
    origin,
    async (url, abort) => {
      await check();
      return transport(url, abort);
    },
    signal,
  );
  if (accessError !== undefined) throw accessError;
  await check();
  if (!receipt.evidence.acquired)
    return {
      candidates: [homepage],
      state: "unavailable" as const,
      sourceUrl: homepage,
      truncated: false,
      error: receipt.provenance.error ?? "ACQUISITION_FAILED",
    };
  const pages = new Set([homepage]);
  let truncated = false;
  for (const link of receipt.evidence.linkNames) {
    try {
      const url = normalizeUrl(link.href);
      if (new URL(url).origin !== origin || pages.has(url)) continue;
      if (pages.size === 25) {
        truncated = true;
        break;
      }
      pages.add(url);
    } catch {
      // Invalid, non-HTTPS, credentialed, or unsupported links are not candidates.
    }
  }
  return {
    candidates: [...pages],
    state: "available" as const,
    sourceUrl: receipt.provenance.finalUrl ?? homepage,
    truncated,
  };
}
