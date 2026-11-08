import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
type Contribution = { contribution_status: string; amount: number | string | null };
import {
  CreateSavingsGoalInput,
  UpdateSavingsGoalInput,
  AddContributionInput,
} from "./validation";

export class SavingsService {
  /**
   * List all savings goals for user with confirmed total and progress
   */
  static async list(userId: string) {
    const supabase = await createClient();

    const { data: goals, error } = await supabase
      .from("savings_goals")
      .select(`
        *,
        contributions:goal_contributions(*)
      `)
      .eq("user_id", userId)
      .order("created_at", { ascending: false });

    if (error) throw error;

    const enriched = (goals || []).map((goal) => {
      const contributions: Contribution[] = (goal.contributions || []).filter((c: Contribution) => c.contribution_status === "confirmed");
      // Only confirmed contributions count
      const confirmedAmount = contributions
        .reduce((sum: number, c: Contribution) => sum + Number(c.amount || 0), 0);

      const targetAmount = Number(goal.target_amount);
      const progressPercent =
        targetAmount > 0
          ? Math.min(Number(((confirmedAmount / targetAmount) * 100).toFixed(2)), 100)
          : 0;

      return {
        ...goal,
        current_amount: confirmedAmount,
        progressPercent,
        isGoalMet: confirmedAmount >= targetAmount,
        totalContributionsCount: contributions.length,
      };
    });

    return enriched;
  }

  /**
   * Get single savings goal with contribution history
   */
  static async getById(userId: string, goalId: string) {
    const supabase = await createClient();

    const { data: goal, error } = await supabase
      .from("savings_goals")
      .select(`
        *,
        contributions:goal_contributions(*)
      `)
      .eq("id", goalId)
      .eq("user_id", userId)
      .single();

    if (error) throw error;

    const contributions: Contribution[] = (goal.contributions || []).filter((c: Contribution) => c.contribution_status === "confirmed");
    const confirmedAmount = contributions.reduce(
      (sum: number, c: Contribution) => sum + Number(c.amount || 0),
      0
    );

    const targetAmount = Number(goal.target_amount);

    return {
      ...goal,
      current_amount: confirmedAmount,
      progressPercent:
        targetAmount > 0
          ? Math.min(Number(((confirmedAmount / targetAmount) * 100).toFixed(2)), 100)
          : 0,
      isGoalMet: confirmedAmount >= targetAmount,
    };
  }

  /**
   * Create a new savings goal
   */
  static async create(userId: string, input: CreateSavingsGoalInput) {
    const supabase = await createClient();

    const { data, error } = await supabase
      .from("savings_goals")
      .insert({
        ...input,
        user_id: userId,
      })
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  /**
   * Update goal details
   */
  static async update(userId: string, goalId: string, input: UpdateSavingsGoalInput) {
    const supabase = await createClient();

    const { data, error } = await supabase
      .from("savings_goals")
      .update({
        ...input,
        updated_at: new Date().toISOString(),
      })
      .eq("id", goalId)
      .eq("user_id", userId)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  /**
   * Add manual contribution.
   * Satisfies existing RLS policy:
   * (auth.uid() = user_id) AND (contribution_status = 'confirmed') AND (contribution_source = 'manual')
   */
  static async addManualContribution(userId: string, input: AddContributionInput) {
    const supabase = await createClient();

    const { data, error } = await supabase
      .from("goal_contributions")
      .insert({
        goal_id: input.goal_id,
        user_id: userId,
        amount: input.amount,
        contribution_source: "manual",
        contribution_status: "confirmed",
        notes: input.notes || null,
        contributed_at: input.contributed_at || new Date().toISOString(),
      })
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  /**
   * Add automated contribution via backend service.
   * Uses backend service-role admin client to safely write contribution_source = 'automated'
   * without violating or weakening client RLS policies.
   */
  static async addAutomatedContribution(
    userId: string,
    goalId: string,
    amount: number,
    notes?: string
  ) {
    const adminSupabase = createAdminClient();

    // Verify goal belongs to user
    const { data: goal, error: goalErr } = await adminSupabase
      .from("savings_goals")
      .select("id, user_id")
      .eq("id", goalId)
      .eq("user_id", userId)
      .single();

    if (goalErr || !goal) {
      throw new Error("Goal not found or access denied.");
    }

    const { data, error } = await adminSupabase
      .from("goal_contributions")
      .insert({
        goal_id: goalId,
        user_id: userId,
        amount,
        contribution_source: "automated",
        contribution_status: "confirmed",
        notes: notes || "Automated savings contribution from synced transaction",
        contributed_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) throw error;
    return data;
  }
}
