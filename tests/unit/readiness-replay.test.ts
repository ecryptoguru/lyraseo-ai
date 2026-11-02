import { expect, it } from "vitest";
import { sampleEvidence } from "../../apps/lyraseo-web/src/lib/sample";
import { evaluateAudit } from "../../packages/visibility/src";
it.each([false, true])("replays the frozen v1 sample, fixed=%s", (fixed) => {
  expect(
    JSON.parse(JSON.stringify(evaluateAudit(sampleEvidence(fixed)))),
  ).toMatchSnapshot();
});
