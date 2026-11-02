/** null is an uncertain extraction, never a measured absence. */
export function computePresence(
  values: readonly (boolean | null)[],
  unavailable: number,
) {
  if (!Number.isInteger(unavailable) || unavailable < 0)
    throw new Error("Invalid unavailable count.");
  const denominator = values.filter((value) => value !== null).length;
  const numerator = values.filter((value) => value === true).length;
  return {
    numerator,
    denominator,
    uncertain: values.length - denominator,
    unavailable,
    rate: denominator ? numerator / denominator : null,
  };
}
export function computeShareOfVoice(
  answers: readonly Readonly<Record<string, boolean | null>>[],
  brands: readonly string[],
) {
  if (!brands.length || new Set(brands).size !== brands.length)
    throw new Error("Choose unique brands.");
  const totals: Record<string, number> = Object.fromEntries(
    brands.map((b) => [b, 0]),
  );
  let uncertain = 0,
    noBrand = 0,
    slots = 0,
    valid = 0;
  for (const answer of answers) {
    if (brands.some((b) => typeof answer[b] !== "boolean")) {
      uncertain++;
      continue;
    }
    valid++;
    let positive = 0;
    for (const brand of brands)
      if (answer[brand]) {
        totals[brand] = (totals[brand] ?? 0) + 1;
        positive++;
      }
    slots += positive;
    if (!positive) noBrand++;
  }
  const shares: Record<string, number | null> = Object.fromEntries(
    brands.map((b) => [b, slots ? (totals[b] ?? 0) / slots : null]),
  );
  return { shares, noBrand, uncertain, answers: valid };
}
