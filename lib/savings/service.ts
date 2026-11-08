import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
type Contribution = { contribution_status: string; amount: number | string | null };
import {
  CreateSavingsGoalInput,
  UpdateSavingsGoalInput,
  AddContributionInput,
} from "./validation";
import { calculateSavingsProgress, nextSavingsRun } from "./calculations";

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
        contributions:goal_contributions(*, events:savings_contribution_events(*))
      `)
      .eq("user_id", userId)
      .is("deleted_at", null)
      .order("created_at", { ascending: false });

    if (error) throw error;

    const enriched = (goals || []).map((goal) => {
      const allContributions: Contribution[] = goal.contributions || [];
      const progress = calculateSavingsProgress(Number(goal.target_amount), allContributions);

      return {
        ...goal,
        ...progress,
        current_amount: progress.currentAmount,
        totalContributionsCount: progress.confirmedContributionCount,
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
        contributions:goal_contributions(*, events:savings_contribution_events(*))
      `)
      .eq("id", goalId)
      .eq("user_id", userId)
      .is("deleted_at", null)
      .single();

    if (error) throw error;

    const progress = calculateSavingsProgress(Number(goal.target_amount), goal.contributions || []);

    return {
      ...goal,
      ...progress,
      current_amount: progress.currentAmount,
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
    const shouldComplete = input.status === "completed";
    if (shouldComplete) {
      const current = await this.getById(userId, goalId);
      if (!current?.isGoalMet) throw new Error("Goal cannot be completed before confirmed contributions reach the target.");
    }
    const details = { ...input };
    if (shouldComplete) delete details.status;

    const { data, error } = await supabase
      .from("savings_goals")
      .update({
        ...details,
        updated_at: new Date().toISOString(),
      })
      .eq("id", goalId)
      .eq("user_id", userId)
      .is("deleted_at", null)
      .select()
      .single();

    if (error) throw error;
    if (shouldComplete) await this.complete(userId, goalId);
    return data;
  }

  static async delete(userId: string, goalId: string) {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("archive_savings_goal", { p_user_id: userId, p_goal_id: goalId });
    if (error) throw error;
    return data;
  }

  static async complete(userId: string, goalId: string) {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("complete_savings_goal", { p_user_id: userId, p_goal_id: goalId });
    if (error) throw error;
    return data;
  }

  static async updateContribution(userId: string, contributionId: string, input: { amount?: number; notes?: string | null }) {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("update_savings_contribution", {
      p_user_id: userId, p_contribution_id: contributionId,
      p_amount: input.amount ?? null, p_notes: input.notes ?? null,
      p_update_notes: Object.hasOwn(input, "notes"),
    });
    if (error) throw error;
    return data;
  }

  static async reverseContribution(userId: string, contributionId: string, reason?: string) {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("reverse_savings_contribution", {
      p_user_id: userId, p_contribution_id: contributionId, p_reason: reason || null,
    });
    if (error) throw error;
    return data;
  }

  static async listRules(userId: string, goalId: string) {
    const supabase = await createClient();
    const { data, error } = await supabase.from("savings_goal_rules").select("*").eq("user_id", userId).eq("goal_id", goalId).order("created_at");
    if (error) throw error;
    return data || [];
  }

  static async saveRule(userId: string, goalId: string, input: { amount: number; frequency: "weekly" | "monthly"; day_of_month?: number; enabled: boolean }, ruleId?: string) {
    const supabase = await createClient();
    const nextRun = nextSavingsRun(new Date(), input.frequency, input.day_of_month).toISOString();
    const { data, error } = ruleId
      ? await supabase.from("savings_goal_rules").update({ ...input, next_run_at: nextRun, updated_at: new Date().toISOString() }).eq("id", ruleId).eq("user_id", userId).eq("goal_id", goalId).select().single()
      : await supabase.from("savings_goal_rules").insert({ ...input, user_id: userId, goal_id: goalId, next_run_at: nextRun }).select().single();
    if (error) throw error;
    return data;
  }

  static async deleteRule(userId: string, goalId: string, ruleId: string) {
    const supabase = await createClient();
    const { error } = await supabase.from("savings_goal_rules").delete().eq("id", ruleId).eq("user_id", userId).eq("goal_id", goalId);
    if (error) throw error;
  }

  /**
   * Add manual contribution.
   * Satisfies existing RLS policy:
   * (auth.uid() = user_id) AND (contribution_status = 'confirmed') AND (contribution_source = 'manual')
   */
  static async addManualContribution(userId: string, input: AddContributionInput) {
    const supabase = await createClient();

    if (input.transaction_id) {
      const { data, error } = await supabase.rpc("add_transaction_goal_contribution", {
        p_user_id: userId,
        p_goal_id: input.goal_id,
        p_transaction_id: input.transaction_id,
        p_amount: input.amount,
        p_notes: input.notes || null,
      });
      if (error) throw error;
      return data;
    }

    const { data, error } = await supabase.rpc("record_manual_goal_contribution", {
      p_user_id: userId, p_goal_id: input.goal_id, p_amount: input.amount,
      p_notes: input.notes || null, p_contributed_at: input.contributed_at || new Date().toISOString(),
    });
    if (error) throw error;
    return data;
  }

  /**
   * Add automated contribution via backend service.
   * Uses backend service-role admin client to safely write contribution_source = 'automatic'
   * without violating or weakening client RLS policies.
   */
  static async addAutomatedContribution(
    userId: string,
    goalId: string,
    amount: number,
    notes?: string,
    idempotencyKey?: string
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

    if (!idempotencyKey || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotencyKey)) throw new Error("Automated contributions require a valid source transaction UUID as idempotency key.");
    const { data, error } = await adminSupabase.rpc("add_automated_goal_contribution", {
      p_user_id: userId, p_goal_id: goalId, p_amount: amount,
      p_notes: notes || "Automated savings contribution from synced transaction",
      p_idempotency_key: idempotencyKey,
    });
    if (error) throw error;
    return data;
  }
}
