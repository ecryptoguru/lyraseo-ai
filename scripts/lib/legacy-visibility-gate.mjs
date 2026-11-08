import assert from "node:assert/strict";
import { relative, resolve, sep } from "node:path";

// Read generated metadata as JSON data only; never evaluate generated code.
// A changed generator layout is an explicit gate failure, not a silent skip.
export function readRuntimeModel(source) {
  const matches = [
    ...source.matchAll(
      /config\.runtimeDataModel = JSON\.parse\(("(?:\\.|[^"\\])*")\)/g,
    ),
  ];
  assert.equal(
    matches.length,
    1,
    "VISIBILITY_PRISMA_MODEL_METADATA_MISSING_OR_DUPLICATE",
  );
  return JSON.parse(JSON.parse(matches[0][1]));
}

export function assertModelColumns(runtimeModel, columns) {
  assert(runtimeModel?.models && Object.keys(runtimeModel.models).length > 0);
  assert(Array.isArray(columns));
  const actual = new Set(
    columns.map(([table, column]) => `${table}\u0000${column}`),
  );
  for (const [modelName, model] of Object.entries(runtimeModel.models)) {
    assert(Array.isArray(model.fields));
    const table = model.dbName ?? modelName;
    for (const field of model.fields) {
      if (field.kind === "object") continue;
      const column = field.dbName ?? field.name;
      assert(
        actual.has(`${table}\u0000${column}`),
        `VISIBILITY_SCHEMA_MISSING_COLUMN: ${table}.${column}`,
      );
    }
  }
}

// Require every previously contracted security case by file and full name,
// while allowing additional passing cases to be introduced later.
export function assertVisibilityReceipt(report, required, root) {
  assert.equal(report?.success, true, "VISIBILITY_RECEIPT_UNSUCCESSFUL");
  assert.equal(report.numPendingTests, 0, "VISIBILITY_RECEIPT_PENDING");
  assert.equal(report.numFailedTests, 0, "VISIBILITY_RECEIPT_FAILED");
  assert(Array.isArray(report.testResults), "VISIBILITY_RECEIPT_MISSING_FILES");
  assert(
    Array.isArray(required) && required.length >= 29,
    "VISIBILITY_REQUIRED_CASES_INVALID",
  );
  const key = (file, name) => `${file}\u0000${name}`;
  const expected = required.map(({ file, name }) => key(file, name));
  assert.equal(
    new Set(expected).size,
    expected.length,
    "VISIBILITY_DUPLICATE_REQUIRED_CASE",
  );
  const actual = [];
  for (const result of report.testResults) {
    assert(
      typeof result.name === "string" && Array.isArray(result.assertionResults),
    );
    const file = relative(resolve(root), resolve(result.name))
      .split(sep)
      .join("/");
    assert(
      file.startsWith("tests/legacy-visibility/"),
      "VISIBILITY_UNEXPECTED_TEST_FILE",
    );
    for (const assertion of result.assertionResults) {
      assert.equal(assertion.status, "passed", "VISIBILITY_CASE_NOT_PASSED");
      assert(
        typeof assertion.fullName === "string" && assertion.fullName.length > 0,
      );
      actual.push(key(file, assertion.fullName));
    }
  }
  assert.equal(
    new Set(actual).size,
    actual.length,
    "VISIBILITY_DUPLICATE_CASE",
  );
  assert.equal(
    report.numTotalTests,
    actual.length,
    "VISIBILITY_RECEIPT_COUNT_MISMATCH",
  );
  assert.equal(
    report.numPassedTests,
    actual.length,
    "VISIBILITY_RECEIPT_PASS_MISMATCH",
  );
  const observed = new Set(actual);
  for (const expectedCase of expected)
    assert(
      observed.has(expectedCase),
      `VISIBILITY_CASE_MISSING: ${expectedCase}`,
    );
}
