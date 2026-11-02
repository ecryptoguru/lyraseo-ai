/** Controlled, normalized fixture producer. These bytes are never original provider wire. */
import { createHash } from "node:crypto";
import {
  EXTRACTION_VERSION,
  VISIBILITY_PROFILES,
  validatePanel,
  extractBrands,
  type Prompt,
  type Brand,
} from "@lyraseo/visibility";
import type { ProviderEvidence } from "./visibility";
export const OBSERVATION_STORAGE = "OBSERVATION_PRIVATE_V1";
export const ANSWER_REPRESENTATION = "ANSWER_PARSED_JSON_V1";
export const ANSWER_LIMIT = 512 * 1024;
export type ObservationRecording = {
  storageFormat?: typeof OBSERVATION_STORAGE;
  sourceNamespace: "CONTROLLED_FIXTURE_V1";
  recordingKey: string;
};
type Panel = { id: string; version: number; prompts: unknown; brands: unknown };
const digest = (value: Uint8Array | string) =>
  createHash("sha256").update(value).digest("hex");
const invalid = () => Error("INVALID_PROVIDER_EVIDENCE");
const scalar = (value: unknown, max: number, empty = false): value is string =>
  typeof value === "string" &&
  (empty || value.length > 0) &&
  value.length <= max &&
  !/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value);
function bodyScalar(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 100000 &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ud800-\udfff]/u.test(
      value,
    )
  );
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
const failure = {
  failed: "PROVIDER_FAILED",
  unsupported: "UNSUPPORTED",
  "no-answer": "NO_ANSWER",
  ambiguous: "AMBIGUOUS",
  successful: null,
} as const;
const extractionReason = (reason: string | null) =>
  reason === "Shared alias requires review"
    ? "SHARED_ALIAS"
    : reason === "Recommendation requires evidence-based adjudication"
      ? "RECOMMENDATION_UNADJUDICATED"
      : null;
function compactExtraction(
  body: string,
  annotations: ProviderEvidence["slots"][number]["annotations"],
  brands: Brand[],
) {
  return Object.fromEntries(
    Object.entries(extractBrands(body, annotations, brands)).map(
      ([id, value]) => [
        id,
        { ...value, reason: extractionReason(value.reason) },
      ],
    ),
  );
}
function projection(e: ProviderEvidence) {
  return {
    profile: e.profile,
    provider: e.provider,
    model: e.model,
    modelVersion: e.modelVersion,
    retrievalMode: e.retrievalMode,
    observedAt: e.observedAt,
    synthetic: true,
    rawAnswerRights: true,
    rawRightsUntil: e.rawRightsUntil ?? null,
    requestedLocale: { language: "en", market: "IN" },
    confirmedLocale: {
      language: e.confirmedLocale.language,
      market: e.confirmedLocale.market,
    },
    extractionVersion: EXTRACTION_VERSION,
    clockContract: "COMMON_OBSERVED_AT_V1",
    producerClass: "CONTROLLED_FIXTURE_V1",
    representation: ANSWER_REPRESENTATION,
  };
}
function representation(e: ProviderEvidence, index: number) {
  const slot = e.slots[index]!;
  if (slot.body === undefined) return undefined;
  return new TextEncoder().encode(
    JSON.stringify({
      representation: ANSWER_REPRESENTATION,
      clockContract: "COMMON_OBSERVED_AT_V1",
      provenance: projection(e),
      promptId: slot.promptId,
      state: slot.state,
      body: slot.body,
      annotations: slot.annotations,
      providerTaskId: slot.providerTaskId,
      completedAt: slot.completedAt,
      failureCode: failure[slot.state],
    }),
  );
}
function manifestOf(panel: Panel, e: ProviderEvidence) {
  const brands = panel.brands as Brand[];
  let total = 0;
  const slots = e.slots.map((slot, index) => {
    const bytes = representation(e, index);
    if (bytes && bytes.byteLength > ANSWER_LIMIT)
      throw Error("ANSWER_TOO_LARGE");
    total += bytes?.byteLength ?? 0;
    const compact = {
      promptId: slot.promptId,
      state: slot.state,
      providerTaskId: slot.providerTaskId,
      completedAt: slot.completedAt,
      failureReason: failure[slot.state],
      extraction: ["successful", "ambiguous"].includes(slot.state)
        ? compactExtraction(slot.body!, slot.annotations, brands)
        : {},
      answerHash: bytes ? digest(bytes) : null,
      answerLength: bytes?.byteLength ?? 0,
    };
    return { ...compact, factDigest: digest(JSON.stringify(compact)) };
  });
  if (total > 16 * 1024 * 1024) throw Error("ANSWER_TOO_LARGE");
  const cohort = digest(
    JSON.stringify({
      panelId: panel.id,
      profile: e.profile,
      provider: e.provider,
      model: e.model,
      version: e.modelVersion,
      retrieval: e.retrievalMode,
      requested: e.requestedLocale,
      confirmed: e.confirmedLocale,
      synthetic: e.synthetic,
      extraction: EXTRACTION_VERSION,
    }),
  );
  return {
    profile: e.profile,
    cohort,
    createdAt: e.observedAt,
    rawExpiresAt: new Date(
      Math.min(
        Date.parse(e.observedAt) + 90 * 86400000,
        e.rawRightsUntil ? Date.parse(e.rawRightsUntil) : Infinity,
      ),
    ).toISOString(),
    provenance: projection(e),
    slots,
  };
}
export type NormalizedObservation = {
  readonly manifest: ReturnType<typeof manifestOf>;
  readonly identity: ObservationRecording;
  readonly provenance: {
    sourceNamespace: "CONTROLLED_FIXTURE_V1";
    recordingKey: string;
    panel: Panel;
  };
};
const sealed = new WeakMap<
  NormalizedObservation,
  { evidence: ProviderEvidence; panel: Panel }
>();
export function normalizeObservation(
  panelInput: Panel,
  evidenceInput: ProviderEvidence,
  recording: ObservationRecording,
  finalizedReplay = false,
): NormalizedObservation {
  if (
    !recording ||
    recording.sourceNamespace !== "CONTROLLED_FIXTURE_V1" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(recording.recordingKey) ||
    Object.keys(recording).some(
      (k) => !["sourceNamespace", "recordingKey", "storageFormat"].includes(k),
    ) ||
    (recording.storageFormat !== undefined &&
      recording.storageFormat !== OBSERVATION_STORAGE)
  )
    throw Error("UNSUPPORTED_OBSERVATION_SOURCE");
  const e = structuredClone(evidenceInput),
    panel = structuredClone(panelInput);
  if (
    Object.keys(e).some(
      (k) =>
        ![
          "profile",
          "provider",
          "model",
          "modelVersion",
          "retrievalMode",
          "requestedLocale",
          "confirmedLocale",
          "synthetic",
          "rawAnswerRights",
          "observedAt",
          "rawRightsUntil",
          "slots",
        ].includes(k),
    )
  )
    throw invalid();
  validatePanel(panel.prompts as Prompt[], panel.brands as Brand[]);
  if (
    (panel.prompts as Prompt[]).some((p) => !scalar(p.id, 80)) ||
    (panel.brands as Brand[]).some((b) => !scalar(b.id, 80))
  )
    throw invalid();
  if (
    !e ||
    !VISIBILITY_PROFILES.includes(e.profile) ||
    e.synthetic !== true ||
    e.rawAnswerRights !== true ||
    !Number.isFinite(Date.parse(e.observedAt)) ||
    Date.parse(e.observedAt) > Date.now() ||
    !scalar(e.observedAt, 40) ||
    (e.rawRightsUntil !== undefined &&
      (!scalar(e.rawRightsUntil, 40) ||
        !Number.isFinite(Date.parse(e.rawRightsUntil)))) ||
    !e.requestedLocale ||
    e.requestedLocale.language !== "en" ||
    e.requestedLocale.market !== "IN" ||
    !e.confirmedLocale ||
    ![e.confirmedLocale.language, e.confirmedLocale.market].every(
      (x) => x === null || scalar(x, 32),
    ) ||
    ![e.provider, e.model, e.modelVersion, e.retrievalMode].every((x) =>
      scalar(x, 128),
    ) ||
    !Array.isArray(e.slots) ||
    e.slots.length !== (panel.prompts as Prompt[]).length ||
    e.slots.length > 25 ||
    new Set(e.slots.map((x) => x.promptId)).size !== e.slots.length
  )
    throw invalid();
  if (e.provider !== (e.profile === "azure-sol-api" ? "azure" : "dataforseo"))
    throw Error("PROFILE_PROVIDER_MISMATCH");
  const prompts = new Set((panel.prompts as Prompt[]).map((p) => p.id));
  if (
    [e.requestedLocale, e.confirmedLocale].some((locale) =>
      Object.keys(locale).some((k) => !["language", "market"].includes(k)),
    )
  )
    throw invalid();
  for (const s of e.slots) {
    if (
      Object.keys(s).some(
        (k) =>
          ![
            "promptId",
            "state",
            "body",
            "annotations",
            "providerTaskId",
            "completedAt",
            "failureReason",
          ].includes(k),
      )
    )
      throw invalid();
    if (
      s.failureReason !== undefined &&
      (typeof s.failureReason !== "string" || s.failureReason.length > 128)
    )
      throw invalid();
    s.failureReason = failure[s.state] ?? undefined;
    if (
      !prompts.has(s.promptId) ||
      !scalar(s.promptId, 80) ||
      !scalar(s.providerTaskId, 256) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(s.providerTaskId) ||
      !scalar(s.completedAt, 40) ||
      !Number.isFinite(Date.parse(s.completedAt)) ||
      !Object.hasOwn(failure, s.state) ||
      !Array.isArray(s.annotations) ||
      s.annotations.length > 256 ||
      (s.body !== undefined && !bodyScalar(s.body)) ||
      (["successful", "ambiguous"].includes(s.state) && !s.body?.trim()) ||
      (s.body === undefined && s.annotations.length !== 0)
    )
      throw invalid();
    if (
      ["successful", "ambiguous"].includes(s.state) &&
      e.profile !== "azure-sol-api" &&
      (e.confirmedLocale.language !== "en" || e.confirmedLocale.market !== "IN")
    )
      throw Error("UNSUPPORTED_PROVIDER_LOCALE");
    for (const a of s.annotations)
      if (
        Object.keys(a).some((k) => !["url", "start", "end"].includes(k)) ||
        !scalar(a.url, 2048) ||
        Buffer.byteLength(a.url, "utf8") > 2048 ||
        !Number.isInteger(a.start) ||
        !Number.isInteger(a.end) ||
        a.start < 0 ||
        a.end <= a.start ||
        a.end > (s.body?.length ?? 0)
      )
        throw invalid();
  }
  // Reconstruct each annotation in a fixed field order; representation bytes are normalized JSON.
  for (const slot of e.slots)
    slot.annotations = slot.annotations.map(({ url, start, end }) => ({
      url,
      start,
      end,
    }));
  // Sort by frozen panel coverage, independent of producer array order.
  e.slots.sort(
    (a, b) =>
      (panel.prompts as Prompt[]).findIndex((p) => p.id === a.promptId) -
      (panel.prompts as Prompt[]).findIndex((p) => p.id === b.promptId),
  );
  const manifest = manifestOf(panel, e);
  if (Buffer.byteLength(JSON.stringify(manifest), "utf8") > 262144)
    throw Error("ANSWER_TOO_LARGE");
  if (!finalizedReplay && Date.parse(manifest.rawExpiresAt) <= Date.now())
    throw Error("SOURCE_EXPIRED");
  const value = freeze({
    manifest,
    identity: {
      sourceNamespace: recording.sourceNamespace,
      recordingKey: recording.recordingKey,
    },
    provenance: {
      sourceNamespace: recording.sourceNamespace,
      recordingKey: recording.recordingKey,
      panel: {
        id: panel.id,
        version: panel.version,
        prompts: panel.prompts,
        brands: panel.brands,
      },
    },
  });
  sealed.set(value, { evidence: freeze(e), panel: freeze(panel) });
  return value;
}
export function checkedObservationSource(value: NormalizedObservation) {
  const original = sealed.get(value);
  if (
    !original ||
    JSON.stringify(manifestOf(original.panel, original.evidence)) !==
      JSON.stringify(value.manifest)
  )
    throw Error("UNTRUSTED_OBSERVATION_SOURCE");
  return value;
}
export function answerRepresentation(
  value: NormalizedObservation,
  index: number,
) {
  const original = sealed.get(value);
  if (
    !original ||
    !Number.isInteger(index) ||
    index < 0 ||
    index >= value.manifest.slots.length
  )
    throw Error("UNTRUSTED_OBSERVATION_SOURCE");
  return representation(original.evidence, index);
}
export function verifyAnswerRepresentation(
  value: NormalizedObservation,
  index: number,
  bytes: Uint8Array,
) {
  const expected = answerRepresentation(value, index);
  if (
    !expected ||
    bytes.byteLength > ANSWER_LIMIT ||
    digest(bytes) !== digest(expected) ||
    bytes.byteLength !== expected.byteLength
  )
    throw Error("ARTIFACT_CORRUPT");
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    parsed = JSON.parse(decoded);
  const slot = value.manifest.slots[index]!,
    original = sealed.get(value)!;
  if (
    JSON.stringify(parsed) !== decoded ||
    (JSON.stringify(
      compactExtraction(
        parsed.body,
        parsed.annotations,
        original.panel.brands as Brand[],
      ),
    ) !== JSON.stringify(slot.extraction) &&
      ["successful", "ambiguous"].includes(slot.state))
  )
    throw Error("INVALID_PROVIDER_EVIDENCE");
}
