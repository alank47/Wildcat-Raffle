import { query } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { requireStaff } from "./identity";

/**
 * Each named student's PROMISE TIME (AM) class: the course and its teacher.
 *
 * Asked for 2026-09-30 for the printable purchase list: "can we add Promise
 * Time AM to the printable list of purchases? Promise Time is when we
 * distribute any items." The list is how the office hands out what students
 * bought, so it needs to say which Promise Time room each item goes to.
 *
 * AM IS SLOT 1, AND ONLY THE SLOT SAYS SO. psRoster.period holds the section
 * expression, and Promise Time AM and PM carry the IDENTICAL course name
 * ("Promise Time 12A"); only the leading slot tells them apart -- 1 is AM, 10
 * is PM (wildcat-roster.js SLOT_MAP, measured 2026-08-18). So this matches the
 * slot, never the name. Measured 2026-09-30: every student with a slot-1 row
 * has exactly one.
 *
 * ONLY FOR ROLES THAT ALREADY SEE EVERY STUDENT (review finding,
 * 2026-09-30). A student's morning room is schedule data, and a classroom
 * teacher is limited to their own roster everywhere else (accessRules.ts
 * canViewStudent, enforced by studentDetail:get). Admins, campus aides and
 * PBIS can open any student's profile already, so this tells them nothing
 * new; a teacher is refused. The list is printed from the admin Receipts desk.
 */
export const PROMISE_TIME_ROLES = ["admin", "superadmin", "campusaide", "pbis"];
export function mayReadPromiseTime(role: unknown): boolean {
  return PROMISE_TIME_ROLES.includes(String(role ?? ""));
}
const MAX_NUMBERS = 1500;

export function isPromiseTimeAm(period: unknown): boolean {
  return /^1\(/.test(String(period ?? "").trim());
}

export const promiseTimeAm = query({
  args: { studentNumbers: v.array(v.string()) },
  handler: async (ctx, { studentNumbers }) => {
    const me = await requireStaff(ctx);
    if (!mayReadPromiseTime((me as any).role)) {
      throw new ConvexError("Only staff who can see every student can read Promise Time for this list.");
    }
    const wanted = [...new Set(studentNumbers.map((n) => String(n ?? "").trim()).filter(Boolean))]
      .slice(0, MAX_NUMBERS);
    const out: Record<string, { course: string; teacher: string }> = {};
    for (const num of wanted) {
      const rows = await ctx.db.query("psRoster")
        .withIndex("by_studentNumber", (q) => q.eq("studentNumber", num))
        .collect();
      const am = rows.find((r) => isPromiseTimeAm(r.period));
      if (!am) continue;
      const teacher = [am.teacherFirstName, am.teacherLastName]
        .map((s) => String(s ?? "").trim()).filter(Boolean).join(" ");
      out[num] = { course: String(am.courseName ?? "").trim(), teacher };
    }
    return { byNumber: out, asked: wanted.length, found: Object.keys(out).length };
  },
});
