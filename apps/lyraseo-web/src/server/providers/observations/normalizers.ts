import { createHash } from "node:crypto";
import { assertUniqueJsonMembers } from "./unique-json";
import {
  OBSERVATION_ADAPTER_VERSION,
  type ObservationContext,
  type ObservationResult,
  type ObservationUsage,
} from "./contracts";
import type { Annotation } from "@lyraseo/visibility";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("SCHEMA_CHANGED");
  return value as ObjectValue;
};
const text = (value: unknown, max = 100000): string => {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff]/u.test(value)
  )
    throw Error("SCHEMA_CHANGED");
  return value;
};
const list = (value: unknown, max = 256): unknown[] => {
  if (!Array.isArray(value) || value.length > max)
    throw Error("SCHEMA_CHANGED");
  return value;
};
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (k) => `${JSON.stringify(k)}:${canonical((value as ObjectValue)[k])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
// Only the JSON reviver can create entries. Provider-supplied objects cannot
// masquerade as decimal tokens merely by using a particular property name.
const numericCosts = new WeakMap<object, string>();
function parse(wire: string): ObjectValue {
  if (Buffer.byteLength(wire, "utf8") > 512 * 1024)
    throw Error("ENVELOPE_TOO_LARGE");
  assertUniqueJsonMembers(wire);
  // Node 24's reviver context retains the provider decimal lexeme before JS rounds it.
  const parseExact = JSON.parse as (
    s: string,
    reviver: (
      key: string,
      value: unknown,
      context?: { source?: string },
    ) => unknown,
  ) => unknown;
  return object(
    parseExact(wire, (key, value, context) => {
      if (key !== "cost" || typeof value !== "number") return value;
      const token = Object.freeze({});
      if (typeof context?.source === "string")
        numericCosts.set(token, context.source);
      return token;
    }),
  );
}
function cost(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const decimal = numericCosts.get(value);
  return typeof decimal === "string" &&
    /^(?:0|[1-9]\d{0,9})(?:\.\d{1,9})?$/.test(decimal)
    ? decimal
    : null;
}
function unit(
  usage: ObservationUsage,
  key: keyof ObservationUsage,
  value: unknown,
) {
  if (value === undefined || value === null) return;
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw Error("USAGE_SCHEMA_CHANGED");
  usage[key] = value as number;
}
function base(
  context: ObservationContext,
): Omit<ObservationResult, "digest" | "wireDigest"> {
  if (
    !context ||
    !["azure-sol-api", "consumer-chatgpt", "consumer-gemini"].includes(
      context.profile,
    ) ||
    !context.account ||
    !context.taskId ||
    !context.promptVersion ||
    !context.prompt ||
    context.prompt.length > 4000 ||
    context.language !== "en" ||
    context.market !== "IN" ||
    !Number.isSafeInteger(context.locationCode) ||
    context.locationCode <= 0 ||
    context.locationCode > 999999999
  )
    throw Error("INVALID_OBSERVATION_CONTEXT");
  try {
    text(context.account, 128);
    text(context.taskId, 256);
    text(context.promptVersion, 128);
    text(context.prompt, 4000);
  } catch {
    throw Error("INVALID_OBSERVATION_CONTEXT");
  }
  return {
    version: OBSERVATION_ADAPTER_VERSION,
    profile: context.profile,
    accountFingerprint: context.account,
    providerLocale: { languageCode: null, locationCode: null },
    taskId: null,
    state: "unsupported",
    body: null,
    annotations: [],
    citationMapping: "unknown",
    model: "provider-undisclosed",
    modelVersion: "provider-undisclosed",
    requestedLocale: { language: "en", market: "IN" },
    confirmedLocale: { language: null, market: null },
    usage: {},
    cost: null,
    costClassification: "UNKNOWN",
    completedAt: null,
    reason: null,
  };
}
function finish(
  wire: string,
  value: Omit<ObservationResult, "digest" | "wireDigest">,
): ObservationResult {
  return { ...value, digest: hash(canonical(value)), wireDigest: hash(wire) };
}
const url = (value: unknown) => {
  const s = text(value, 2048),
    u = new URL(s);
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password)
    throw Error("INVALID_CITATION");
  return s;
};
/** Parses a deliberately bounded inline-link subset, never provider source arrays.
 * Unsupported markdown link syntax withholds mapping instead of guessing spans. */
function markdownAnswer(markdown: string): {
  body: string;
  annotations: Annotation[];
  known: boolean;
} {
  const annotations: Annotation[] = [];
  let body = "",
    offset = 0;
  const pattern = /(?<!!)\[([^\[\]\n]+)\]\((https?:\/\/[^\s()]+)\)/g;
  for (const match of markdown.matchAll(pattern)) {
    body += markdown.slice(offset, match.index);
    const start = body.length;
    body += match[1]!;
    annotations.push({ url: url(match[2]), start, end: body.length });
    offset = match.index! + match[0].length;
    if (annotations.length > 256) throw Error("CITATION_LIMIT");
  }
  body += markdown.slice(offset);
  const known = !/[\[\]<>]|!\(|https?:\/\//.test(body);
  return { body, annotations: known ? annotations : [], known };
}
export function normalizeAzure(
  wire: string,
  context: ObservationContext,
): ObservationResult {
  const result = base(context);
  try {
    if (context.profile !== "azure-sol-api") throw Error("PROFILE_MISMATCH");
    const envelope = parse(wire);
    if (envelope.id !== context.taskId) throw Error("TASK_MISMATCH");
    result.taskId = context.taskId;
    result.model = text(envelope.model, 128);
    const usage = envelope.usage == null ? {} : object(envelope.usage);
    unit(result.usage, "inputTokens", usage.input_tokens);
    unit(result.usage, "outputTokens", usage.output_tokens);
    if (usage.input_tokens_details != null)
      unit(
        result.usage,
        "cachedTokens",
        object(usage.input_tokens_details).cached_tokens,
      );
    if (usage.output_tokens_details != null)
      unit(
        result.usage,
        "reasoningTokens",
        object(usage.output_tokens_details).reasoning_tokens,
      );
    if (envelope.tool_usage != null) {
      const tools = object(envelope.tool_usage);
      if (tools.web_search != null)
        unit(
          result.usage,
          "webSearchRequests",
          object(tools.web_search).num_requests,
        );
    }
    if (["in_progress", "queued"].includes(String(envelope.status))) {
      result.state = "pending";
      return finish(wire, result);
    }
    if (envelope.status === "failed" || envelope.status === "cancelled") {
      result.state = "failed";
      return finish(wire, result);
    }
    if (envelope.status === "incomplete") {
      result.state = "truncated";
      return finish(wire, result);
    }
    if (envelope.status !== "completed") throw Error("STATUS_SCHEMA_CHANGED");
    let body = "",
      refused = false;
    for (const entry of list(envelope.output)) {
      const item = object(entry);
      if (item.type === "reasoning" || item.type === "web_search_call")
        continue; // never retain hidden reasoning/search text
      if (item.type !== "message" || item.role !== "assistant")
        throw Error("OUTPUT_SCHEMA_CHANGED");
      if (item.status !== undefined && item.status !== "completed") {
        if (item.status !== "incomplete" && item.status !== "in_progress")
          throw Error("OUTPUT_STATUS_SCHEMA_CHANGED");
        result.state = item.status === "incomplete" ? "truncated" : "pending";
        result.annotations = [];
        return finish(wire, result);
      }
      if (body) body += "\n";
      for (const entry of list(item.content)) {
        const content = object(entry);
        if (content.type === "refusal") {
          refused = true;
          continue;
        }
        if (content.type !== "output_text")
          throw Error("OUTPUT_SCHEMA_CHANGED");
        const answer = text(content.text),
          start = body.length;
        body += answer;
        for (const annotation of list(content.annotations ?? [])) {
          const a = object(annotation);
          if (a.type !== "url_citation") throw Error("CITATION_SCHEMA_CHANGED");
          if (
            !Number.isSafeInteger(a.start_index) ||
            !Number.isSafeInteger(a.end_index) ||
            (a.start_index as number) < 0 ||
            (a.end_index as number) <= (a.start_index as number) ||
            (a.end_index as number) > answer.length
          )
            throw Error("INVALID_CITATION_SPAN");
          result.annotations.push({
            url: url(a.url),
            start: start + (a.start_index as number),
            end: start + (a.end_index as number),
          });
        }
      }
    }
    if (body.length > 100000 || result.annotations.length > 256)
      throw Error("ANSWER_TOO_LARGE");
    result.state = refused
      ? "no-answer"
      : body.trim()
        ? "complete"
        : "no-answer";
    result.body = refused ? null : body || null;
    if (refused) result.annotations = [];
    const unqualifiedUnicodeIndexes =
      result.annotations.length > 0 && /[\u{10000}-\u{10ffff}]/u.test(body);
    result.citationMapping = unqualifiedUnicodeIndexes ? "unknown" : "known";
    if (unqualifiedUnicodeIndexes) result.annotations = [];
  } catch {
    result.state = "unsupported";
    result.body = null;
    result.annotations = [];
    result.reason = "SCHEMA_OR_IDENTITY_UNSUPPORTED";
  }
  return finish(wire, result);
}
export function normalizeConsumer(
  wire: string,
  context: ObservationContext,
): ObservationResult {
  const result = base(context);
  try {
    if (context.profile === "azure-sol-api") throw Error("PROFILE_MISMATCH");
    const envelope = parse(wire),
      tasks = list(envelope.tasks, 1);
    if (
      envelope.status_code !== 20000 ||
      envelope.tasks_count !== 1 ||
      tasks.length !== 1
    )
      throw Error("ENVELOPE_SCHEMA_CHANGED");
    const task = object(tasks[0]),
      engine = context.profile === "consumer-chatgpt" ? "chat_gpt" : "gemini";
    if (task.id !== context.taskId) throw Error("TASK_MISMATCH");
    result.taskId = context.taskId;
    result.cost = cost(task.cost);
    if (result.cost !== null) result.costClassification = "PROVIDER_REPORTED";
    const data = object(task.data),
      path = list(task.path, 7);
    if (
      data.api !== "ai_optimization" ||
      data.function !== "llm_scraper" ||
      data.se !== engine ||
      data.keyword !== context.prompt ||
      data.language_code !== "en" ||
      data.location_code !== context.locationCode ||
      canonical(path) !==
        canonical([
          "v3",
          "ai_optimization",
          engine,
          "llm_scraper",
          "task_get",
          "advanced",
          context.taskId,
        ])
    )
      throw Error("PROFILE_OR_REQUEST_MISMATCH");
    if ([20100, 40601, 40602].includes(task.status_code as number)) {
      result.state = "pending";
      return finish(wire, result);
    }
    if (task.status_code !== 20000) {
      result.state = "failed";
      return finish(wire, result);
    }
    const results = list(task.result, 1);
    if (results.length !== 1 || task.result_count !== 1)
      throw Error("RESULT_SCHEMA_CHANGED");
    const answer = object(results[0]);
    if (
      answer.keyword !== context.prompt ||
      answer.language_code !== "en" ||
      answer.location_code !== context.locationCode
    )
      throw Error("LOCALE_OR_PROMPT_MISMATCH");
    result.confirmedLocale = { language: "en", market: null };
    result.providerLocale = {
      languageCode: "en",
      locationCode: context.locationCode,
    };
    if (answer.model != null) result.model = text(answer.model, 128);
    const completedAt = text(answer.datetime, 40)
      .replace(" ", "T")
      .replace(" +", "+");
    if (!Number.isFinite(Date.parse(completedAt)))
      throw Error("TIME_SCHEMA_CHANGED");
    result.completedAt = new Date(completedAt).toISOString();
    const normalized = markdownAnswer(text(answer.markdown));
    result.body = normalized.body;
    result.annotations = normalized.annotations;
    result.citationMapping = normalized.known ? "known" : "unknown";
    // This conservative refusal subset is a format fixture contract, not a live semantic classifier.
    result.state =
      /^(?:I (?:cannot|can't|am unable to)|Sorry,? I (?:cannot|can't))/i.test(
        normalized.body.trim(),
      )
        ? "no-answer"
        : "complete";
    if (result.state === "no-answer") {
      result.body = null;
      result.annotations = [];
    }
  } catch {
    result.state = "unsupported";
    result.body = null;
    result.annotations = [];
    result.confirmedLocale = { language: null, market: null };
    result.reason = "SCHEMA_OR_IDENTITY_UNSUPPORTED";
  }
  return finish(wire, result);
}
