import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const suite = "legacy inline R2 final composition and authority";
const requiredNames = [
  "revalidates audits and GSC when enrollment commits before-search",
  "revalidates audits and GSC when enrollment commits after-search",
  "retries instead of composing an audit whose exact status changed during GSC work",
  "holds final scope lock through payload construction before a waiting enrollment",
  "completes concurrent composed page reads with a max-one-connection pool",
  "authorizes revoked actors stale epochs nonowners and guessed IDs before revealing the fence",
]
  .map((title) => `${suite} ${title}`)
  .sort();

const requiredIssueNames = [
  "legacy inline issue-action boundary keeps cross-scope and missing IDs not-found and revoked actors forbidden without mutation",
  "legacy inline issue-action boundary rejects matching and guessed withheld rules before loading evaluation or mutating actions",
  "legacy inline issue-action boundary serializes an admitted unprotected review before enrollment commits",
  "legacy inline issue-action boundary waits for enrollment and rechecks retained authority before revealing withholding",
  "legacy inline issue-action boundary waits for enrollment and rechecks revoked authority before revealing withholding",
];

export function runDirectory(root, id) {
  assert.match(
    id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  return resolve(root, "output/legacy-inline", `run-${id}`);
}

export function createRunDirectory(root, id = randomUUID()) {
  const output = runDirectory(root, id);
  mkdirSync(dirname(output), { recursive: true });
  // Exclusive creation rejects reused IDs before any DB work or receipt writes.
  mkdirSync(output, { mode: 0o700 });
  return output;
}

export function verifyRequiredServices(results, root) {
  assert.equal(results.success, true);
  assert.equal(results.numTotalTests, 27);
  assert.equal(results.numPassedTests, 27);
  assert.equal(
    results.numPendingTests,
    0,
    "Required service gate must not skip any case",
  );
  const files = results.testResults.filter(
    (file) =>
      file.name === resolve(root, "tests/integration/legacy-inline-r2.test.ts"),
  );
  assert.equal(files.length, 1, "Expected exactly one required R2 test file");
  const cases = files[0].assertionResults;
  assert.deepEqual(
    cases.map((test) => test.fullName).sort(),
    requiredNames,
    "Expected exactly the six named R2 security cases",
  );
  assert(
    cases.every((test) => test.status === "passed"),
    "All six required R2 security cases must pass",
  );
  const issueFiles = results.testResults.filter(
    (file) =>
      file.name ===
      resolve(root, "tests/integration/legacy-inline-issue-actions.test.ts"),
  );
  assert.equal(
    issueFiles.length,
    1,
    "Expected exactly one required issue-action test file",
  );
  const issueCases = issueFiles[0].assertionResults;
  assert.deepEqual(
    issueCases.map((test) => test.fullName).sort(),
    requiredIssueNames,
    "Expected exactly the five named issue-action security cases",
  );
  assert(
    issueCases.every((test) => test.status === "passed"),
    "All five required issue-action security cases must pass",
  );
  return {
    redMode: false,
    passed: results.numPassedTests,
    pending: results.numPendingTests,
    issueCases: issueCases.map((test) => ({
      name: test.fullName,
      status: test.status,
    })),
    r2Cases: cases.map((test) => ({
      name: test.fullName,
      status: test.status,
    })),
  };
}
