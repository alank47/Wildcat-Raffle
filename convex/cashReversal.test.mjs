// Reversing a Wildcat Cash transaction.
//
// WHAT THIS REPLACES. Until now, a teacher who deducted $500 from the wrong
// child could only award $500 back — which writes a second, fictional POSITIVE
// behaviour onto that child's record, inflates "Most Common Behavior", inflates
// the teacher's positive count, and is indistinguishable from a real award in
// every report the school has. The workaround was worse than the mistake and
// permanent. So the assertions that matter most here are not about the money
// moving; they are about the money moving WITHOUT lying in a report.
//
// Run: npm test

import {
  buildReversalRow,
  cashWeekKey,
  negativeCounterRefusals,
  plannedCounterDelta,
  reversalAuditAction,
  reversalVerdict,
  weekKeysBetween,
  CUMULATIVE_COUNTERS,
} from "./cashReversalRules.ts";
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (n, c, d) => {
  if (c) { pass++; console.log(`  PASS  ${n}`); }
  else { fail++; console.log(`  FAIL  ${n}${d ? "  (" + d + ")" : ""}`); }
};

const CUT = Date.parse("2026-09-14T15:30:00Z");   // the real one: 8:30am PDT
const AWARD = {
  id: "txn_1", timestamp: "2026-09-15T16:00:00Z", studentId: "S1",
  amount: 100, kind: "award", type: "positive",
  behaviorId: "be_present", behaviorName: "Be Present",
  teacherId: "T016", teacherName: "A Teacher", notes: "on time all week",
};
const DEDUCT = {
  ...AWARD, id: "txn_2", amount: -500, kind: "deduct", type: "negative",
  behaviorId: "not_responsible", behaviorName: "Not Being Responsible",
};
const REDEEM = { ...AWARD, id: "txn_3", amount: -200, kind: "redeem", behaviorName: "Homework Pass" };
const RICH = { wildcatCashEarned: 1000, wildcatCashSpent: 1000, wildcatCashDeducted: 1000 };

console.log("\n-- it un-counts, it does not counter-award --");
{
  // THE WHOLE POINT OF THE FEATURE. Awarding $500 back would move
  // wildcatCashEarned UP by 500, so the child's earnings — and the cash
  // leaderboard built on them — would include money an adult took off them by
  // mistake. Reversing moves `deducted` DOWN instead, and never touches
  // `earned` at all.
  const d = plannedCounterDelta(DEDUCT);
  check("reversing a deduction returns the balance",
    d.wildcatCashBalance === 500);
  check("and un-counts the deduction",
    d.wildcatCashDeducted === -500);
  check("and leaves earned completely alone, which award-it-back cannot",
    !("wildcatCashEarned" in d));

  const a = plannedCounterDelta(AWARD);
  check("reversing an award takes the balance back", a.wildcatCashBalance === -100);
  check("and un-counts the earning", a.wildcatCashEarned === -100);
  check("and does not touch deducted", !("wildcatCashDeducted" in a));

  // THE KIND DECIDES THE COUNTER, NOT THE SIGN. A redemption and a deduction
  // are both negative, and recordCashTransaction stamps `spent` from
  // `kind === 'redeem'`. Reading the sign here is the same error that put
  // Maria Agaton Colin in a red intervention table for a purchase.
  const r = plannedCounterDelta(REDEEM);
  check("reversing a redemption un-counts SPENT, not deducted",
    r.wildcatCashSpent === -200 && !("wildcatCashDeducted" in r));

  check("a zero or missing amount moves nothing",
    Object.keys(plannedCounterDelta({ amount: 0 })).length === 0
    && Object.keys(plannedCounterDelta({})).length === 0);

  // A row with no `kind` is read the way the writer would have stamped it.
  check("a kindless negative row is treated as a deduction",
    plannedCounterDelta({ amount: -50 }).wildcatCashDeducted === -50);
}

console.log("\n-- `type` stays the sign, because eleven panels read it --");
{
  const row = buildReversalRow({
    original: DEDUCT, reversalId: "txn_rev_1", actorName: "An Admin",
    actorId: "T001", reason: "wrong student", nowIso: "2026-09-15T18:00:00Z",
  });
  // A reversal that handed $500 BACK while carrying type:'negative' would
  // render red "Negative −$500" in the detail table and disappear from the
  // Positive/Negative filter. cash-audit.test.mjs pins the writer's expression
  // and warns about "the ten other panels that read it" — there are eleven.
  check("reversing a deduction is a POSITIVE row, by sign",
    row.amount === 500 && row.type === "positive");
  check("and says what it really is in `kind`", row.kind === "reversal");
  check("and names the row it cancels", row.reversesTxnId === "txn_2");

  const back = buildReversalRow({
    original: AWARD, reversalId: "txn_rev_2", actorName: "An Admin",
    actorId: "T001", reason: "duplicate", nowIso: "2026-09-15T18:00:00Z",
  });
  check("reversing an award is a NEGATIVE row, by sign",
    back.amount === -100 && back.type === "negative");

  // SELF-DESCRIBING. distributeCashTransactions rebuilds every student's array
  // from the ledger on each load, so nothing written onto the ORIGINAL row
  // would survive — the reversal has to carry the story itself.
  check("it carries a snapshot of what it reversed",
    row.reversesAmount === -500 && row.reversesKind === "deduct"
    && row.reversesBehaviorName === "Not Being Responsible"
    && row.reversesTeacherName === "A Teacher"
    && row.reversesNotes === "on time all week");

  // The actor is the person who pressed Reverse, NOT the original teacher.
  // Conflating them would credit the mistake to whoever fixed it.
  check("the reversal is attributed to the person who did it",
    row.teacherName === "An Admin" && row.reversesTeacherName === "A Teacher");
  check("the reason is on the row", row.notes === "wrong student");
}

console.log("\n-- two audit actions, so the money renders with a sign --");
{
  // wildcat-cashaudit.js holds a STATIC per-action sign map and computes
  // `signed = meta.sign * Math.abs(amount)`. One action would need sign 0 and
  // would render every reversal as "+$0" — the file's own comment warns
  // "null, never 0" about exactly this.
  check("reversing a deduction credits", reversalAuditAction(DEDUCT) === "cash_reversal_credit");
  check("reversing an award debits", reversalAuditAction(AWARD) === "cash_reversal_debit");
}

console.log("\n-- it cannot mint money --");
{
  const before = { ...DEDUCT, timestamp: "2026-09-10T16:00:00Z" };
  const v = reversalVerdict({ original: before, historyCutoffMs: CUT, counters: RICH });
  check("a transaction from before the last reset is refused",
    !v.allowed && v.code === "before_reset");
  check("and the refusal explains why in words an adult can act on",
    /no longer in any balance/.test(v.reason));

  check("one from after it is allowed",
    reversalVerdict({ original: DEDUCT, historyCutoffMs: CUT, counters: RICH }).allowed);

  // The same hour of clock slack the write guards use.
  check("half an hour before the cutoff is still reversible",
    reversalVerdict({ original: { ...DEDUCT, timestamp: "2026-09-14T15:00:00Z" },
      historyCutoffMs: CUT, counters: RICH }).allowed);
  check("two hours before it is not",
    !reversalVerdict({ original: { ...DEDUCT, timestamp: "2026-09-14T13:00:00Z" },
      historyCutoffMs: CUT, counters: RICH }).allowed);

  // AN UNDATED ROW IS REFUSED HERE, and kept everywhere else. Pruning an
  // undated row wrongly loses a record; reversing one wrongly MOVES MONEY, so
  // the cautious direction is the opposite.
  const un = reversalVerdict({ original: { ...DEDUCT, timestamp: "" },
    historyCutoffMs: CUT, counters: RICH });
  check("an undated row cannot be placed against the reset, so it is refused",
    !un.allowed && un.code === "undated");

  // With no cutoff set there is no boundary to be the wrong side of.
  check("with no cutoff, an old row is reversible",
    reversalVerdict({ original: { ...DEDUCT, timestamp: "2026-01-01T00:00:00Z" },
      historyCutoffMs: null, counters: RICH }).allowed);

  check("an amount over the single-movement cap is refused",
    !reversalVerdict({ original: { ...DEDUCT, amount: -9000 },
      historyCutoffMs: CUT, counters: RICH, maxDelta: 5000 }).allowed);
}

console.log("\n-- the cumulative counters never go negative --");
{
  // leaderboardRules.ts earnedOf treats a NEGATIVE wildcatCashEarned as
  // UNKNOWN, so one bad reversal would silently drop a child off the cash
  // leaderboard their whole year group can see. Refusing is visible; that is
  // not.
  const poor = { wildcatCashEarned: 50, wildcatCashDeducted: 0, wildcatCashSpent: 0 };
  const v = reversalVerdict({ original: AWARD, historyCutoffMs: CUT, counters: poor });
  check("reversing a $100 award against $50 earned is refused",
    !v.allowed && v.code === "counter_underflow");
  check("and it names the counter", /wildcatCashEarned/.test(v.reason));

  check("exactly enough is allowed",
    reversalVerdict({ original: AWARD, historyCutoffMs: CUT,
      counters: { wildcatCashEarned: 100 } }).allowed);

  // THE BALANCE IS ALLOWED TO GO NEGATIVE and stay visible — the owner's
  // explicit call. Only the three cumulative totals are guarded.
  check("the balance is not one of the guarded counters",
    !CUMULATIVE_COUNTERS.includes("wildcatCashBalance"));
  check("reversing an award on a spent-out student still works",
    reversalVerdict({ original: AWARD, historyCutoffMs: CUT,
      counters: { wildcatCashEarned: 100, wildcatCashBalance: 0 } }).allowed);

  // An absent counter reads as zero rather than blocking everything.
  check("an absent counter counts as zero",
    negativeCounterRefusals({ wildcatCashDeducted: -10 }, {}).length === 1);
  check("and a positive movement is never an underflow",
    negativeCounterRefusals({ wildcatCashDeducted: 10 }, {}).length === 0);
}

console.log("\n-- what may not be reversed, and what it says instead --");
{
  const twice = reversalVerdict({
    original: DEDUCT, existingReversal: { reversalTxnId: "txn_rev_1" },
    historyCutoffMs: CUT, counters: RICH,
  });
  check("an already-reversed row is refused", !twice.allowed);
  check("with the code the caller turns into a quiet success",
    twice.code === "already_reversed");

  // The register is checked BEFORE the row is even looked for, so a double-tap
  // is cheap and cannot depend on finding the original.
  const gone = reversalVerdict({ original: null, existingReversal: { reversalTxnId: "x" } });
  check("already-reversed wins even when the original cannot be found",
    gone.code === "already_reversed");

  const missing = reversalVerdict({ original: null, historyCutoffMs: CUT });
  check("a row that is not in the ledger is refused", !missing.allowed && missing.code === "not_found");

  // A REVERSAL IS NOT REVERSIBLE. Undoing an undo makes the trail a puzzle; if
  // the reversal was wrong, the original action is taken again, by a human.
  const rev = reversalVerdict({
    original: { ...AWARD, kind: "reversal", reversesTxnId: "txn_2" },
    historyCutoffMs: CUT, counters: RICH,
  });
  check("a reversal cannot itself be reversed", !rev.allowed && rev.code === "is_a_reversal");
  check("and it says what to do instead", /award or deduct it\s+again/.test(rev.reason));

  // A PURCHASE IS CANCELLED, NOT REVERSED. Reversing the cash row alone would
  // take the money back and leave an open receipt the child can still collect.
  const buy = reversalVerdict({ original: REDEEM, historyCutoffMs: CUT, counters: RICH });
  check("a store purchase is refused", !buy.allowed && buy.code === "use_store_cancel");
  check("and it points at the Store", /Cancel the receipt in the Store/.test(buy.reason));

  const refund = reversalVerdict({
    original: { ...AWARD, behaviorId: "reward-refund:r1", behaviorName: "Refund: Homework Pass" },
    historyCutoffMs: CUT, counters: RICH,
  });
  check("a store refund is refused too", !refund.allowed && refund.code === "is_a_refund");

  check("a row with no amount is refused",
    !reversalVerdict({ original: { ...AWARD, amount: 0 }, historyCutoffMs: CUT }).allowed);
}

console.log("\n-- the week key matches the client, character for character --");
{
  // There is no bundler — index.html loads plain <script> tags — so the
  // client's cashWeekKey cannot be imported and the server's is a deliberate
  // duplicate. The day they disagree is the day a reversal is filed into a week
  // document nothing reads, so the two are pinned against each other here.
  const script = readFileSync(new URL("../script.js", import.meta.url), "utf8");
  const at = script.indexOf("function cashWeekKey(ts) {");
  const src = script.slice(at, script.indexOf("\n        }\n", at) + 10);
  const clientWeekKey = new Function(src + "\nreturn cashWeekKey;")();

  const dates = [
    "2026-09-15T17:00:00Z", "2026-09-14T15:30:00Z", "2026-01-01T00:00:00Z",
    "2026-12-31T23:59:59Z", "2027-01-03T12:00:00Z", "2026-06-30T08:00:00Z",
    "2025-12-29T00:00:00Z", "2026-03-01T00:00:00Z",
  ];
  const disagreements = dates.filter((d) => cashWeekKey(d) !== clientWeekKey(d));
  check("server and client agree on every sampled date",
    disagreements.length === 0,
    disagreements.map((d) => `${d}: ${cashWeekKey(d)} vs ${clientWeekKey(d)}`).join("; "));

  check("a junk timestamp is 'unknown' in both",
    cashWeekKey("nonsense") === "unknown" && clientWeekKey("nonsense") === "unknown");
  check("today's key is the document production actually holds",
    cashWeekKey("2026-09-15T17:00:00Z") === "2026_W38");
}

console.log("\n-- the ledger search is bounded by the cutoff --");
{
  // legacyMirror is indexed by document name only, so finding one transaction
  // means reading week documents and scanning them. Unbounded, that blows
  // Convex's 4,096-document read limit by spring. Bounded by the cutoff, it is
  // one document today.
  const oneDay = weekKeysBetween(CUT, Date.parse("2026-09-15T17:00:00Z"));
  check("one week since the cutoff means one document to search",
    oneDay.length === 1 && oneDay[0] === "2026_W38", oneDay.join(","));

  // Six, not five: 15 August is in W33 and 15 September in W38, and both ends
  // are inclusive because a transaction on either day has to be findable.
  const aMonth = weekKeysBetween(Date.parse("2026-08-15T00:00:00Z"), Date.parse("2026-09-15T00:00:00Z"));
  check("a month spans six ISO weeks, ends included",
    aMonth.join(",") === "2026_W33,2026_W34,2026_W35,2026_W36,2026_W37,2026_W38", aMonth.join(","));

  const aYear = weekKeysBetween(Date.parse("2026-01-01T00:00:00Z"), Date.parse("2026-12-31T00:00:00Z"));
  check("a whole year is capped rather than read", aYear.length === 14, String(aYear.length));
  check("and the cap is honoured with a custom value",
    weekKeysBetween(Date.parse("2026-01-01T00:00:00Z"), Date.parse("2026-12-31T00:00:00Z"), 3).length === 3);

  check("the same instant is one week, not zero",
    weekKeysBetween(CUT, CUT).length === 1);
  check("no duplicates when the range straddles one week",
    new Set(weekKeysBetween(CUT, CUT + 3 * 86400000)).size
      === weekKeysBetween(CUT, CUT + 3 * 86400000).length);
}

console.log("\n-- the mutation takes no amount, and the register is the key --");
{
  const src = readFileSync(new URL("./cashReversal.ts", import.meta.url), "utf8");
  // COMMENTS STRIPPED BEFORE ANY "this does not appear" ASSERTION. The comment
  // in that file spells out the wrapper the button will add, verbatim, so a
  // naive regex for `export const … = mutation(` matches the documentation
  // rather than the code. I have written an assertion that passed against my
  // own comment twice in this project; this is the third time, and stripping
  // is the only fix that stays fixed.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  // Every money incident in this repo was a number the browser sent and the
  // server trusted. An argument that does not exist cannot be forged.
  const entry = "export const reverseAsAdmin = internalMutation({";
  const args = src.slice(src.indexOf(entry), src.indexOf("handler", src.indexOf(entry)));
  check("the entry point accepts no amount", !/amount/.test(args), args.replace(/\s+/g, " "));
  check("and no counter delta", !/[Dd]elta/.test(args));

  // THE PUBLIC MUTATION, which the button calls. Guarded on three things:
  // admins only, no amount in its arguments, and the same shared body as the
  // CLI path so the two cannot drift into different rules.
  const pub = code.slice(code.indexOf("export const reverse = mutation({"),
                         code.indexOf("});", code.indexOf("export const reverse = mutation({")));
  check("the public mutation is admin-gated", /requireAdmin\(ctx\)/.test(pub));
  check("it accepts no amount either", !/amount/.test(pub));
  check("and it goes through the same body as the CLI path", /doReverse\(ctx, args/.test(pub));

  // The listing query is staff-gated rather than admin-gated on purpose: a
  // teacher may read a child's cash history, and the panel greys out what they
  // cannot act on. Only the money movement is admin-only.
  const list = code.slice(code.indexOf("export const reversibleForStudent = query({"),
                          code.indexOf("});", code.indexOf("export const reversibleForStudent = query({")));
  check("the listing query is staff-gated", /requireStaff\(ctx\)/.test(list));
  check("and shares one body with the internal listing",
    /listReversible\(ctx/.test(list) && (code.match(/async function listReversible/g) || []).length === 1);
  check("an actor name is required, so the record names a human",
    /actorName: v\.string\(\)/.test(src));

  // Idempotency lives in one indexed read, inside the transaction.
  check("the register is read by its index", /withIndex\("by_originalTxnId"/.test(src));
  check("the register row is written before the money moves",
    src.indexOf('insert("cashReversals"') < src.indexOf("ctx.db.patch(student._id"));
  check("the reversal id is minted on the server",
    /const reversalId = `txn_rev_\$\{nowMs\}/.test(src));
  check("a repeat is a quiet success, not a throw",
    /alreadyReversed: true/.test(src) && /ok: true,\s*\n\s*alreadyReversed: true/.test(src));

  // The counters are moved by adding the delta to what is stored, never set
  // from a figure that came in over the wire.
  check("counters are moved by adding the delta to the stored value",
    /patch\[field\] = \(Number\.isFinite\(base\) \? base : 0\) \+ d;/.test(src));

  // The candidate list, not the whole table.
  check("the ledger is read by document, never collected whole",
    /withIndex\("by_doc_collection"/.test(src)
    && !/query\("legacyMirror"\)\s*\.collect\(\)/.test(src));

  // The reversal is an event today, not backdated into the original's week.
  check("the reversal is filed in the week it happened",
    /const reversalWeek = cashWeekKey\(nowIso\);/.test(src));

  // A reason is mandatory, for the argument cashNoteVerdict already makes
  // about deductions.
  check("a reason is required", /reason_required/.test(src));

  // THE LISTING reads the authoritative store, not the lagging cache. Scoped to
  // listReversible: the file as a whole DOES touch wildcatCashTransactions now,
  // because the mutation writes the reversal into the student's own copy --
  // views_app builds a child's wallet from that stored array, and the server is
  // the only thing that can put it there.
  // Bounded to the function itself. Slicing to the next `export` swept in the
  // two repair mutations that sit after it, both of which legitimately touch
  // the student array -- an assertion that reads past its subject fails for
  // reasons that have nothing to do with what it is checking.
  const lrAt = code.indexOf("async function listReversible");
  const listing = code.slice(lrAt, code.indexOf("\nexport const", lrAt));
  check("the listing reads the ledger, not the student's array",
    !/wildcatCashTransactions/.test(listing));
  check("and the mutation writes the student's own copy, for the child's wallet",
    /patch\.wildcatCashTransactions = \[\.\.\.storedHistory, reversalRow\]/.test(code));
  check("appended only when it is not already there, so a retry cannot duplicate it",
    /const alreadyThere = storedHistory\.some/.test(code)
    && /if \(!alreadyThere\) patch\.wildcatCashTransactions/.test(code));

  // The audit payload's money field. describe() reads ticketCount, which is a
  // fossil from the raffle; writing only `amount` rendered an em dash on all
  // four cash audit surfaces, including a real reversal in production.
  check("the audit entry carries ticketCount, which is what describe() reads",
    /ticketCount: Math\.abs\(Number\(original\.amount\)\)/.test(code));
  check("and a category, or the Audit Log cell reads n/a",
    /category: "Wildcat Cash"/.test(code));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
