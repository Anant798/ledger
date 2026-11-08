import { z } from "zod";

export const participantShareSchema = z.object({
  participant_name: z.string().min(1).max(100),
  participant_type: z.enum(["self", "contact", "external"]).default("external"),
  email: z.string().email().optional().nullable(),
  phone_number: z.string().max(20).optional().nullable(),
  user_id: z.string().uuid().optional().nullable(),
  amount_owed: z.number().nonnegative().optional(),
});

export const createExpenseGroupSchema = z.object({
  title: z.string().min(1).max(200),
  total_amount: z.number().positive().finite(),
  currency_code: z.string().default("INR"),
  split_method: z.enum(["equal", "custom", "percentage"]).default("equal"),
  transaction_id: z.string().uuid().optional().nullable(),
  participants: z.array(participantShareSchema).min(1),
}).superRefine((data, ctx) => {
  if (data.split_method === "custom") {
    const sum = data.participants.reduce(
      (acc, p) => acc + (p.amount_owed || 0),
      0
    );
    if (Math.abs(sum - data.total_amount) > 0.05) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Sum of participant amounts (${sum.toFixed(2)}) must equal total amount (${data.total_amount.toFixed(2)})`,
        path: ["participants"],
      });
    }
  }
  if (data.split_method === "percentage") {
    const sum = data.participants.reduce((acc, p) => acc + (p.amount_owed || 0), 0);
    if (Math.abs(sum - 100) > 0.01) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Participant percentages must total 100", path: ["participants"] });
  }
});

export const recordRepaymentSchema = z.object({
  expense_share_id: z.string().uuid(),
  amount: z.number().positive().finite(),
  currency_code: z.string().default("INR"),
  payment_method: z.string().max(50).default("upi"),
  payment_provider: z.string().max(100).optional().nullable(),
  external_reference: z.string().max(100).optional().nullable(),
  idempotency_key: z.string().uuid().optional(),
});

export const reminderSettingSchema = z.object({
  enabled: z.boolean(),
  initial_message_enabled: z.boolean().default(true),
  frequency_hours: z.number().int().min(1).default(168), // 168 hours = 1 week
  preferred_send_time: z.string().time().default("10:00:00"),
  timezone: z.string().default("Asia/Kolkata"),
  max_reminders: z.number().int().min(1).max(20).default(5),
  max_attempts: z.number().int().min(1).max(10).default(5),
});

export type CreateExpenseGroupInput = z.infer<typeof createExpenseGroupSchema>;
export type RecordRepaymentInput = z.infer<typeof recordRepaymentSchema>;
