"use node";
import { internalAction } from "./_generated/server";
import { v } from "convex/values";

/**
 * ONE STUDENT'S ATTENDANCE ENTRIES, AS POWERSCHOOL HOLDS THEM RIGHT NOW
 * (2026-10-01).
 *
 * WHY THIS EXISTS. An admin looking at a student's PowerSchool profile saw no
 * tardies at all, while the app -- and PowerSchool's own term total -- had two.
 * Every stored copy here is an aggregate (dates, day counts), so nothing could
 * say WHICH entries those were: the date, the code, the class they sit on, and
 * whether that class is one the student has since left. This answers that for
 * one student, from the source, at the moment it is asked.
 *
 * READ-ONLY AND CLI ONLY. An internalAction: no browser can call it, it writes
 * nothing anywhere, and it reads only fields plugin.xml already grants.
 *
 *   npx convex run --prod attendanceLookup:studentEntries '{"studentNumber":"11356","from":"2026-09-01","to":"2026-09-30"}'
 */
function base64(input: string): string {
  return Buffer.from(input, "utf8").toString("base64");
}

async function token(host: string, id: string, secret: string): Promise<string> {
  const res = await fetch(`https://${host}/oauth/access_token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${base64(`${id}:${secret}`)}`,
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`PowerSchool auth failed: HTTP ${res.status}`);
  return (await res.json()).access_token;
}

export const studentEntries = internalAction({
  args: {
    studentNumber: v.string(),
    from: v.optional(v.string()),
    to: v.optional(v.string()),
  },
  handler: async (_ctx, { studentNumber, from, to }) => {
    const host = process.env.PS_HOST, id = process.env.PS_CLIENT_ID;
    const secret = process.env.PS_CLIENT_SECRET, schoolid = process.env.PS_SCHOOL_ID;
    const yearid = process.env.PS_YEAR_ID;
    if (!host || !id || !secret || !schoolid || !yearid) {
      return { ok: false as const, reason: "PowerSchool settings are not all present." };
    }
    const num = String(studentNumber || "").trim();
    // NEVER AN EMPTY KEY: an empty filter would read every student.
    if (!/^\d+$/.test(num)) return { ok: false as const, reason: "A student number is digits only." };
    const tok = await token(host, id, secret);

    const table = async (name: string, q: string, projection: string, cap = 10) => {
      const rows: any[] = [];
      for (let p = 1; p <= cap; p++) {
        const url = `https://${host}/ws/schema/table/${name}`
          + `?q=${encodeURIComponent(q)}&projection=${encodeURIComponent(projection)}&pagesize=100&page=${p}`;
        const res = await fetch(url, { headers: { Authorization: `Bearer ${tok}`, Accept: "application/json" } });
        if (!res.ok) return { error: `HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`, rows };
        const b = await res.json();
        const batch = (b?.record ?? []).map((r: any) => r.tables?.[name] ?? r);
        rows.push(...batch);
        if (batch.length < 100) break;
      }
      return { error: null as string | null, rows };
    };

    const stu = await table("students", `student_number==${num}`,
      "id,student_number,schoolid,enroll_status,entrydate,exitdate", 1);
    if (stu.error) return { ok: false as const, reason: stu.error };
    if (!stu.rows.length) return { ok: false as const, reason: "No PowerSchool student has that number." };

    const codes = await table("attendance_code", `schoolid==${schoolid};yearid==${yearid}`,
      "id,att_code,description,presence_status_cd", 2);
    const codeOf = new Map<string, any>(codes.rows.map((c: any) => [String(c.id), c]));

    const out: any[] = [];
    for (const s of stu.rows) {
      const att = await table("attendance", `studentid==${s.id};schoolid==${schoolid};yearid==${yearid}`,
        "id,att_date,attendance_codeid,att_mode_code,ccid,periodid");
      const cc = await table("cc", `studentid==${s.id}`,
        "id,sectionid,course_number,expression,termid,dateenrolled,dateleft");
      // PowerSchool marks a dropped enrolment with NEGATIVE ids.
      const ccById = new Map<string, any>();
      for (const c of cc.rows) {
        ccById.set(String(c.id), c);
        ccById.set(String(Math.abs(Number(c.id))), c);
      }
      const entries = att.rows
        .map((a: any) => {
          const date = String(a.att_date ?? "").slice(0, 10);
          const code = codeOf.get(String(a.attendance_codeid)) || {};
          const c = a.ccid != null ? ccById.get(String(a.ccid)) || ccById.get(String(Math.abs(Number(a.ccid)))) : null;
          return {
            date,
            code: code.att_code ?? null,
            description: code.description ?? null,
            presence: code.presence_status_cd ?? null,
            mode: a.att_mode_code ?? null,
            periodId: a.periodid ?? null,
            ccid: a.ccid ?? null,
            course: c ? c.course_number ?? null : null,
            expression: c ? c.expression ?? null : null,
            enrolled: c ? c.dateenrolled ?? null : null,
            left: c ? c.dateleft ?? null : null,
            droppedClass: c ? Number(c.id) < 0 || Number(c.sectionid) < 0 : null,
          };
        })
        .filter((e: any) => (!from || e.date >= from) && (!to || e.date <= to))
        .sort((x: any, y: any) => x.date.localeCompare(y.date));
      out.push({
        studentNumber: String(s.student_number), schoolid: s.schoolid, enrollStatus: s.enroll_status,
        entryDate: s.entrydate, exitDate: s.exitdate,
        errors: [att.error, cc.error].filter(Boolean),
        entries,
        // Everything that is not a plain present mark, which is what was asked.
        notPresent: entries.filter((e: any) => e.code && e.code !== ""),
      });
    }
    return { ok: true as const, schoolid, yearid, students: out };
  },
});
