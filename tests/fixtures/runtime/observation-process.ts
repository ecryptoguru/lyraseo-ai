// Controlled normalized producer only. Fixture input and the ephemeral operator
// capability arrive over local IPC, never argv/env/stdout/stderr.
import { createDatabase } from "../../../packages/db/src";
import {
  recordVisibilityEvidence,
  type ProviderEvidence,
} from "../../../packages/db/src/visibility";
import { bindLocalArtifactStore } from "../../../packages/db/src/artifact-checkpoint";
import {
  localAuditArtifactStore,
  localArtifactFaultFacade,
  type AuditArtifactStore,
} from "../../../packages/db/src/artifact-store";
import type { Actor } from "../../../packages/db/src/context";
import type { ObservationRecording } from "../../../packages/db/src/observation-source";
import { runtimeUrl } from "../../helpers/database";
export type ObservationPhase = "reserved" | "verified-io" | "finalized";
export type ObservationProcessInput = {
  root: string;
  actor: Actor;
  panelId: string;
  evidence: ProviderEvidence;
  recording: ObservationRecording;
  authority: { keyId: string; secret: Uint8Array };
  pauseAt?: ObservationPhase;
  rejectIO?: boolean;
};
export type ObservationProcessEvent = {
  event: "configure" | "barrier" | "result" | "error";
  phase?: ObservationPhase;
  id?: string;
  code?: string;
  io?: Record<string, number>;
};
const send = (value: ObservationProcessEvent) =>
  new Promise<void>((resolve, reject) => {
    if (!process.send) return reject(Error("FIXTURE_IPC_REQUIRED"));
    process.send(value, (error) => (error ? reject(error) : resolve()));
  });
async function barrier(phase: ObservationPhase) {
  const resume = new Promise<void>((resolve, reject) =>
    process.once("message", (value: { action?: string }) =>
      value?.action === "continue"
        ? resolve()
        : reject(Error("FIXTURE_IPC_REQUIRED")),
    ),
  );
  await send({ event: "barrier", phase });
  await resume;
}
process.once("message", async (input: ObservationProcessInput) => {
  const client = createDatabase(runtimeUrl);
  let store: AuditArtifactStore | undefined;
  try {
    store = await localAuditArtifactStore(input.root);
    const io: Record<string, number> = {
      put: 0,
      stat: 0,
      read: 0,
      recover: 0,
      delete: 0,
      inventory: 0,
    };
    const touched = (kind: string) => {
      io[kind] = io[kind]! + 1;
      if (input.rejectIO) throw Error("UNEXPECTED_OBJECT_IO");
    };
    const backend = localArtifactFaultFacade(store, {
      before: (operation) => touched(operation),
    });
    let transaction = 0;
    const transact = client.$transaction.bind(client) as (
      ...args: unknown[]
    ) => Promise<unknown>;
    // Test-only transaction wrapper. The reservation barrier follows its COMMIT;
    // the third transaction is reached only after verifiedNormalizedPublication
    // has completed, and is held BEFORE entering PostgreSQL or holding locks.
    const db = new Proxy(client, {
      get(target, property, receiver) {
        if (property === "$transaction")
          return async (...args: unknown[]) => {
            const current = ++transaction;
            if (current === 3 && input.pauseAt === "verified-io") {
              if (
                input.evidence.slots.some((slot) => slot.body !== undefined) &&
                (!io.put || !io.stat || !io.read)
              )
                throw Error("FIXTURE_BOUNDARY_NOT_REACHED");
              await barrier("verified-io");
            }
            const value = await transact(...args);
            if (current === 2 && input.pauseAt === "reserved") {
              if (!(
                value &&
                typeof value === "object" &&
                "state" in value &&
                value.state === "STAGED"
              ))
                throw Error("FIXTURE_BOUNDARY_NOT_REACHED");
              if (Object.values(io).some(Boolean))
                throw Error("FIXTURE_BOUNDARY_NOT_REACHED");
              await barrier("reserved");
            }
            return value;
          };
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    bindLocalArtifactStore(db, backend, input.authority);
    const result = await recordVisibilityEvidence(
      db,
      input.actor,
      { workspaceId: "a", siteId: "a-site" },
      input.panelId,
      input.evidence,
      input.recording,
    );
    if (input.pauseAt === "finalized") await barrier("finalized");
    await send({ event: "result", id: result.id, io });
    await store.close();
    await client.$disconnect();
    process.disconnect?.();
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const known = [
      "IMMUTABLE_OBSERVATION",
      "OBSERVATION_RETIRED",
      "ARTIFACT_UNAVAILABLE",
      "SOURCE_EXPIRED",
      "UNEXPECTED_OBJECT_IO",
      "FIXTURE_BOUNDARY_NOT_REACHED",
    ];
    await send({
      event: "error",
      code:
        known.find((code) => message.includes(code)) ??
        "FIXTURE_PROCESS_FAILED",
    }).catch(() => {});
    await store?.close();
    await client.$disconnect();
    process.exitCode = 1;
    process.disconnect?.();
  }
});
void send({ event: "configure" });
