/** Assign a conservative dashboard category from bank-provided text. */
export function classifyBankTransaction(input: { merchant?: string | null; description?: string | null; direction?: string | null }) {
  const text = `${input.merchant || ""} ${input.description || ""}`.toLowerCase();
  if (input.direction === "credit" && /salary|payroll|stipend/.test(text)) return "Salary";
  if (/grocery|supermarket|mart|zepto|blinkit|bigbasket|swiggy instamart/.test(text)) return "Groceries";
  if (/restaurant|cafe|coffee|food|swiggy|zomato|domino/.test(text)) return "Food & dining";
  if (/uber|ola|rapido|metro|railway|irctc|fuel|petrol|diesel/.test(text)) return "Transport";
  if (/electricity|water bill|gas bill|broadband|internet|mobile recharge|telecom/.test(text)) return "Bills & utilities";
  if (/amazon|flipkart|myntra|ajio|shopping|retail/.test(text)) return "Shopping";
  if (/hospital|clinic|pharmacy|medical|health/.test(text)) return "Healthcare";
  if (/netflix|spotify|youtube|hotstar|subscription/.test(text)) return "Subscriptions";
  if (input.direction === "credit") return "Income";
  return "Uncategorized";
}
