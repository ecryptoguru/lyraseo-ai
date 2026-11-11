import { createHash } from "node:crypto";
import { assertUniqueJsonMembers } from "./unique-json";

/** DataForSEO Standard task formats only. This module never sends a request,
 * grants spend, qualifies an account, or authorizes provider evidence. */
export type ConsumerSlot = Readonly<{
  profile: "consumer-chatgpt" | "consumer-gemini";
  prompt: string;
  correlation: string;
  language: "en";
  locationCode: number;
}>;
type JsonObject = Record<string, unknown>;
type Receipt = Readonly<{
  state: "accepted" | "reconciliation-required";
  taskId: string | null;
  cost: string | null;
  /** Digest of the supplied decoded text, not an original-wire attestation. */
  textDigest: string | null;
}>;
const object = (value: unknown): JsonObject | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
function validateSlot(slot: ConsumerSlot) {
  if (
    !slot ||
    !["consumer-chatgpt", "consumer-gemini"].includes(slot.profile) ||
    typeof slot.prompt !== "string" ||
    !slot.prompt.trim() ||
    slot.prompt.length > 2000 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ud800-\udfff]/u.test(
      slot.prompt,
    ) ||
    typeof slot.correlation !== "string" ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(slot.correlation) ||
    slot.language !== "en" ||
    !Number.isSafeInteger(slot.locationCode) ||
    slot.locationCode < 1 ||
    slot.locationCode > 999999999
  )
    throw Error("INVALID_CONSUMER_TASK");
}
const engineFor = (profile: ConsumerSlot["profile"]) =>
  profile === "consumer-chatgpt" ? "chat_gpt" : "gemini";

/** Emits one normal-priority task; location availability is not established here.
 * See https://docs.dataforseo.com/v3/ai_optimization/chat_gpt/llm_scraper/task_post/
 * and https://docs.dataforseo.com/v3/ai_optimization-gemini-llm_scraper-task_post/. */
export function consumerStandardRequest(slot: ConsumerSlot) {
  validateSlot(slot);
  const engine = engineFor(slot.profile);
  return {
    path: `/v3/ai_optimization/${engine}/llm_scraper/task_post`,
    body: [
      {
        keyword: encodeURIComponent(slot.prompt),
        language_code: slot.language,
        location_code: slot.locationCode,
        priority: 1,
        tag: slot.correlation,
        ...(engine === "chat_gpt" ? { force_web_search: true } : {}),
      },
    ],
  };
}

/** A malformed or unbound response is always uncertain: no call site may infer
 * non-acceptance or permission to resubmit from it. A missing/malformed cost
 * keeps an accepted task identifiable while cost reconciliation stays open. */
export function parseConsumerTaskReceipt(
  wire: string,
  slot: ConsumerSlot,
): Receipt {
  validateSlot(slot);
  if (typeof wire !== "string" || Buffer.byteLength(wire, "utf8") > 64 * 1024)
    return {
      state: "reconciliation-required",
      taskId: null,
      cost: null,
      textDigest: null,
    };
  const textDigest = createHash("sha256").update(wire).digest("hex");
  const uncertain = (): Receipt => ({
    state: "reconciliation-required",
    taskId: null,
    cost: null,
    textDigest,
  });
  try {
    // Only this parse invocation can mint a token tied to an actual numeric
    // JSON source lexeme; ordinary provider objects and arrays have no entry.
    const numericCosts = new WeakMap<object, string>();
    const parseExact = JSON.parse as (
      value: string,
      reviver: (
        key: string,
        value: unknown,
        context?: { source?: string },
      ) => unknown,
    ) => unknown;
    const envelope = object(
      parseExact(wire, (key, value, context) => {
        if (key !== "cost" || typeof value !== "number") return value;
        const token = Object.freeze({});
        if (typeof context?.source === "string")
          numericCosts.set(token, context.source);
        return token;
      }),
    );
    assertUniqueJsonMembers(wire);
    if (
      !envelope ||
      envelope.status_code !== 20000 ||
      envelope.tasks_count !== 1 ||
      envelope.tasks_error !== 0 ||
      !Array.isArray(envelope.tasks) ||
      envelope.tasks.length !== 1
    )
      return uncertain();
    const task = object(envelope.tasks[0]);
    const data = object(task?.data);
    const engine = engineFor(slot.profile);
    const path = task?.path;
    if (
      !task ||
      !data ||
      task.status_code !== 20100 ||
      task.result_count !== 0 ||
      task.result !== null ||
      typeof task.id !== "string" ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(task.id) ||
      !Array.isArray(path) ||
      path.length !== 5 ||
      path[0] !== "v3" ||
      path[1] !== "ai_optimization" ||
      !(
        path[2] === engine ||
        (engine === "chat_gpt" && path[2] === "chatgpt")
      ) ||
      path[3] !== "llm_scraper" ||
      path[4] !== "task_post" ||
      data.se !== engine ||
      data.keyword !== slot.prompt ||
      data.language_code !== slot.language ||
      data.location_code !== slot.locationCode ||
      data.tag !== slot.correlation
    )
      return uncertain();
    const rawCost =
      task.cost && typeof task.cost === "object"
        ? numericCosts.get(task.cost)
        : undefined;
    const cost =
      typeof rawCost === "string" &&
      /^(?:0|[1-9]\d{0,9})(?:\.\d{1,9})?$/.test(rawCost)
        ? rawCost
        : null;
    return { state: "accepted", taskId: task.id, cost, textDigest };
  } catch {
    return uncertain();
  }
}
