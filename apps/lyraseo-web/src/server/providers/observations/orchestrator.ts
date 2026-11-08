import { createHash } from "node:crypto";
import { validatePanel, type Prompt, type Brand } from "@lyraseo/visibility";
import type {
  ObservationContext,
  ObservationResult,
  ObservationUsage,
} from "./contracts";
import {
  checkedObservationFixture,
  fixtureRequest,
  submitFixture,
  fixtureResponse,
  type ObservationFixture,
} from "./fixture";
import { normalizeAzure, normalizeConsumer } from "./normalizers";
import { parseConsumerTaskReceipt } from "./consumer-standard";

export type ObservationLedgerEvidence = {
  kind: "ACCEPTED" | "UNCERTAIN" | "RESOLVED";
  observedAt: string;
  taskId?: string;
  accepted?: boolean;
  outputValid?: boolean;
  cost?: string;
  costVersion?: number;
  usage?: ObservationUsage;
};
/** Structural subset implemented by the restricted provider-ledger repository.
 * No settlement/cost arithmetic or authorization is implemented in this port. */
export type KnownFixtureTask = {
  context: ObservationContext;
  cost: string | null;
  observedAt: string;
};
export type ObservationLedger = {
  knownTask?(attemptId: string): Promise<KnownFixtureTask>;
  prepare(input: {
    operationId: string;
    fence: number;
    step: string;
    requestHash: string;
    expectedRevision: number;
  }): Promise<{ id: string; revision: number; submissionGranted: boolean }>;
  record(
    attemptId: string,
    sourceKey: string,
    evidence: ObservationLedgerEvidence,
  ): Promise<{ revision: number }>;
};
export type ObservationSlotInput = {
  operationId: string;
  fence: number;
  step: string;
  expectedRevision: number;
  panel: { id: string; version: number; prompts: Prompt[]; brands: Brand[] };
  promptId: string;
  promptVersion: string;
};
export type ObservationHandle = Readonly<{
  source: "SYNTHETIC";
  attemptId: string;
  taskId: string | null;
  state: ObservationResult["state"] | "reconciliation-required";
  result?: ObservationResult;
}>;
type HandleContext = {
  fixture: ObservationFixture;
  context: ObservationContext;
  cost: string | null;
  observedAt: string;
};
const handles = new WeakMap<ObservationHandle, HandleContext>();
const digest = (input: unknown) =>
  createHash("sha256").update(JSON.stringify(input)).digest("hex");
function handle(
  fixture: ObservationFixture,
  context: ObservationContext,
  cost: string | null,
  value: Omit<ObservationHandle, "source">,
  observedAt = new Date().toISOString(),
) {
  const result = Object.freeze({ source: "SYNTHETIC" as const, ...value });
  handles.set(result, { fixture, context, cost, observedAt });
  return result;
}
function resultFor(fixture: ObservationFixture, context: ObservationContext) {
  const wire = fixtureResponse(fixture, context);
  return fixture.profile === "azure-sol-api"
    ? normalizeAzure(wire, context)
    : normalizeConsumer(wire, context);
}
async function recordResult(
  ledger: ObservationLedger,
  attemptId: string,
  context: ObservationContext,
  cost: string | null,
  result: ObservationResult,
  observedAt: string,
) {
  if (result.state === "pending" || cost === null) {
    if (context.profile === "azure-sol-api")
      await ledger.record(attemptId, `fixture-post-accepted:${attemptId}`, {
        kind: "ACCEPTED",
        observedAt,
        taskId: context.taskId,
        ...(cost === null ? {} : { cost, costVersion: 1 }),
        usage: result.usage,
      });
    return;
  }
  await ledger.record(
    attemptId,
    `fixture-result:${attemptId}:${result.digest}`,
    {
      kind: "RESOLVED",
      observedAt,
      taskId: context.taskId,
      accepted: true,
      outputValid: result.state === "complete",
      ...(cost === null
        ? {}
        : { cost, costVersion: context.profile === "azure-sol-api" ? 1 : 2 }),
      usage: result.usage,
    },
  );
}
/** Internal offline fixture path only. It never writes an observation source and
 * cannot qualify a live account or substitute provider wire for fixture evidence. */
export async function submitObservationFixture(
  ledger: ObservationLedger,
  fixture: ObservationFixture,
  input: ObservationSlotInput,
): Promise<ObservationHandle> {
  checkedObservationFixture(fixture);
  const panel = structuredClone(input.panel);
  validatePanel(panel.prompts, panel.brands);
  const prompt = panel.prompts.find((p) => p.id === input.promptId);
  if (
    !prompt ||
    !panel.id ||
    !Number.isSafeInteger(panel.version) ||
    panel.version < 1 ||
    input.promptVersion !== `panel-${panel.version}:${prompt.id}`
  )
    throw Error("FROZEN_PANEL_SLOT_REQUIRED");
  const correlation = `fixture:${digest({ operationId: input.operationId, step: input.step, revision: input.expectedRevision, panelId: panel.id, panelVersion: panel.version, promptId: prompt.id }).slice(0, 48)}`;
  const { request, context } = fixtureRequest(
    fixture,
    prompt.text,
    input.promptVersion,
    correlation,
  );
  const prepared = await ledger.prepare({
    operationId: input.operationId,
    fence: input.fence,
    step: input.step,
    expectedRevision: input.expectedRevision,
    requestHash: digest({
      fixtureScenario: checkedObservationFixture(fixture).scenario,
      version: "observation-adapters-v1",
      panel,
      promptId: prompt.id,
      promptVersion: input.promptVersion,
      request,
    }),
  });
  if (prepared.submissionGranted !== true)
    return handle(fixture, context, null, {
      attemptId: prepared.id,
      taskId: null,
      state: "reconciliation-required",
    });
  const observedAt = new Date().toISOString();
  let submission: ReturnType<typeof submitFixture>;
  try {
    submission = submitFixture(fixture, context, prepared.id, correlation);
  } catch {
    await ledger.record(prepared.id, `fixture-post-uncertain:${prepared.id}`, {
      kind: "UNCERTAIN",
      observedAt,
    });
    return handle(fixture, context, null, {
      attemptId: prepared.id,
      taskId: null,
      state: "reconciliation-required",
    });
  }
  if (submission.kind === "consumer") {
    if (fixture.profile === "azure-sol-api")
      throw Error("FIXTURE_PROFILE_MISMATCH");
    const receipt = parseConsumerTaskReceipt(submission.wire, {
      profile: fixture.profile,
      prompt: context.prompt,
      correlation,
      language: context.language,
      locationCode: context.locationCode,
    });
    if (receipt.state !== "accepted" || receipt.taskId !== context.taskId) {
      await ledger.record(
        prepared.id,
        `fixture-post-uncertain:${prepared.id}`,
        {
          kind: "UNCERTAIN",
          observedAt,
        },
      );
      return handle(fixture, context, null, {
        attemptId: prepared.id,
        taskId: null,
        state: "reconciliation-required",
      });
    }
    await ledger.record(prepared.id, `fixture-post-accepted:${prepared.id}`, {
      kind: "ACCEPTED",
      observedAt,
      taskId: receipt.taskId!,
      ...(receipt.cost === null ? {} : { cost: receipt.cost, costVersion: 1 }),
      usage: { postedTasks: 1 },
    });
    return handle(
      fixture,
      context,
      receipt.cost,
      { attemptId: prepared.id, taskId: receipt.taskId, state: "pending" },
      observedAt,
    );
  }
  const result = resultFor(fixture, context);
  await recordResult(
    ledger,
    prepared.id,
    context,
    submission.cost,
    result,
    observedAt,
  );
  return handle(fixture, context, submission.cost, {
    attemptId: prepared.id,
    taskId: submission.taskId,
    state: result.state,
    result,
  });
}
/** A known task is a sealed acquisition handle. Polling never prepares a new
 * attempt, obtains another quote, reserves again or dispatches a replacement. */
export async function pollObservationFixture(
  ledger: ObservationLedger,
  fixture: ObservationFixture,
  submitted: ObservationHandle,
): Promise<ObservationHandle> {
  const saved = handles.get(submitted);
  if (!saved || saved.fixture !== fixture)
    throw Error("UNTRUSTED_OBSERVATION_HANDLE");
  if (!submitted.taskId || fixture.profile === "azure-sol-api")
    throw Error("KNOWN_TASK_REQUIRED");
  const result = resultFor(fixture, saved.context);
  await recordResult(
    ledger,
    submitted.attemptId,
    saved.context,
    saved.cost,
    result,
    saved.observedAt,
  );
  return handle(
    fixture,
    saved.context,
    saved.cost,
    {
      attemptId: submitted.attemptId,
      taskId: submitted.taskId,
      state: result.state,
      result,
    },
    saved.observedAt,
  );
}

/** Rebuilds a known-task handle from the restricted durable binding. No POST,
 * new quote or replacement can occur on this recovery path. */
export async function resumeObservationFixture(
  ledger: ObservationLedger,
  fixture: ObservationFixture,
  attemptId: string,
): Promise<ObservationHandle> {
  checkedObservationFixture(fixture);
  if (!ledger.knownTask) throw Error("KNOWN_TASK_REPOSITORY_REQUIRED");
  const saved = await ledger.knownTask(attemptId);
  if (
    saved.context.profile !== fixture.profile ||
    !saved.context.taskId ||
    fixture.profile === "azure-sol-api"
  )
    throw Error("KNOWN_TASK_REQUIRED");
  return handle(
    fixture,
    saved.context,
    saved.cost,
    { attemptId, taskId: saved.context.taskId, state: "pending" },
    saved.observedAt,
  );
}
