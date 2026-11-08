export type ContributionLike = { amount: number | string | null; contribution_status: string };
export function calculateSavingsProgress(target: number, contributions: ContributionLike[]) {
  const confirmed = contributions.filter((item) => item.contribution_status === "confirmed");
  const currentAmount = confirmed.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const remainingAmount = Math.max(0, Number((target - currentAmount).toFixed(2)));
  return { currentAmount: Number(currentAmount.toFixed(2)), remainingAmount, progressPercent: target > 0 ? Math.min(Number((currentAmount / target * 100).toFixed(2)), 100) : 0, isGoalMet: currentAmount >= target, confirmedContributionCount: confirmed.length };
}

export function nextSavingsRun(from: Date, frequency: "weekly" | "monthly", dayOfMonth = from.getUTCDate()) {
  const next = new Date(from);
  if (frequency === "weekly") next.setUTCDate(next.getUTCDate() + 7);
  else {
    const year = next.getUTCFullYear();
    const month = next.getUTCMonth() + 1;
    const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    next.setUTCFullYear(year, month, Math.min(Math.max(dayOfMonth, 1), last));
  }
  return next;
}
