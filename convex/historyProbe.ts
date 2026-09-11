import { internalAction } from "./_generated/server";
import { v } from "convex/values";

/**
 * Does PowerSchool still hold grades for a PRIOR term or year?
 *
 * READ-ONLY, AND IT RETURNS NO STUDENT DATA. Counts, distinct-student counts
 * and a letter-grade histogram only. It exists to answer one question that
 * decides four of the twelve Academics Mode metrics: is the history there, or
 * does it have to be accumulated from today forward?
 *
 * It calls the SAME named query the sync calls every six hours, with different
 * termid / finalgradename / storecode. Nothing is granted that was not already
 * granted, and nothing is written anywhere.
 *
 * The ids are predictable. PS_YEAR_ID is 36 (2026-27), PS_TERM_ID 3601 and
 * PS_YEAR_TERM_ID 3600, so year 35 is 2025-26 and 3500 is its full-year term.
 * That pattern is what makes a backfill mechanical rather than a research
 * project -- but it is a convention, so this probe tests it rather than
 * assuming it.
 */
const PAGE_SIZE = 500;

async function token(host: string, id: string, secret: string): Promise<string> {
  const res = await fetch(`https://${host}/oauth/access_token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${id}:${secret}`)}`,
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`token failed: HTTP ${res.status}`);
  return (await res.json()).access_token as string;
}

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not configured.`);
  return v;
}

export const probePriorTerm = internalAction({
  args: {
    termid: v.string(),
    finalgradename: v.string(),
    storecode: v.string(),
  },
  handler: async (_ctx, { termid, finalgradename, storecode }) => {
    const host = need("PS_HOST");
    const tok = await token(host, need("PS_CLIENT_ID"), need("PS_CLIENT_SECRET"));

    // ONE PAGE. This is a yes/no question, not a data pull, and a probe that
    // walks every page of a prior year is a sync nobody asked for.
    const res = await fetch(
      `https://${host}/ws/schema/query/com.lapromisefund.wildcathub.grades?pagesize=${PAGE_SIZE}&page=1`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tok}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          schoolid: need("PS_SCHOOL_ID"),
          termid,
          finalgradename,
          storecode,
        }),
      },
    );

    if (!res.ok) {
      return {
        asked: { termid, finalgradename, storecode },
        ok: false,
        status: res.status,
        detail: (await res.text()).slice(0, 300),
      };
    }

    const body = await res.json();
    const rows: any[] = body?.record ?? [];
    const students = new Set<string>();
    const letters: Record<string, number> = {};
    let withGrade = 0, withPercent = 0;
    const sources: Record<string, number> = {};
    for (const r of rows) {
      const f = r.tables?.students ?? r;
      const sn = String(f.student_number ?? "");
      if (sn) students.add(sn);
      const L = typeof f.current_grade === "string" ? f.current_grade.trim() : "";
      if (L) { withGrade++; letters[L] = (letters[L] ?? 0) + 1; }
      if (f.current_percent !== null && f.current_percent !== undefined && f.current_percent !== "") withPercent++;
      const src = String(f.grade_source ?? "(none)");
      sources[src] = (sources[src] ?? 0) + 1;
    }

    return {
      asked: { termid, finalgradename, storecode },
      ok: true,
      rowsOnFirstPage: rows.length,
      hitPageSize: rows.length >= PAGE_SIZE,
      distinctStudents: students.size,
      withGrade,
      withPercent,
      gradeSources: sources,
      letters,
    };
  },
});
