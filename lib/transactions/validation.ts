import { z } from "zod";

export const transactionTypeEnum = z.enum([
  "payment",
  "refund",
  "shared_expense",
  "repayment",
  "manual",
  "reversal",
  "other",
]);

export const directionEnum = z.enum(["debit", "credit"]);

export const transactionStatusEnum = z.enum([
  "pending",
  "completed",
  "failed",
  "cancelled",
  "partially_refunded",
  "refunded",
]);

export const createTransactionSchema = z.object({
  transaction_type: transactionTypeEnum.default("manual"),
  direction: directionEnum,
  amount: z.number().positive().finite(),
  currency_code: z.string().default("INR"),
  status: transactionStatusEnum.default("completed"),
  description: z.string().max(500).optional().nullable(),
  merchant_name: z.string().max(200).optional().nullable(),
  bank_name: z.string().max(100).optional().nullable(),
  payment_provider: z.string().max(100).optional().nullable(),
  account_last4: z.string().max(10).optional().nullable(),
  external_reference: z.string().max(100).optional().nullable(),
  related_transaction_id: z.string().uuid().optional().nullable(),
  occurred_at: z.string().datetime({ offset: true }).optional(),
}).strict();

export const updateTransactionSchema = z.object({
  transaction_type: transactionTypeEnum.optional(),
  direction: directionEnum.optional(),
  amount: z.number().positive().finite().optional(),
  currency_code: z.string().optional(),
  status: transactionStatusEnum.optional(),
  description: z.string().max(500).optional().nullable(),
  merchant_name: z.string().max(200).optional().nullable(),
  bank_name: z.string().max(100).optional().nullable(),
  payment_provider: z.string().max(100).optional().nullable(),
  account_last4: z.string().max(10).optional().nullable(),
  external_reference: z.string().max(100).optional().nullable(),
  related_transaction_id: z.string().uuid().optional().nullable(),
  occurred_at: z.string().datetime({ offset: true }).optional(),
}).strict();

export const transactionQuerySchema = z.object({
  direction: directionEnum.optional(),
  status: transactionStatusEnum.optional(),
  payment_provider: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  search: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type CreateTransactionInput = z.infer<typeof createTransactionSchema>;
export type UpdateTransactionInput = z.infer<typeof updateTransactionSchema>;
export type TransactionQueryParams = z.infer<typeof transactionQuerySchema>;
