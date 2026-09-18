import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { cashMovementKey } from "./legacyData";

/**
 * Put back a cash movement whose AUDIT ENTRY survived and whose MONEY did not.
 *
 * THE INCIDENT. A movement is written to two places by two separate calls:
 * recordCashTransaction pushes the ledger row, addToAuditLog writes the audit
 * entry. They are separate writes to separate tables, so one can land while
 * the other does not. Measured on production 2026-09-17: 101 movements after
 * the 14 September history cutoff had an audit entry and no ledger row -- 98
 * awards worth $10,700 and 3 deductions worth $300, across 95 students. The
 * owner found it as "leo-andrew had -100 deducted but in his account nor in my
 * student list in Award Cash does it show he was deducted": the record of the
 * deduction was there, the money was not.
 *
 * THE RECOUNT CANNOT FIX THIS, which is why this exists. cashRecount makes the
 * counters agree with the ledger; here the LEDGER is the thing missing a row,
 * so the counter is faithfully reporting an incomplete history. The movement
 * has to come back first, and then the recount aligns the counters.
 *
 * WHY IT IS SAFE TO REBUILD FROM THE AUDIT ENTRY. The entry carries the
 * student, the amount, the action, the behaviour, the note, the teacher and
 * the timestamp -- everything recordCashTransaction writes except the
 * transaction id. A rebuilt row therefore takes a NEW id, which is the whole
 * risk: if the teacher's device still holds the original in its outbox and
 * sends it later, the school would pay the student twice.
 *
 * cashMovementKey closes that, and it was widened to SECOND precision for this
 * exact purpose. A movement is identified by student, second and amount rather
 * than by id, so the rebuilt row and the original are one movement and
 * unionCashRows refuses the second. Millisecond precision would not have
 * worked: the ledger row and the audit entry are stamped by two different
 * `new Date()` calls, and 139 of 2,086 movements on production carry
 * timestamps 1-2ms apart.
 *
 * IDEMPOTENT TWICE OVER. The id is derived from the movement itself by the
 * driver, so a second run proposes the same id; and this refuses any movement
 * whose key is already in the week document, whatever id it carries.
 *
 * BOTH STORES, OR NEITHER. The row goes into the weekly `cash_tx_*` document
 * AND onto the student's own `wildcatCashTransactions`. Writing only the
 * ledger would leave the two witnesses disagreeing, and cashRecount would then
 * hold that student back and never align their counters.
 *
 * `studentName`, `studentGrade` and `school` are taken from the student record
 * here rather than from anything the driver passes: they are facts about the
 * child, not about the movement, and the record is the place that knows them.
 *
 * internalMutation: deploy key only, never reachable from a browser.
 */
export const restoreMovements = internalMutation({
  args: {
    /** The weekly document these all belong to, e.g. "cash_tx_2026_W38". */
    doc: v.string(),
    movements: v.array(v.object({
      id: v.string(),
      studentId: v.string(),
      timestamp: v.string(),
      amount: v.number(),
      kind: v.string(),
      behaviorId: v.string(),
      behaviorName: v.string(),
      notes: v.string(),
      teacherId: v.string(),
      teacherName: v.string(),
    })),
    apply: v.optional(v.boolean()),
  },
  handler: async (ctx, { doc, movements, apply }) => {
    if (!/^cash_tx_\d{4}_W\d{2}$/.test(doc)) {
      throw new Error(`"${doc}" is not a weekly cash document name.`);
    }
    // ONE read of the week, reused for every movement in the call. Per-movement
    // reads of a 2,000-row document would pass Convex's 4,096-read limit after
    // two or three of them.
    const weekRows = await ctx.db
      .query("legacyMirror")
      .withIndex("by_doc_collection", (q) => q.eq("doc", doc).eq("collection", "transactions"))
      .take(4000);
    if (weekRows.length === 4000) {
      return { ok: false, note: `${doc} has at least 4,000 rows; this needs paging before it can be trusted.` };
    }
    const keys = new Set<string>();
    const ids = new Set<string>();
    for (const r of weekRows as any[]) {
      const k = cashMovementKey(r.payload);
      if (k) keys.add(k);
      const id = String((r.payload as any)?.id ?? "");
      if (id) ids.add(id);
    }

    const nowIso = new Date().toISOString();
    const out: any[] = [];
    let restored = 0, alreadyThere = 0, noStudent = 0;

    for (const m of movements) {
      const amount = Number(m.amount);
      if (!Number.isFinite(amount) || amount === 0) {
        out.push({ id: m.id, action: "refused", why: "amount is not a usable number" });
        continue;
      }
      const payload: Record<string, unknown> = {
        id: m.id,
        timestamp: m.timestamp,
        studentId: m.studentId,
        amount,
        kind: m.kind,
        type: amount >= 0 ? "positive" : "negative",
        behaviorId: m.behaviorId,
        behaviorName: m.behaviorName,
        notes: m.notes,
        teacherId: m.teacherId,
        teacherName: m.teacherName,
        teacherUsername: "",
        // Null, not a guess. The balance at the time cannot be known now, and
        // a fabricated one would be indistinguishable from a real reading.
        balanceAfter: null,
        // So a reader can tell this row was rebuilt from its audit entry
        // rather than written when the movement happened.
        restoredFromAuditAt: nowIso,
      };
      const key = cashMovementKey(payload);
      if (!key) {
        out.push({ id: m.id, action: "refused", why: "cannot be keyed as a movement" });
        continue;
      }
      if (keys.has(key) || ids.has(m.id)) {
        alreadyThere++;
        out.push({ id: m.id, studentId: m.studentId, action: "already present",
                   why: "this movement is already in " + doc });
        continue;
      }

      const student =
        (await ctx.db.query("students")
          .withIndex("by_legacyId", (q) => q.eq("legacyId", m.studentId)).first()) ??
        (await ctx.db.query("students")
          .withIndex("by_studentNumber", (q) => q.eq("studentNumber", m.studentId)).first());
      if (!student) {
        noStudent++;
        out.push({ id: m.id, studentId: m.studentId, action: "refused",
                   why: "no student record matches this id" });
        continue;
      }
      const s: any = student;
      payload.studentName = `${s.firstName ?? ""} ${s.lastName ?? ""}`.trim();
      payload.studentGrade = s.grade ?? "";
      payload.school = (parseInt(String(s.grade ?? ""), 10) >= 9) ? "High School" : "Middle School";

      if (apply === true) {
        await ctx.db.insert("legacyMirror", {
          doc, collection: "transactions", payload, mirroredAt: nowIso,
        });
        const arr = Array.isArray(s.wildcatCashTransactions) ? s.wildcatCashTransactions : [];
        const have = arr.some((t: any) => String(t?.id ?? "") === m.id);
        if (!have) {
          await ctx.db.patch(s._id, { wildcatCashTransactions: arr.concat([payload]) });
        }
      }
      // Claimed inside the loop so two copies in ONE call cannot both land.
      keys.add(key); ids.add(m.id);
      restored++;
      out.push({
        id: m.id, studentId: m.studentId, student: payload.studentName,
        amount, kind: m.kind, timestamp: m.timestamp,
        action: apply === true ? "restored" : "would restore",
      });
    }

    return {
      ok: true, applied: apply === true, doc,
      seen: movements.length, restored, alreadyThere, noStudent,
      moneyMoved: out.filter((o) => o.action === "restored" || o.action === "would restore")
        .reduce((n, o) => n + (Number(o.amount) || 0), 0),
      details: out,
      note: apply === true
        ? "Written. Now run: node scripts/recount-cash-counters.mjs --prod  to align the counters."
        : "Dry run. Nothing was written. Pass apply: true.",
    };
  },
});
