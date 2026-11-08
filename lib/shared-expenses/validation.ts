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
  if (Math.round(data.total_amount * 100) < data.participants.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Each participant must receive at least one cent", path: ["participants"] });
  }
  if (data.split_method === "custom") {
    data.participants.forEach((participant, index) => {
      if ((participant.amount_owed || 0) <= 0) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Each participant share must be positive", path: ["participants", index, "amount_owed"] });
    });
    const sum = data.participants.reduce(
      (acc, p) => acc + (p.amount_owed || 0),
      0
    );
    if (Math.abs(sum - data.total_amount) > 0.01) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Sum of participant amounts (${sum.toFixed(2)}) must equal total amount (${data.total_amount.toFixed(2)})`,
        path: ["participants"],
      });
    }
  }
  if (data.split_method === "percentage") {
    data.participants.forEach((participant, index) => {
      if ((participant.amount_owed || 0) <= 0) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Each participant percentage must be positive", path: ["participants", index, "amount_owed"] });
    });
    const sum = data.participants.reduce((acc, p) => acc + (p.amount_owed || 0), 0);
    if (Math.abs(sum - 100) > 0.01) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Participant percentages must total 100", path: ["participants"] });
  }
});

export const recordRepaymentSchema = z.object({
  expense_share_id: z.string().uuid(),
  amount: z.number().positive().finite(),
  currency_code: z.string().default("INR"),
  payment_method: z.enum(["upi", "paypal", "cash", "bank_transfer", "other"]).default("upi"),
  payment_provider: z.string().max(100).optional().nullable(),
  external_reference: z.string().max(100).optional().nullable(),
  idempotency_key: z.string().uuid().optional(),
});

export const reminderSettingSchema = z.object({
  enabled: z.boolean(),
  initial_message_enabled: z.boolean().default(true),
  frequency_hours: z.number().int().min(1).default(168), // 168 hours = 1 week
  preferred_send_time: z.string().time().default("10:00:00"),
  timezone: z.string().default("Asia/Kolkata").refine((value) => {
    try { new Intl.DateTimeFormat("en-US", { timeZone: value }); return true; } catch { return false; }
  }, "Timezone must be a valid IANA timezone"),
  max_reminders: z.number().int().min(1).max(20).default(5),
  max_attempts: z.number().int().min(1).max(10).default(5),
});

export type CreateExpenseGroupInput = z.infer<typeof createExpenseGroupSchema>;
export type RecordRepaymentInput = z.infer<typeof recordRepaymentSchema>;

/** Persisted participant values are constrained by the existing database schema. */
export function toDatabaseParticipantType(type: CreateExpenseGroupInput["participants"][number]["participant_type"]): "owner" | "contact" {
  return type === "self" ? "owner" : "contact";
}

/** Percentage inputs are converted to amounts before persistence, so store them as custom splits. */
export function toDatabaseSplitMethod(method: CreateExpenseGroupInput["split_method"]): "equal" | "custom" {
  return method === "equal" ? "equal" : "custom";
}
