import { expect, it } from "vitest";
import {
  extractBrands,
  matchesDomain,
  summarizeAnswers,
  compareWindows,
  type Answer,
} from "../../packages/visibility/src/measurement";
const brands = [
  { id: "a", name: "Alpha", aliases: ["Alpha"], domains: ["alpha.com"] },
  { id: "b", name: "Beta", aliases: ["Beta"], domains: ["beta.com"] },
];
it("normalizes whole phrases and excludes lookalike domains and source-list-only URLs", () => {
  expect(extractBrands("ＡＬＰＨＡ and Alphabet", [], brands).a?.mention).toBe(
    true,
  );
  expect(extractBrands("Alphabet", [], brands).a?.mention).toBe(false);
  expect(matchesDomain("https://alpha.com.evil", "alpha.com")).toBe(false);
  expect(matchesDomain("https://docs.alpha.com/x", "alpha.com")).toBe(true);
  expect(extractBrands("Alpha", [], brands).a?.citation).toBe(false);
  expect(
    extractBrands(
      "Alpha",
      [{ url: "https://alpha.com", start: 0, end: 5 }],
      brands,
    ).a?.citation,
  ).toBe(true);
});
it("keeps ambiguous aliases unknown and recommendations unproven", () => {
  const r = extractBrands(
    "Alpha",
    [],
    [brands[0]!, { ...brands[1]!, aliases: ["alpha"] }],
  );
  expect(r.a?.mention).toBeNull();
  expect(r.b?.mention).toBeNull();
  expect(r.a?.recommendation).toBeNull();
});
it("distinguishes zero, unavailable and uncertain with same-answer competitors", () => {
  const answers: Answer[] = [
    {
      promptId: "p",
      state: "successful",
      extraction: extractBrands("Alpha Beta", [], brands),
    },
    {
      promptId: "q",
      state: "successful",
      extraction: extractBrands("nothing", [], brands),
    },
    { promptId: "r", state: "failed", extraction: {} },
  ];
  const s = summarizeAnswers(answers, ["a", "b"]);
  expect(s.brands.a?.mention).toMatchObject({
    numerator: 1,
    denominator: 2,
    unavailable: 1,
    rate: 0.5,
  });
  expect(s.shareOfVoice.shares.a).toBe(0.5);
  expect(s.shareOfVoice.noBrand).toBe(1);
  expect(
    summarizeAnswers([answers[1]!], ["a", "b"]).shareOfVoice.shares.a,
  ).toBeNull();
});
it("requires common prompts coverage equal durations and identical cohort", () => {
  const answers: Answer[] = Array.from({ length: 10 }, (_, i) => ({
    promptId: `p${i}`,
    state: "successful",
    extraction: extractBrands(i % 2 ? "Alpha" : "none", [], brands),
  }));
  const w = {
    cohort: "same",
    start: "2026-01-01",
    end: "2026-01-08",
    planned: 10,
    answers,
  };
  expect(compareWindows(w, w, "a")).toMatchObject({
    eligible: true,
    percentagePointChange: 0,
  });
  expect(compareWindows(w, { ...w, cohort: "changed" }, "a").eligible).toBe(
    false,
  );
  expect(compareWindows(w, { ...w, planned: 13 }, "a").eligible).toBe(false);
  expect(
    compareWindows(w, { ...w, answers: answers.slice(0, 9) }, "a").eligible,
  ).toBe(false);
});
it("shows pooled and equal-prompt rates separately for uneven repetitions", () => {
  const answers: Answer[] = Array.from({ length: 10 }, (_, i) => ({
    promptId: `p${i}`,
    state: "successful",
    extraction: extractBrands(i === 0 ? "Alpha" : "none", [], brands),
  }));
  const repeated = [
    ...answers,
    ...Array.from({ length: 9 }, () => answers[0]!),
  ];
  const w = {
    cohort: "same",
    start: "2026-01-01",
    end: "2026-01-08",
    planned: 19,
    answers: repeated,
  };
  const result = compareWindows(w, w, "a");
  expect(result.eligible).toBe(true);
  if (result.eligible) {
    expect(result.current.rate).toBe(0.1);
    expect(result.current.pooled.rate).toBe(10 / 19);
  }
});
it("extracts domains in answer body and routes overlapping aliases to review", () => {
  expect(
    extractBrands("Use https://alpha.com/docs", [], brands).a?.mention,
  ).toBe(true);
  const overlapping = [brands[0]!, { ...brands[1]!, aliases: ["Alpha Beta"] }];
  expect(extractBrands("Alpha Beta", [], overlapping).a?.mention).toBeNull();
  expect(extractBrands("Alpha Beta", [], overlapping).b?.mention).toBeNull();
});
