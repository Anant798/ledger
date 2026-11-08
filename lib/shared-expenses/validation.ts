import { z } from "zod";

export const participantShareSchema = z.object({
  id: z.string().uuid().optional(),
  participant_name: z.string().min(1).max(100),
  participant_type: z.enum(["self", "contact", "external"]).default("external"),
  email: z.string().email().optional().nullable(),
  phone_number: z.string().max(20).optional().nullable(),
  user_id: z.string().uuid().optional().nullable(),
  amount_owed: z.number().nonnegative().optional(),
});

const expenseGroupFields = {
  title: z.string().min(1).max(200),
  total_amount: z.number().positive().finite(),
  currency_code: z.string().default("INR"),
  split_method: z.enum(["equal", "custom", "percentage"]).default("equal"),
  transaction_id: z.string().uuid().optional().nullable(),
  participants: z.array(participantShareSchema).min(1),
};

function validateExpenseGroup(data: z.infer<z.ZodObject<typeof expenseGroupFields>>, ctx: z.RefinementCtx) {
  if (Math.abs(data.total_amount * 100 - Math.round(data.total_amount * 100)) > 0.000001) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Expense total must use cents", path: ["total_amount"] });
  }
  if (Math.round(data.total_amount * 100) < data.participants.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Each participant must receive at least one cent", path: ["participants"] });
  }
  if (data.split_method === "custom") {
    data.participants.forEach((participant, index) => {
      if ((participant.amount_owed || 0) <= 0) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Each participant share must be positive", path: ["participants", index, "amount_owed"] });
      if (Math.abs((participant.amount_owed || 0) * 100 - Math.round((participant.amount_owed || 0) * 100)) > 0.000001) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Custom shares must use cents", path: ["participants", index, "amount_owed"] });
    });
    const sumCents = data.participants.reduce((acc, participant) => acc + Math.round((participant.amount_owed || 0) * 100), 0);
    const totalCents = Math.round(data.total_amount * 100);
    if (sumCents !== totalCents) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Participant shares must total ${data.total_amount.toFixed(2)}`,
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
}

export const createExpenseGroupSchema = z.object(expenseGroupFields).superRefine(validateExpenseGroup);
export const updateExpenseGroupSchema = z.object({
  ...expenseGroupFields,
  archived: z.boolean().optional(),
}).superRefine(validateExpenseGroup);
export const archiveExpenseGroupSchema = z.object({ archived: z.boolean() }).strict();

export const recordRepaymentSchema = z.object({
  expense_share_id: z.string().uuid(),
  amount: z.number().positive().finite(),
  idempotency_key: z.string().uuid(),
  currency_code: z.string().default("INR"),
  payment_method: z.enum(["upi", "paypal", "cash", "bank_transfer", "other"]).default("upi"),
  payment_provider: z.string().max(100).optional().nullable(),
  external_reference: z.string().max(100).optional().nullable(),
});

export const updateRepaymentSchema = z.object({
  action: z.literal("edit"),
  amount: z.number().positive().finite(),
  payment_method: z.enum(["upi", "paypal", "cash", "bank_transfer", "other"]),
  payment_provider: z.string().max(100).optional().nullable(),
  idempotency_key: z.string().uuid(),
});

export const reverseRepaymentSchema = z.object({
  action: z.literal("reverse"),
  reason: z.string().trim().min(1).max(500),
});

export const repaymentActionSchema = z.discriminatedUnion("action", [updateRepaymentSchema, reverseRepaymentSchema]);

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
export type UpdateExpenseGroupInput = z.infer<typeof updateExpenseGroupSchema>;
export type RecordRepaymentInput = z.infer<typeof recordRepaymentSchema>;
export type UpdateRepaymentInput = z.infer<typeof updateRepaymentSchema>;

/** Persisted participant values are constrained by the existing database schema. */
export function toDatabaseParticipantType(type: CreateExpenseGroupInput["participants"][number]["participant_type"]): "owner" | "contact" {
  return type === "self" ? "owner" : "contact";
}

/** Percentage inputs are converted to amounts before persistence, so store them as custom splits. */
export function toDatabaseSplitMethod(method: CreateExpenseGroupInput["split_method"]): "equal" | "custom" {
  return method === "equal" ? "equal" : "custom";
}
