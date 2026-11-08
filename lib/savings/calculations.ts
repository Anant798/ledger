export type ContributionLike = { amount: number | string | null; contribution_status: string };
export function calculateSavingsProgress(target: number, contributions: ContributionLike[]) {
  const confirmed = contributions.filter((item) => item.contribution_status === "confirmed");
  const currentAmount = confirmed.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  return { currentAmount, progressPercent: target > 0 ? Math.min(Number((currentAmount / target * 100).toFixed(2)), 100) : 0, isGoalMet: currentAmount >= target, confirmedContributionCount: confirmed.length };
}
