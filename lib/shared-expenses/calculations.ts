export type RepaymentLike = { amount: number | string | null; payment_status: string };
export function calculateShareBalance(amountOwed: number, repayments: RepaymentLike[]) {
  const confirmedRepayments = repayments.filter((repayment) => repayment.payment_status === "confirmed");
  const totalRepaid = confirmedRepayments.reduce((sum, repayment) => sum + Number(repayment.amount || 0), 0);
  const outstandingBalance = Math.max(0, amountOwed - totalRepaid);
  return { totalRepaid, outstandingBalance, isSettled: outstandingBalance <= 0.01, settlementHistory: confirmedRepayments };
}

export function calculateExpenseGroupBalance(shares: Array<{
  amount_owed: number | string | null;
  participant_type?: string | null;
  is_active?: boolean | null;
  repayments?: RepaymentLike[];
}>) {
  const activeShares = shares.filter((share) => share.is_active !== false);
  const debtShares = activeShares.filter((share) => share.participant_type !== "owner");
  const totalOwed = debtShares.reduce((sum, share) => sum + Number(share.amount_owed || 0), 0);
  const totalRepaid = debtShares.reduce((sum, share) => sum + calculateShareBalance(Number(share.amount_owed || 0), share.repayments || []).totalRepaid, 0);
  const outstandingBalance = Math.max(0, totalOwed - totalRepaid);

  return {
    totalOwed,
    totalRepaid,
    outstandingBalance,
    isFullySettled: outstandingBalance <= 0.01,
  };
}

export function calculateSplit(total: number, method: "equal" | "custom" | "percentage", amounts: number[]) {
  if (method === "custom") return amounts;
  if (method === "percentage") return amounts.map((percent, index) => index === amounts.length - 1
    ? Number((total - amounts.slice(0, -1).reduce((sum, p) => sum + Number((total * p / 100).toFixed(2)), 0)).toFixed(2))
    : Number((total * amounts[index] / 100).toFixed(2)));
  const cents = Math.round(total * 100);
  const each = Math.floor(cents / amounts.length);
  return amounts.map((_, index) => index === amounts.length - 1 ? (cents - each * (amounts.length - 1)) / 100 : each / 100);
}
