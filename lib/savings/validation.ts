import { z } from "zod";

export const createSavingsGoalSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(500).optional().nullable(),
  target_amount: z.number().positive().finite(),
  currency_code: z.string().default("INR"),
  target_date: z.string().date().optional().nullable(),
  status: z.enum(["active", "completed", "paused", "cancelled"]).default("active"),
});

export const updateSavingsGoalSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(500).optional().nullable(),
  target_amount: z.number().positive().finite().optional(),
  status: z.enum(["active", "completed", "paused", "cancelled"]).optional(),
  target_date: z.string().date().optional().nullable(),
});

export const addContributionSchema = z.object({
  goal_id: z.string().uuid(),
  amount: z.number().positive().finite(),
  notes: z.string().max(500).optional().nullable(),
  contributed_at: z.string().datetime({ offset: true }).optional(),
  transaction_id: z.string().uuid().optional(),
});

export const updateContributionSchema = z.object({
  amount: z.number().positive().finite().optional(),
  notes: z.string().max(500).optional().nullable(),
}).refine((value) => value.amount !== undefined || value.notes !== undefined, "Provide amount or notes");

export const savingsRuleSchema = z.object({
  amount: z.number().positive().finite(),
  frequency: z.enum(["weekly", "monthly"]),
  day_of_month: z.number().int().min(1).max(31).optional(),
  enabled: z.boolean().default(true),
});

export type CreateSavingsGoalInput = z.infer<typeof createSavingsGoalSchema>;
export type UpdateSavingsGoalInput = z.infer<typeof updateSavingsGoalSchema>;
export type AddContributionInput = z.infer<typeof addContributionSchema>;
export type UpdateContributionInput = z.infer<typeof updateContributionSchema>;
