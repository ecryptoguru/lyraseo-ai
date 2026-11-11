import { spawnSync } from "node:child_process";

// Each case provisions and removes its own random local database. Run all of
// them even if a caller has selected a different case in their environment.
const cases = [
  "allocation",
  "authority",
  "rotation",
  "resolution",
  "timezone",
  "budget",
];
for (const reviewCase of cases) {
  console.log(`\nRequired staff job review case: ${reviewCase}`);
  const result = spawnSync(
    process.execPath,
    ["scripts/test-staff-job-control.mjs"],
    {
      stdio: "inherit",
      env: { ...process.env, LYRA_STAFF_JOB_REVIEW_CASE: reviewCase },
    },
  );
  if (result.status !== 0) {
    if (result.error) console.error(result.error);
    throw Error(`STAFF_JOB_REVIEW_CASE_FAILED: ${reviewCase}`);
  }
}
console.log("PASS all six required staff job review cases");
