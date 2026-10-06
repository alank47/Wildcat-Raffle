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
  weekKeysNewestFirst,
  txnIdMillis,
  weekOfTxnId,
  ledgerSearchWeeks,
  readWeeksWithinBudget,
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
  // means reading whole week documents. The limit that binds is Convex's
  // 16 MiB of data read per execution (a week is ~1.3 MiB), not a document
  // count. Bounded by the cutoff, it was one document on the first day.
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

console.log("\n-- the window counts back from NOW, so the current week is never dropped --");
{
  // THE 12/21 CLIFF. Fourteen weeks counted forward from the 9/14 cutoff end
  // at W51; from the week of 12/21 the week a new transaction is filed in was
  // outside the search and the list. Counting back from now keeps it.
  const dec22 = Date.parse("2026-12-22T17:00:00Z");
  const win = weekKeysNewestFirst(CUT, dec22, 14);
  check("on 12/22 the window still starts with the current week",
    win[0] === "2026_W52" && win.length === 14, win.slice(0, 3).join(","));
  check("and what falls out is the OLDEST week, the cutoff's",
    !win.includes("2026_W38") && win[13] === "2026_W39", win[13]);
  check("weekKeysBetween keeps the same newest weeks, oldest first",
    JSON.stringify(weekKeysBetween(CUT, dec22, 14)) === JSON.stringify([...win].reverse()));
  check("a short span is every week back to the cutoff's, newest first",
    weekKeysNewestFirst(CUT, Date.parse("2026-10-05T17:00:00Z")).join(",") === "2026_W41,2026_W40,2026_W39,2026_W38");
  check("a span across New Year steps through ISO week 53",
    weekKeysNewestFirst(Date.parse("2026-12-25T00:00:00Z"), Date.parse("2027-01-06T00:00:00Z")).join(",")
      === "2027_W01,2026_W53,2026_W52");
  check("a bad number gives no weeks rather than a guess",
    weekKeysNewestFirst(NaN, Date.now()).length === 0);
}

console.log("\n-- an id's own time, and nothing looser --");
{
  const ms = Date.parse("2026-09-30T18:00:00Z");
  check("txn_<13 digits>_ carries its time", txnIdMillis(`txn_${ms}_abcd`) === ms);
  check("so do txn_buy_, txn_rev_ and txn_refund_",
    [`txn_buy_${ms}_x`, `txn_rev_${ms}_x`, `txn_refund_${ms}_x`].every((id) => txnIdMillis(id) === ms));
  check("a repaired txn_rb_ id carries none, even when its hash has thirteen digits in it",
    txnIdMillis("txn_rb_0123456789ab") === null && txnIdMillis("txn_rb_1234567890123_x") === null);
  check("nor does a short number, a missing underscore or a non-string",
    txnIdMillis("txn_12345_x") === null && txnIdMillis(`txn_${ms}`) === null &&
    txnIdMillis(undefined) === null && txnIdMillis(12345) === null);
  check("the week an id points at is its row's week", weekOfTxnId(`txn_${ms}_a`) === "2026_W40");
}

console.log("\n-- a reversal searches at most three weeks --");
{
  const mid = Date.parse("2026-09-30T18:00:00Z");          // a Wednesday
  const id = `txn_${mid}_a`;
  check("an id mid-week: its own week only",
    JSON.stringify(ledgerSearchWeeks(id).weeks) === '["2026_W40"]');
  check("a hint is read first, and never twice",
    JSON.stringify(ledgerSearchWeeks(id, "2026_W39").weeks) === '["2026_W39","2026_W40"]' &&
    JSON.stringify(ledgerSearchWeeks(id, "2026_W40").weeks) === '["2026_W40"]');
  check("a hint that is not a week key is ignored",
    JSON.stringify(ledgerSearchWeeks(id, "../students").weeks) === '["2026_W40"]' &&
    ledgerSearchWeeks(id, "2026_W40 ").hint === "2026_W40");
  check("an id with no time and no hint searches nothing",
    ledgerSearchWeeks("txn_rb_0123456789ab").weeks.length === 0 &&
    JSON.stringify(ledgerSearchWeeks("txn_rb_0123456789ab", "2026_W39").weeks) === '["2026_W39"]');
  const monday = Date.parse("2026-09-28T00:20:00Z");       // 20 minutes into W40
  check("in a week's first hour the previous week is searched too",
    JSON.stringify(ledgerSearchWeeks(`txn_${monday}_a`).weeks) === '["2026_W40","2026_W39"]');
  const sunday = Date.parse("2026-09-27T23:50:00Z");       // 10 minutes before W40
  check("in a week's last hour the next week is",
    JSON.stringify(ledgerSearchWeeks(`txn_${sunday}_a`).weeks) === '["2026_W39","2026_W40"]');
  check("with a hint as well, never more than three",
    ledgerSearchWeeks(`txn_${monday}_a`, "2026_W30").weeks.length === 3);
}

console.log("\n-- reading weeks within a byte budget keeps only whole weeks --");
{
  const weekOf = { A: 10, B: 10, C: 10 };                     // rows per week
  const reads = [];
  const read = async (w, max) => { reads.push([w, max]); return Array.from({ length: Math.min(weekOf[w], max) }, (_, i) => ({ w, i, mine: i % 2 === 0 })); };
  const all = await readWeeksWithinBudget({ weeks: ["A", "B", "C"], read, sizeOf: () => 100, keep: (r) => r.mine, byteBudget: 10000, rowBytesCeiling: 100 });
  check("everything fits: every week read, only the kept rows returned, every row counted",
    all.stoppedAt === null && all.weeksRead.join("") === "ABC" && all.rows.length === 15 && all.bytes === 3000);
  reads.length = 0;
  const cut = await readWeeksWithinBudget({ weeks: ["A", "B", "C"], read, sizeOf: () => 100, keep: () => true, byteBudget: 2500, rowBytesCeiling: 100 });
  check("a week that does not fit is left out whole and named",
    cut.stoppedAt === "C" && cut.weeksRead.join("") === "AB" && cut.rows.every((r) => r.week !== "C") && cut.rows.length === 20,
    JSON.stringify({ s: cut.stoppedAt, w: cut.weeksRead, n: cut.rows.length }));
  check("each read asks for no more rows than the budget left can hold, plus one to detect overflow",
    JSON.stringify(reads) === JSON.stringify([["A", 26], ["B", 16], ["C", 6]]), JSON.stringify(reads));
  const capped = await readWeeksWithinBudget({ weeks: ["A"], read, sizeOf: () => 1, keep: () => true, byteBudget: 1e9, rowBytesCeiling: 1, maxRowsPerRead: 5 });
  check("and never more than maxRowsPerRead, so a huge week is refused rather than read",
    capped.stoppedAt === "A" && capped.rows.length === 0);
}

console.log("\n-- the ledger insert carries no mirror key --");
{
  // See the note in studentStore.test.mjs: one keyed row in an unkeyed
  // collection makes loadDoc return a map built from keyed rows only, and
  // every other row disappears from what the client loads. The reversal row
  // shipped with a key on 2026-09-15 and took the whole cash ledger with it.
  const src2 = readFileSync(new URL("./cashReversal.ts", import.meta.url), "utf8");
  const inserts = [...src2.matchAll(/ctx\.db\.insert\("legacyMirror",\s*\{([\s\S]*?)\}\)/g)]
    .map((m) => m[1]);
  check("the reversal's mirror insert sets no key",
    inserts.length > 0 && inserts.every((b) => !/(^|\s)key:/.test(b)),
    inserts.map((k) => k.replace(/\s+/g, " ").slice(0, 60)).join(" | "));
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
