import { z } from "zod";

export const ParsedTransactionSchema = z.object({
  isTransaction: z.boolean(),

  transactionType: z.enum([
    "payment",
    "refund",
    "reversal",
    "other",
  ]),

  direction: z.enum(["debit", "credit"]).nullable(),

  amount: z.number().positive().nullable(),

  // Never guess a currency when the email doesn't establish it.
  currency: z.string().length(3).nullable(),

  // ISO date-time after normalisation.
  transactionDate: z.string().nullable(),

  transactionDateSource: z.enum([
    "email",
    "received_at",
    "unknown",
  ]),

  merchantOrSender: z.string().nullable(),
  recipientOrSenderUpi: z.string().nullable(),

  bankName: z.string().nullable(),
  accountLast4: z.string().nullable(),
  referenceNumber: z.string().nullable(),

  status: z.enum([
    "completed",
    "pending",
    "failed",
    "unknown",
  ]),

  confidence: z.number().min(0).max(1),
});

export type ParsedTransaction = z.infer<
  typeof ParsedTransactionSchema
>;
