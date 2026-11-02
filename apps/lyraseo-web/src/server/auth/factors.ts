export type FactorChoice = {
  id: string;
  status: string;
  friendly_name?: string;
};
export function chooseVerifiedFactor(
  factors: FactorChoice[],
  selected: string,
) {
  const verified = factors.filter((f) => f.status === "verified");
  return selected
    ? verified.find((f) => f.id === selected)
    : verified.length === 1
      ? verified[0]
      : undefined;
}
