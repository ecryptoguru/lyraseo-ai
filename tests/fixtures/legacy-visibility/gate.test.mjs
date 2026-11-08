import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  assertModelColumns,
  assertVisibilityReceipt,
  readRuntimeModel,
} from "../../../scripts/lib/legacy-visibility-gate.mjs";

const root = resolve(import.meta.dirname, "../../..");
const required = JSON.parse(
  readFileSync(
    resolve(root, "tests/fixtures/legacy-visibility/required-cases.json"),
    "utf8",
  ),
);
function valid() {
  const files = new Map();
  for (const { file, name } of required) {
    const entry = files.get(file) ?? [];
    entry.push({ fullName: name, status: "passed" });
    files.set(file, entry);
  }
  return {
    success: true,
    numTotalTests: required.length,
    numPassedTests: required.length,
    numPendingTests: 0,
    numFailedTests: 0,
    testResults: [...files].map(([name, assertionResults]) => ({
      name: resolve(root, name),
      assertionResults,
    })),
  };
}
test("accepts exactly the required visibility checks", () => {
  assert.doesNotThrow(() => assertVisibilityReceipt(valid(), required, root));
});
test("rejects missing, skipped, renamed and duplicate required checks", () => {
  for (const change of [
    (r) => r.testResults[0].assertionResults.pop(),
    (r) => (r.testResults[0].assertionResults[0].status = "pending"),
    (r) => (r.testResults[0].assertionResults[0].fullName = "replacement"),
    (r) =>
      r.testResults[0].assertionResults.push(
        r.testResults[0].assertionResults[0],
      ),
    (r) =>
      (r.testResults[0].name = resolve(
        root,
        "tests/legacy-visibility/wrong.test.ts",
      )),
  ]) {
    const report = valid();
    change(report);
    assert.throws(() => assertVisibilityReceipt(report, required, root));
  }
});
test("rejects inconsistent aggregates and pending extra tests", () => {
  for (const change of [
    (r) => (r.success = false),
    (r) => (r.numPendingTests = 1),
    (r) => (r.numPassedTests -= 1),
    (r) =>
      r.testResults[0].assertionResults.push({
        fullName: "new case",
        status: "pending",
      }),
  ]) {
    const report = valid();
    change(report);
    assert.throws(() => assertVisibilityReceipt(report, required, root));
  }
});
test("requires each generated model column in the assembled database", () => {
  const model = {
    models: {
      Workspace: {
        dbName: null,
        fields: [
          { name: "id", kind: "scalar" },
          { name: "accessRevision", kind: "scalar" },
          { name: "memberships", kind: "object" },
        ],
      },
    },
  };
  const columns = [
    ["Workspace", "id"],
    ["Workspace", "accessRevision"],
  ];
  assert.doesNotThrow(() => assertModelColumns(model, columns));
  assert.throws(
    () => assertModelColumns(model, columns.slice(0, 1)),
    /Workspace\.accessRevision/,
  );
  assert.throws(() => assertModelColumns({ models: {} }, columns));
});
test("fails closed if generated Prisma model metadata is absent or duplicated", () => {
  const encoded = JSON.stringify(
    JSON.stringify({ models: { Workspace: { fields: [] } } }),
  );
  const source = `config.runtimeDataModel = JSON.parse(${encoded})`;
  assert.ok(readRuntimeModel(source).models.Workspace);
  assert.throws(() => readRuntimeModel("missing"));
  assert.throws(() => readRuntimeModel(source + "\n" + source));
});
