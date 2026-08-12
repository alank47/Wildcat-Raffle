// Tests for the pure shape and merge rules behind the Convex cutover.
// Run: npm test
//
// The merge rule here is the one that matters. The Firestore version replaced
// the whole document on every save, so a browser tab that had loaded before a
// backfill wrote its stale view over everything. That is not hypothetical: it
// wiped 38 staff emails on 2026-08-11. These tests reproduce that shape.

import { toAppStudent, toAppTeacher, mergeIncoming } from "./appDataShape.ts";

let pass = 0;
let fail = 0;
function check(label, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail ? `  (${detail})` : ""}`);
  }
}

console.log("\nConvex row to app shape");
{
  const row = {
    legacyId: "s-123",
    studentNumber: "11095",
    firstName: "Ada",
    lastName: "Lovelace",
    grade: "11",
    pbisTickets: 3,
    attendanceTickets: 0,
    academicTickets: 1,
    bigRaffleQualified: [1, 2],
    wildcatCashBalance: 15000,
    cashBalance: 15000,
  };
  const app = toAppStudent(row);
  check("id prefers legacyId", app.id === "s-123", app.id);
  check("name is joined", app.name === "Ada Lovelace", app.name);
  check("earned value survives", app.wildcatCashBalance === 15000);
  check("week numbers stay NUMBERS, never coerced", app.bigRaffleQualified[0] === 1);
}
{
  const app = toAppStudent({
    studentNumber: "12036",
    firstName: "New",
    lastName: "Student",
    pbisTickets: 0,
    attendanceTickets: 0,
    academicTickets: 0,
    bigRaffleQualified: [],
  });
  check("a SIS student with no legacyId falls back to studentNumber", app.id === "12036", app.id);
  check("a student with no balance yet reports 0, not undefined", app.pbisTickets === 0);
}
{
  const t = toAppTeacher({
    _id: "abc",
    legacyId: "T007",
    name: "A Teacher",
    email: "a.teacher@lapromisefund.org",
    role: "teacher",
    ticketsAwarded: 12,
  });
  check("teacher id prefers legacyId", t.id === "T007", t.id);
  check("teacher email is carried", t.email === "a.teacher@lapromisefund.org");
  check("ticketsAwarded is carried", t.ticketsAwarded === 12);
}

console.log("\nThe stale tab rule, which is why this file exists");
{
  // A tab loaded before the email backfill sends "" for a field it never had.
  const existing = { name: "A", email: "al@lapromisefund.org", ticketsAwarded: 3 };
  const incoming = { name: "A", email: "", ticketsAwarded: 4 };
  const patch = mergeIncoming(existing, incoming);
  check("a blank incoming value never overwrites a present one", !("email" in patch), JSON.stringify(patch));
  check("a real change in the same payload still applies", patch.ticketsAwarded === 4);
  check("unchanged fields are absent from the patch", !("name" in patch));
}
{
  const existing = { email: "old@lapromisefund.org" };
  const incoming = { email: "new@lapromisefund.org" };
  const patch = mergeIncoming(existing, incoming);
  check("a non blank change to a present field DOES apply", patch.email === "new@lapromisefund.org");
}
{
  const existing = { email: undefined, name: "A" };
  const incoming = { email: "first@lapromisefund.org", name: "A" };
  const patch = mergeIncoming(existing, incoming);
  check("filling a field that was empty DOES apply", patch.email === "first@lapromisefund.org");
}
{
  // Zero is a real balance. Treating it as absence would make a spent-down
  // account impossible to zero out, which is a worse bug than the one above.
  const existing = { pbisTickets: 5, wildcatCashBalance: 15000 };
  const incoming = { pbisTickets: 5, wildcatCashBalance: 0 };
  const patch = mergeIncoming(existing, incoming);
  check("a balance CAN be set to zero deliberately", patch.wildcatCashBalance === 0, JSON.stringify(patch));
  check("and an unchanged count is still not written", !("pbisTickets" in patch));
}
{
  // An empty ARRAY is a real value too: a student can lose their last
  // qualification. Only undefined, null and "" mean "I do not know".
  const existing = { bigRaffleQualified: [1, 2] };
  const incoming = { bigRaffleQualified: [] };
  const patch = mergeIncoming(existing, incoming);
  check("an empty array is a real value, not absence", Array.isArray(patch.bigRaffleQualified) && patch.bigRaffleQualified.length === 0);
}
{
  const existing = { cashTransactions: [{ amount: 100 }] };
  const incoming = { cashTransactions: [{ amount: 100 }] };
  const patch = mergeIncoming(existing, incoming);
  check("a deep-equal array is not rewritten", !("cashTransactions" in patch), JSON.stringify(patch));
}
{
  const patch = mergeIncoming({ a: 1 }, { a: undefined, b: undefined });
  check("undefined never writes, even for a field that does not exist yet", Object.keys(patch).length === 0, JSON.stringify(patch));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
