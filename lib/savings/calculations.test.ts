import assert from "node:assert/strict";
import test from "node:test";
import { calculateSavingsProgress, nextSavingsRun } from "./calculations.ts";
import { addContributionSchema, savingsRuleSchema, updateContributionSchema } from "./validation.ts";

test("savings progress counts confirmed contributions only and returns accurate remainder", () => {
  const progress = calculateSavingsProgress(100, [
    { amount: "25.50", contribution_status: "confirmed" },
    { amount: 20, contribution_status: "reversed" },
    { amount: 10, contribution_status: "pending" },
  ]);
  assert.equal(progress.currentAmount, 25.5);
  assert.equal(progress.remainingAmount, 74.5);
  assert.equal(progress.progressPercent, 25.5);
  assert.equal(progress.confirmedContributionCount, 1);
  assert.equal(progress.isGoalMet, false);
});

test("progress caps display at target while retaining no negative remaining amount", () => {
  const progress = calculateSavingsProgress(20, [
    { amount: 30, contribution_status: "confirmed" },
  ]);
  assert.equal(progress.progressPercent, 100);
  assert.equal(progress.remainingAmount, 0);
  assert.equal(progress.isGoalMet, true);
});

test("monthly recurring schedule clamps end-of-month dates", () => {
  assert.equal(nextSavingsRun(new Date("2026-01-31T12:00:00Z"), "monthly").toISOString(), "2026-02-28T12:00:00.000Z");
});

test("weekly recurring schedule advances exactly seven days", () => {
  assert.equal(nextSavingsRun(new Date("2026-01-01T12:00:00Z"), "weekly").toISOString(), "2026-01-08T12:00:00.000Z");
});

test("contribution and recurrence validation reject invalid financial inputs", () => {
  assert.equal(addContributionSchema.safeParse({ goal_id: "00000000-0000-4000-8000-000000000001", amount: 0 }).success, false);
  assert.equal(updateContributionSchema.safeParse({ notes: "corrected note" }).success, true);
  assert.equal(savingsRuleSchema.safeParse({ amount: 10, frequency: "monthly", enabled: true }).success, true);
  assert.equal(savingsRuleSchema.safeParse({ amount: -1, frequency: "monthly", enabled: true }).success, false);
});
