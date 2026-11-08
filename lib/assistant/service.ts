import { GoogleGenAI } from "@google/genai";
import { createClient } from "@/lib/supabase/server";

const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
  throw new Error("GEMINI_API_KEY is missing from environment variables.");
}

const ai = new GoogleGenAI({ apiKey });
const MODEL = "gemini-3.6-flash";

async function executeAssistantTool(
  userId: string,
  toolName: string,
  args: Record<string, any>
) {
  const supabase = await createClient();

  switch (toolName) {
    case "getFinancialSummary": {
      const { data: txns } = await supabase
        .from("transactions")
        .select("direction, amount, status")
        .eq("user_id", userId)
        .eq("status", "completed");

      let totalDebits = 0;
      let totalCredits = 0;

      (txns || []).forEach((t) => {
        if (t.direction === "debit") totalDebits += Number(t.amount);
        if (t.direction === "credit") totalCredits += Number(t.amount);
      });

      const { data: goals } = await supabase
        .from("savings_goals")
        .select(`
          title,
          target_amount,
          status,
          contributions:goal_contributions(amount, contribution_status)
        `)
        .eq("user_id", userId);

      const goalsSummary = (goals || []).map((g: any) => {
        const saved = (g.contributions || [])
          .filter((c: any) => c.contribution_status === "confirmed")
          .reduce((sum: number, c: any) => sum + Number(c.amount || 0), 0);
        return {
          title: g.title,
          targetAmount: g.target_amount,
          savedAmount: saved,
          status: g.status,
        };
      });

      const { data: expenseGroups } = await supabase
        .from("expense_groups")
        .select(`
          title,
          total_amount,
          shares:expense_shares(
            participant_name,
            amount_owed,
            repayments(amount, payment_status)
          )
        `)
        .eq("user_id", userId);

      return {
        totalDebits,
        totalCredits,
        netCashflow: totalCredits - totalDebits,
        activeSavingsGoals: goalsSummary,
        activeSharedExpenses: expenseGroups || [],
      };
    }

    case "getRecentTransactions": {
      const limit = Math.min(Number(args.limit || 10), 25);
      const { data } = await supabase
        .from("transactions")
        .select("id, amount, direction, merchant_name, description, occurred_at, status, payment_provider")
        .eq("user_id", userId)
        .order("occurred_at", { ascending: false })
        .limit(limit);

      return data || [];
    }

    case "getSpendingByMerchant": {
      const { data } = await supabase
        .from("transactions")
        .select("merchant_name, amount")
        .eq("user_id", userId)
        .eq("direction", "debit")
        .eq("status", "completed");

      const spending: Record<string, number> = {};
      (data || []).forEach((t) => {
        const key = t.merchant_name || "Uncategorized / Other";
        spending[key] = (spending[key] || 0) + Number(t.amount);
      });

      return spending;
    }

    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

/**
 * Ask the Financial Assistant a read-only query.
 * Persists user conversation and assistant answers into ai_conversations and ai_messages.
 */
export async function queryFinancialAssistant(
  userId: string,
  question: string,
  conversationId?: string
) {
  const supabase = await createClient();

  let convId = conversationId;

  // Retrieve or create conversation record in ai_conversations
  if (!convId) {
    const { data: conv, error: convErr } = await supabase
      .from("ai_conversations")
      .insert({
        user_id: userId,
        title: question.slice(0, 50),
      })
      .select("id")
      .single();

    if (!convErr && conv) {
      convId = conv.id;
    }
  }

  // Gather facts using restricted tools
  const summary = await executeAssistantTool(userId, "getFinancialSummary", {});
  const recentTxns = await executeAssistantTool(userId, "getRecentTransactions", { limit: 10 });
  const merchantSpending = await executeAssistantTool(userId, "getSpendingByMerchant", {});

  const prompt = `
You are Ledger's AI Financial Assistant.
You have read-only access to the user's verified financial data below.

RESTRICTIONS & SECURITY:
- You CANNOT execute payments or financial transfers.
- You CANNOT modify any records.
- Answer user queries accurately and helpfully based strictly on the provided context.
- Be concise, clear, and highlight actionable financial insights.
- Currency is in INR (₹) unless indicated otherwise.

USER FINANCIAL CONTEXT:
1. Financial Summary:
${JSON.stringify(summary, null, 2)}

2. Top Spending by Merchant:
${JSON.stringify(merchantSpending, null, 2)}

3. Recent Transactions:
${JSON.stringify(recentTxns, null, 2)}

USER QUESTION:
${question}
`;

  // Log user message into ai_messages
  if (convId) {
    await supabase.from("ai_messages").insert({
      conversation_id: convId,
      user_id: userId,
      role: "user",
      content: question,
      metadata: {},
    });
  }

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
  });

  const answer = response.text || "I was unable to analyze your financial data.";

  // Log assistant response into ai_messages
  if (convId) {
    await supabase.from("ai_messages").insert({
      conversation_id: convId,
      user_id: userId,
      role: "assistant",
      content: answer,
      metadata: {},
    });
  }

  return {
    conversationId: convId,
    answer,
  };
}
