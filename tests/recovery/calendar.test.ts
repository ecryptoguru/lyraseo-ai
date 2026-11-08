import { afterAll, expect, it } from "vitest";
import { createDatabase } from "../../packages/db/src";
import { addMonthsClamped } from "../../packages/db/src/retention";
const database = process.env.LYRA_RECOVERY_DB;
if (!/^lyraseo_recovery_[a-f0-9]{12}$/.test(database ?? ""))
  throw Error("OWNED_RECOVERY_DATABASE_REQUIRED");
const db = createDatabase(
  `postgresql://lyraseo_artifact_maintenance:local_expiry_only@127.0.0.1:54329/${database}`,
);
afterAll(() => db.$disconnect());
it("matches forward UTC month-clamping and exact expiry across leap years, month ends and session timezones", async () => {
  const anchors = [
    "2023-01-29T12:45:56.789Z",
    "2023-01-30T12:45:56.789Z",
    "2023-01-31T12:45:56.789Z",
    "2024-01-29T12:45:56.789Z",
    "2024-01-30T12:45:56.789Z",
    "2024-01-31T12:45:56.789Z",
    "2026-03-31T12:45:56.789Z",
    "2024-02-29T23:59:59.999Z",
  ];
  for (const zone of ["UTC", "Asia/Kolkata", "America/New_York"]) {
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('TimeZone',${zone},true)`;
      for (const anchor of anchors) {
        const [row] = await tx.$queryRaw<
          Array<{
            expiry: string;
            before: boolean;
            exact: boolean;
            after: boolean;
          }>
        >`WITH e AS (SELECT (${anchor}::timestamptz AT TIME ZONE 'UTC')+interval '13 months' expiry)
      SELECT to_char(expiry,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') expiry,(expiry-interval '1 millisecond')<expiry before,expiry<expiry exact,(expiry+interval '1 millisecond')<expiry after FROM e`;
        expect(row).toEqual({
          expiry: addMonthsClamped(new Date(anchor), 13).toISOString(),
          before: true,
          exact: false,
          after: false,
        });
      }
    });
  }
});
