import { expect, it } from "vitest";
import {
  computePresence,
  computeShareOfVoice,
} from "../../packages/visibility/src/metrics";
it("excludes failures and shows uncertainty without counting it as absence", () => {
  expect(computePresence([true, false, null], 1)).toEqual({
    numerator: 1,
    denominator: 2,
    uncertain: 1,
    unavailable: 1,
    rate: 0.5,
  });
});
it("returns no rate when every extraction is unknown", () =>
  expect(computePresence([null], 0).rate).toBeNull());
it("counts each brand once in an answer and keeps no-brand answers visible", () => {
  expect(
    computeShareOfVoice(
      [
        { A: true, B: true },
        { A: true, B: false },
        { A: false, B: false },
      ],
      ["A", "B"],
    ),
  ).toEqual({
    shares: { A: 2 / 3, B: 1 / 3 },
    noBrand: 1,
    uncertain: 0,
    answers: 3,
  });
});
it("does not claim a share of voice when no brand appears", () =>
  expect(
    computeShareOfVoice([{ A: false, B: false }], ["A", "B"]).shares,
  ).toEqual({ A: null, B: null }));
it("excludes ambiguous whole answers from share-of-voice math", () => {
  const r = computeShareOfVoice([{ A: true, B: null }], ["A", "B"]);
  expect(r.uncertain).toBe(1);
  expect(r.shares.A).toBeNull();
});
