import assert from "node:assert/strict";
import test from "node:test";
import { accessibleExpenseGroupFilter } from "./participant-access.ts";

test("expense group query includes owned groups and deduplicated groups shared with the user", () => {
  assert.equal(
    accessibleExpenseGroupFilter("user-1", ["group-1", "group-1", "group-2"]),
    "user_id.eq.user-1,id.in.(group-1,group-2)"
  );
  assert.equal(accessibleExpenseGroupFilter("user-1", []), "user_id.eq.user-1");
});
