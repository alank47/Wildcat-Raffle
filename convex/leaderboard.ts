import { query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { requireStudentSelf } from "./identity";
import {
  cashLeaderboard,
  compactStudent,
  LEADERBOARD_BANDS,
  LEADERBOARD_SNAPSHOT_VERSION,
  placeViewer,
  studentIdOf,
} from "./leaderboardRules";

/**
 * The Wildcat Cash board a student sees on their portal.
 *
 * STUDENTS ONLY, resolved from their own token. requireStudentSelf refuses
 * staff, refuses an unknown address and refuses a student who has left, and it
 * returns the record itself -- so the viewer is never an argument this function
 * accepts. If the caller could name whose rank to look up, they could name
 * anyone's.
 *
 * WHAT LEAVES THE SERVER: the top ten with names, plus the caller's own place.
 * Nothing else. Every other child's earnings stay here, which is what makes
 * this a leaderboard rather than a list of who has the least.
 *
 * COST, measured 2026-10-13: snapshot path ≈ own row + one ~65 KB document +
 * one roster row; live fallback 4.88 MiB. That is about 72 KB a call against
 * 4.88 MiB, and nothing in it grows with the cash ledger. The live fallback is
 * the old read, kept for the kill switch and for the few viewers the copy
 * cannot place; it still meets Convex's 16 MiB wall around January 2027, and
 * the nightly readHeadroom check measures it as "leaderboard:cash".
 *
 * THE HISTORY OF THAT NUMBER. Measured 2026-09-10: 757 student rows plus one
 * indexed psRoster lookup each, about 1,514 documents and well under a
 * megabyte. Each row carries its student's whole cash history, and by
 * 2026-10-13 the same read was 4.88 MiB, which is why the copy exists
 * (leaderboardSnapshot.ts).
 *
 * NO CLOCK IN THIS FILE. Convex caches a query's answer until something it
 * read changes, so a staleness check here would not run when it mattered. The
 * cron's tick decides staleness and stops serving the copy itself.
 */
export const cash = query({
  args: {
    band: v.optional(v.string()),
    topN: v.optional(v.number()),
  },
  handler: async (ctx, { band, topN }) => {
    const me = await requireStudentSelf(ctx);

    // THE STORED COPY WHEN IT IS SERVED TO THIS VIEWER, ELSE TODAY'S LIVE
    // READ. Either way the rows go through the one tested ranking rule below,
    // so the two paths cannot rank differently.
    const rows = (await snapshotRows(ctx, me)) ?? (await liveBoardRows(ctx));

    const result = cashLeaderboard({
      students: rows as any[],
      band,
      topN: topN ?? 10,
      // Resolved through the SAME helper the ranking uses, so the viewer is
      // compared against the identity every ranked row carries.
      viewerId: studentIdOf(me as any),
    });

    return {
      ...result,
      bands: Object.values(LEADERBOARD_BANDS).map((b) => ({ key: b.key, label: b.label })),
    };
  },
});

/**
 * EVERY STUDENT FROM THE STORED COPY, with the viewer's own row read live, or
 * null for the live read.
 *
 * Null (live, exactly as before) when there is no copy, when it was written by
 * an older compactStudent, when it is not served (off, shadow, stale, failing:
 * the tick sets `serve`), when it is a pilot that does not name this viewer,
 * and when the viewer cannot be placed in it (placeViewer says why). The log
 * line carries the reason code only, never an id: it is read by people
 * counting fallbacks, not looking for a child.
 */
async function snapshotRows(ctx: QueryCtx, me: any): Promise<any[] | null> {
  const snap = await ctx.db
    .query("leaderboardSnapshots")
    .withIndex("by_name", (q) => q.eq("name", "cash"))
    .first();
  if (!snap || snap.version !== LEADERBOARD_SNAPSHOT_VERSION) return null;
  const meId = studentIdOf(me);
  if (!(snap.serve === "all" || (snap.serve === "pilot" && snap.pilotIds.includes(meId)))) return null;
  // The viewer's enrolment is read live as well, with the same lookup the
  // live read makes, so a student who left this morning is unranked now.
  const hit = await rosterHit(ctx, me.studentNumber);
  const placed = placeViewer(snap, { id: meId, row: compactStudent(me, Boolean(hit)), creationTime: me._creationTime });
  if (!placed.ok) {
    console.log(`leaderboard:cash live fallback: ${placed.why}`);
    return null;
  }
  return placed.students;
}

/**
 * THE LIVE READ: every student row, and whether each is enrolled. The kill
 * switch and the fallback path; this is what every call did until 2026-10-13.
 */
async function liveBoardRows(ctx: QueryCtx): Promise<any[]> {
  // ENROLMENT IS DERIVED, NOT STORED, and reading the students table alone
  // got this wrong on the first attempt.
  //
  // No student row carries an `enrolled` field -- all 757 have it undefined.
  // appData.ts computes it: a student is enrolled if their studentNumber
  // appears in psRoster, which is replaced wholesale on every SIS sync. So
  // `enrolled !== false` passed every record, and the board ranked 757
  // students including 139 who have left the school. Former students on a
  // board their old classmates can read is not a cosmetic mistake.
  //
  // The same DEFINITION as appData.ts, deliberately: two definitions of
  // "enrolled" is how the dashboard and the leaderboard come to disagree,
  // which is exactly how this was noticed.
  //
  // A DIFFERENT METHOD, though, because the two need different things.
  // appData collects all 5,564 psRoster rows because it uses them; this only
  // needs to know whether a row EXISTS for each student. Scanning the table
  // to answer that read 6,319 documents on every portal load. One indexed
  // lookup per student answers the same question in 1,514 -- measured, both
  // returning 618. Four times cheaper, on a query that runs every time a
  // child opens their page.
  const rows = await ctx.db.query("students").collect();
  const students: any[] = [];
  for (const row of rows) {
    const hit = await rosterHit(ctx, row.studentNumber);
    students.push({ ...row, enrolled: Boolean(hit) });
  }
  return students;
}

/**
 * Is this student number on the PowerSchool roster? The one definition of
 * "enrolled" the board uses: the live read above, the viewer's own row on the
 * snapshot path, and the builder (leaderboardSnapshot.compactPage) all ask it
 * here, so the copy and the live read cannot disagree about who has left.
 */
export async function rosterHit(ctx: QueryCtx, studentNumber?: string) {
  return studentNumber
    ? await ctx.db
        .query("psRoster")
        .withIndex("by_studentNumber", (q) => q.eq("studentNumber", studentNumber))
        .first()
    : null;
}
