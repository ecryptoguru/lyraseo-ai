import { z } from "zod";
import robotsParser from "robots-parser";
import type {
  GoogleRobotsGroup,
  RobotsPolicyObservation,
  PageEvidence,
} from "./types";

// Archive the effective Google group only. Never persist the policy body,
// comments, unrelated agents or an unbounded set of rules in a page receipt.
const ruleLimit = 128;
const groupBytes = 8192;
type Candidate = { group: GoogleRobotsGroup; complete: boolean; bytes: number };
export function googleRobotsGroup(policy: string): {
  complete: boolean;
  group: GoogleRobotsGroup | null;
} {
  const groups = new Map<string, Candidate>();
  let agents = new Set<string>(),
    lastWasAgent = false;
  for (const line of policy.split(/\r\n?|\n/)) {
    const record = line.split("#", 1)[0]!.trim();
    const colon = record.indexOf(":");
    if (colon <= 0) continue;
    const field = record.slice(0, colon).trim().toLowerCase();
    const value = record.slice(colon + 1).trim();
    if (field === "user-agent") {
      if (!lastWasAgent) agents = new Set();
      const agent = value.split("/")[0]!.trim().toLowerCase();
      if (agent === "googlebot" || agent === "*") agents.add(agent);
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    // robots-parser creates an agent group for these records, including
    // empty Disallow and Crawl-delay. Crawl delay is not a D04 access rule.
    if (field !== "allow" && field !== "disallow" && field !== "crawl-delay")
      continue;
    for (const agent of agents) {
      let candidate = groups.get(agent);
      if (!candidate) {
        candidate = {
          group: { agent: agent as GoogleRobotsGroup["agent"], rules: [] },
          complete: true,
          bytes: 32,
        };
        groups.set(agent, candidate);
      }
      if (!candidate.complete || field === "crawl-delay" || !value) continue;
      candidate.bytes +=
        new TextEncoder().encode(
          JSON.stringify({ directive: field, pattern: value }),
        ).byteLength + 1;
      if (
        candidate.bytes > groupBytes ||
        candidate.group.rules.length >= ruleLimit ||
        value.includes("\0")
      ) {
        candidate.complete = false;
        candidate.group.rules = [];
      } else candidate.group.rules.push({ directive: field, pattern: value });
    }
  }
  const effective = groups.get("googlebot") ?? groups.get("*");
  return {
    complete: effective?.complete ?? true,
    group: effective?.complete ? effective.group : null,
  };
}

/** Normalize only unreserved path escapes. Acquisition and replay share this parser. */
export function parseRobotsPolicy(url: string, raw: string) {
  const canonicalPolicy = raw.replace(
    /^(\s*(?:disallow|allow)\s*:\s*)([^#\r\n]*)/gim,
    (_, prefix: string, path: string) =>
      prefix +
      path.replace(/%([0-9a-f]{2})/gi, (encoded, hex: string) => {
        const char = String.fromCharCode(parseInt(hex, 16));
        return /[A-Za-z0-9._~-]/.test(char) ? char : encoded.toUpperCase();
      }),
  );
  return robotsParser(url, canonicalPolicy);
}
/** Exact saved-policy replay uses the acquisition parser, without network or a clock. */
export function replayGoogleRobots(
  source: RobotsPolicyObservation,
  url: string,
): boolean | undefined {
  if (source.state !== "available" && source.state !== "no-file")
    return undefined;
  if (source.googleGroup === undefined) return undefined;
  const group = source.googleGroup;
  const policy = group
    ? [
        "User-agent: " + group.agent,
        "Disallow:",
        ...group.rules.map((r) => r.directive + ": " + r.pattern),
      ].join("\n")
    : "";
  return parseRobotsPolicy(source.requestedUrl, policy).isAllowed(
    url,
    "Googlebot",
  );
}

// The checkpoint is an internal writer, but any scored policy observation
// must resolve to a bounded, replayable receipt before becoming immutable.
const observedPoint = z.strictObject({
  url: z.string().max(2048),
  allowed: z.boolean().optional(),
});
const sourceSchema = z.strictObject({
  requestedUrl: z.string().max(2048),
  finalUrl: z.string().max(2048).optional(),
  acquiredAt: z.iso.datetime(),
  status: z.number().int().min(100).max(599).optional(),
  state: z.enum([
    "available",
    "no-file",
    "unavailable",
    "indeterminate",
    "evidence-limited",
  ]),
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  googleGroup: z
    .strictObject({
      agent: z.enum(["*", "googlebot"]),
      rules: z
        .array(
          z.strictObject({
            directive: z.enum(["allow", "disallow"]),
            pattern: z
              .string()
              .max(groupBytes)
              .refine((pattern) => !/[\r\n\u0000\uD800-\uDFFF]/u.test(pattern)),
          }),
        )
        .max(ruleLimit),
    })
    .nullable()
    .optional(),
  requested: observedPoint.optional(),
  final: observedPoint.optional(),
});
export function validRawRobotsReceipt(
  page: PageEvidence,
  value: unknown,
): boolean {
  if (value === undefined)
    return (
      page.robotsGoogleAllowed === undefined &&
      page.requestedRobotsGoogleAllowed === undefined
    );
  const parsed = sourceSchema.safeParse(value);
  if (!parsed.success) return false;
  const p = parsed.data,
    origin = new URL(page.requestedUrl).origin;
  if (
    p.requestedUrl !== origin + "/robots.txt" ||
    (p.finalUrl && !samePolicyOrigin(p.finalUrl, origin)) ||
    (p.requested && p.requested.url !== page.requestedUrl) ||
    (p.final && p.final.url !== page.finalUrl)
  )
    return false;
  if (
    p.googleGroup &&
    new TextEncoder().encode(JSON.stringify(p.googleGroup)).byteLength >
      groupBytes
  )
    return false;
  if (
    p.state === "available" &&
    (!p.finalUrl ||
      !p.status ||
      p.status < 200 ||
      p.status >= 300 ||
      !p.sha256 ||
      p.googleGroup === undefined)
  )
    return false;
  if (
    p.state === "no-file" &&
    (!p.finalUrl ||
      ![404, 410].includes(p.status ?? 0) ||
      p.googleGroup !== null ||
      p.sha256 !== undefined)
  )
    return false;
  for (const [point, verdict] of [
    [p.requested, page.requestedRobotsGoogleAllowed],
    [p.final, page.robotsGoogleAllowed],
  ] as const) {
    const replay = point ? replayGoogleRobots(p, point.url) : undefined;
    // For limited/indeterminate sources the observed parser decision can be
    // retained as diagnostic. It must never be persisted as a scored verdict.
    if (
      replay !== verdict ||
      (replay !== undefined && replay !== point?.allowed)
    )
      return false;
  }
  return true;
}
function samePolicyOrigin(url: string, origin: string) {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}
