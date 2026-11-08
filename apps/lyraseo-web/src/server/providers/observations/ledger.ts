import type { createDatabase } from "@lyraseo/db";
import { recordAttemptEvidence } from "../../../../../../packages/db/src/provider-ledger";
import { checkedObservationFixture, type ObservationFixture } from "./fixture";
import type {
  ObservationLedger,
  ObservationSlotInput,
  KnownFixtureTask,
} from "./orchestrator";
type Database = ReturnType<typeof createDatabase>;
/** Restricted local fixture principal only; SQL atomically binds the immutable
 * reviewed panel slot before granting submission. No customer Actor is fabricated. */
export function fixtureObservationLedger(
  db: Database,
  fixture: ObservationFixture,
  slot: ObservationSlotInput,
): ObservationLedger {
  const frozen = structuredClone(slot);
  const scenario = checkedObservationFixture(fixture).scenario;
  const panel = JSON.stringify(frozen.panel);
  return {
    async knownTask(attemptId) {
      const [row] = await db.$queryRaw<
        {
          value: KnownFixtureTask & {
            profile: string;
            scenario: string;
            operationId: string;
            panelId: string;
            promptId: string;
          };
        }[]
      >`SELECT lyraseo_observation_binding.known_fixture_task(${attemptId}::uuid) AS value`;
      if (
        !row ||
        row.value.profile !== fixture.profile ||
        row.value.scenario !== scenario ||
        row.value.operationId !== frozen.operationId ||
        row.value.panelId !== frozen.panel.id ||
        row.value.promptId !== frozen.promptId
      )
        throw Error("KNOWN_TASK_REQUIRED");
      return row.value;
    },
    async prepare(input) {
      if (
        input.operationId !== frozen.operationId ||
        input.fence !== frozen.fence ||
        input.step !== frozen.step ||
        input.expectedRevision !== frozen.expectedRevision
      )
        throw Error("OBSERVATION_OPERATION_MISMATCH");
      const [row] = await db.$queryRaw<
        {
          value: { id: string; revision: number; submissionGranted: boolean };
        }[]
      >`SELECT lyraseo_observation_binding.prepare_fixture(${input.operationId}::text,${input.fence}::integer,${input.step}::text,${input.expectedRevision}::integer,${panel}::jsonb,${frozen.promptId}::text,${frozen.promptVersion}::text,${fixture.profile}::text,${scenario}::text,${input.requestHash}::text) AS value`;
      if (!row) throw Error("LEDGER_RESPONSE_UNAVAILABLE");
      return row.value;
    },
    record(attemptId, key, evidence) {
      return recordAttemptEvidence(db, attemptId, key, evidence);
    },
  };
}
