/** Result clocks are calendar months; source and editorial history clocks are elapsed UTC days. */
export const retention = {
  resultMonths: 13,
  pageDays: 30,
  answerDays: 90,
  revisionDays: 90,
} as const;
export function addMonthsClamped(anchor: Date, months: number) {
  const result = new Date(anchor);
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const end = new Date(result);
  end.setUTCMonth(end.getUTCMonth() + 1, 0);
  result.setUTCDate(Math.min(anchor.getUTCDate(), end.getUTCDate()));
  return result;
}
export function fixedDays(anchor: Date, days: number) {
  return new Date(anchor.getTime() + days * 86400000);
}
export function readable(
  now: Date,
  expiresAt: Date | string | null | undefined,
) {
  return expiresAt != null && new Date(expiresAt).getTime() > now.getTime();
}
