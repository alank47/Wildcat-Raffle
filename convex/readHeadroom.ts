import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import {
  AMBER_PCT,
  LIMIT_MIB,
  RED_PCT,
  announcedBands,
  bandsAsRecord,
  estimateReaders,
  growthOf,
  headroomHeadline,
  projectDates,
  worsenedReaders,
  type HeadroomMeasure,
} from "./readHeadroomRules";

/**
 * The nightly read-headroom check: how close is each heavy read to Convex's
 * 16 MiB-per-call wall? See readHeadroomRules.ts for why, and for what the
 * numbers mean.
 *
 * IT ONLY MEASURES. Read-only queries, paged so the probe can never hit the
 * limit it is measuring, then one appState row ("readHeadroom") overwritten
 * with the latest numbers. Nothing a staff member or student uses reads it.
 *
 * WHERE A PERSON SEES IT, TODAY. `npx convex run readHeadroom:latest --prod`,
 * or the appState table's "readHeadroom" row in the Convex dashboard. Each run
 * also prints one line to the Convex logs.
 *
 * AND THE AUDIT ENTRY, WHICH STARTS OFF. When a reader's band gets worse
 * (green to amber, amber to red) the check can add an entry to the audit log,
 * which the home dashboard's feed renders. It is OFF until switched on,
 * because the feed's rule for keeping a system alarm to admins
 * (script.js dashFeedEntriesFor) is a list of action names in the browser,
 * and this action is not on it yet: switched on today, the entry would sit on
 * every teacher's first screen, labelled as Tickets, as an alarm they cannot
 * act on -- the thing that rule was written to stop. The browser half is one
 * line in that list plus one in FEED_ACTION_CATS, for the next after-hours
 * client release; then:
 *   npx convex run readHeadroom:configure '{"auditEntries": true}' --prod
 * A band that worsened while it was off is announced on the first night it is
 * on: the comparison point is what has been announced, not last night (see
 * announcedBands in readHeadroomRules.ts).
 */

const STATE_KEY = "readHeadroom";
const CONFIG_KEY = "readHeadroomConfig";
const AUDIT_ACTION = "read_headroom_warning";

/** Pages per table before the check gives up and says so. */
const MAX_PAGES = 200;

function sizeOf(doc: unknown): number {
  try { return JSON.stringify(doc).length; } catch { return 0; }
}

/**
 * One page of students, with what an enrolment lookup reads for each. The
 * lookups are the same indexed `.first()` appData:load and leaderboard:cash
 * make, so their bytes are what those two really pay. Aggregates only: no
 * name, number or row leaves this function.
 */
export const studentsPage = internalQuery({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { cursor }) => {
    // Fifty a page: student rows grow with their cash copies (largest ~25 KB
    // on 2026-10-05, perhaps three times that by June), and a page with its
    // fifty roster lookups has to stay far inside the limit it is measuring.
    const page = await ctx.db.query("students").paginate({ cursor: cursor ?? null, numItems: 50 });
    let bytes = 0, cashCopyBytes = 0, largestRowBytes = 0, rosterLookupBytes = 0, rosterLookupHits = 0;
    for (const s of page.page as any[]) {
      const b = sizeOf(s);
      bytes += b;
      largestRowBytes = Math.max(largestRowBytes, b);
      cashCopyBytes += sizeOf(s.wildcatCashTransactions ?? []);
      const num = s.studentNumber;
      if (num) {
        const hit = await ctx.db.query("psRoster")
          .withIndex("by_studentNumber", (q) => q.eq("studentNumber", num)).first();
        if (hit) { rosterLookupBytes += sizeOf(hit); rosterLookupHits++; }
      }
    }
    return {
      rows: page.page.length, bytes, cashCopyBytes, largestRowBytes,
      rosterLookupBytes, rosterLookupHits,
      cursor: page.continueCursor, isDone: page.isDone,
    };
  },
});

/** One page of the whole roster: what any whole-roster read pays. */
export const rosterPage = internalQuery({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db.query("psRoster").paginate({ cursor: cursor ?? null, numItems: 1000 });
    let bytes = 0;
    for (const r of page.page) bytes += sizeOf(r);
    return { rows: page.page.length, bytes, cursor: page.continueCursor, isDone: page.isDone };
  },
});

/** One page of legacyMirror, sized per document (a cash week is one document). */
export const mirrorPage = internalQuery({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db.query("legacyMirror").paginate({ cursor: cursor ?? null, numItems: 1000 });
    const docs: Record<string, { rows: number; bytes: number }> = {};
    let bytes = 0;
    for (const r of page.page as any[]) {
      const b = sizeOf(r);
      bytes += b;
      const d = (docs[String(r.doc)] ??= { rows: 0, bytes: 0 });
      d.rows++; d.bytes += b;
    }
    return {
      rows: page.page.length, bytes,
      docs: Object.entries(docs).map(([doc, x]) => ({ doc, rows: x.rows, bytes: x.bytes })),
      cursor: page.continueCursor, isDone: page.isDone,
    };
  },
});

/** The small reads: every teacher, the two appState rows load reads, the cutoff. */
export const smallReads = internalQuery({
  args: {},
  handler: async (ctx) => {
    const teachers = await ctx.db.query("teachers").take(2000);
    let teacherBytes = 0;
    for (const t of teachers) teacherBytes += sizeOf(t);
    const state = async (key: string) => await ctx.db.query("appState")
      .withIndex("by_key", (q) => q.eq("key", key)).unique();
    const settings = await state("liveSettings");
    const cutoff = await state("historyCutoff");
    const iso = (cutoff?.value as any)?.iso;
    return {
      teachers: { rows: teachers.length, bytes: teacherBytes },
      loadSettingsBytes: sizeOf(settings) + sizeOf(cutoff),
      cutoffIso: typeof iso === "string" && Number.isFinite(Date.parse(iso)) ? iso : null,
    };
  },
});

/**
 * What cashInsights:trendsContext reads (2026-10-06): this year's attendance
 * run days, every psAttendanceMarks row, every staff row and one psRoster row
 * per staff member. The same tables and bounds as that query; sizes only, and
 * the roster is looked up by psEmail when set, else email -- the address
 * rosterEmailFor picks for every staff member it does not refuse.
 *
 * NOT THE LEDGER: nothing here grows with cash. It grows through the school
 * year instead, as each marks row collects dates, which is why it is measured.
 */
export const trendsContextReads = internalQuery({
  args: {},
  handler: async (ctx) => {
    let rows = 0, bytes = 0;
    const add = (doc: unknown) => { if (doc) { rows++; bytes += sizeOf(doc); } };
    const newest = await ctx.db.query("attendanceRunDays").withIndex("by_yearid_date").order("desc").first();
    add(newest);
    if (newest) {
      const year = await ctx.db.query("attendanceRunDays")
        .withIndex("by_yearid_date", (q) => q.eq("yearid", newest.yearid)).take(801);
      for (const r of year) add(r);
    }
    for (const m of await ctx.db.query("psAttendanceMarks").take(3001)) add(m);
    for (const t of await ctx.db.query("teachers").take(501)) {
      add(t);
      const email = String((t as any).psEmail || (t as any).email || "").trim().toLowerCase();
      if (!email) continue;
      add(await ctx.db.query("psRoster").withIndex("by_teacherEmail", (q) => q.eq("teacherEmail", email)).first());
    }
    return { rows, bytes };
  },
});

/** Write the result, and the audit entry when a band got worse (if switched on). */
export const recordResult = internalMutation({
  args: { result: v.any() },
  handler: async (ctx, { result }) => {
    const at = new Date().toISOString();
    const row = await ctx.db.query("appState")
      .withIndex("by_key", (q) => q.eq("key", STATE_KEY)).unique();
    const previous = (row?.value as any) ?? null;
    const cfg = await ctx.db.query("appState")
      .withIndex("by_key", (q) => q.eq("key", CONFIG_KEY)).unique();
    const auditOn = (cfg?.value as any)?.auditEntries === true;

    // A FAILED RUN CARRIES THE LAST GOOD BANDS FORWARD (`lastGood`), so a
    // night that could not measure is never compared against, and the next
    // good night is compared with the last one that did.
    const ok = Boolean(result && result.ok !== false && Array.isArray(result.readers));
    const prevGood = previous
      ? (previous.ok !== false && Array.isArray(previous.readers) ? previous : previous.lastGood ?? null)
      : null;
    // COMPARED WITH WHAT HAS BEEN ANNOUNCED, not with last night, so a band
    // that worsened while the switch was off is still news once it is on
    // (see announcedBands). A row from before `announced` existed falls back
    // to the last good night.
    const prevAnnounced = previous?.announced && typeof previous.announced === "object"
      ? previous.announced : null;
    const compareTo = bandsAsRecord(prevAnnounced) ?? prevGood;
    const worsened = ok ? worsenedReaders(compareTo, result) : [];
    const announced = ok ? announcedBands(compareTo, result, auditOn) : prevAnnounced;
    const value = {
      ...(result || {}),
      recordedAt: at,
      worsened,
      announced,
      previousMeasuredAt: prevGood?.measuredAt ?? null,
      auditEntries: auditOn,
      ...(ok ? {} : {
        lastGood: prevGood
          ? { measuredAt: prevGood.measuredAt ?? null, headline: prevGood.headline ?? null, readers: prevGood.readers }
          : null,
      }),
    };
    if (row) await ctx.db.patch(row._id, { value, mirroredAt: at });
    else await ctx.db.insert("appState", { key: STATE_KEY, value, mirroredAt: at });

    // ONLY WHEN A BAND GOT WORSE, never nightly: "did it run?" is the appState
    // row above; the audit log is for the nights something changed.
    let audited = false;
    if (auditOn && ok && worsened.length) {
      const entryId = `a_headroom_${at.replace(/[^0-9]/g, "")}`;
      const words = worsened.map((w) => `${w.name} is now ${w.to} at ${w.pct}% (${w.estMiB} MiB)` +
        (w.from ? `, was ${w.from}` : "")).join("; ");
      await ctx.db.insert("appAuditLog", {
        entryId,
        timestamp: at,
        payload: {
          action: AUDIT_ACTION,
          entryId, timestamp: at,
          // "All students", not "": an entry with no name renders as
          // "Student #" + studentId (the trap the cash drift entry notes).
          studentId: "all", studentName: "All students",
          category: "System",
          teacher: "System (nightly read check)",
          teacherName: "System (nightly read check)",
          teacherId: "",
          details: `Server read headroom: ${words}. Nothing was changed; this check only measures. ` +
            `Details: npx convex run readHeadroom:latest --prod`,
          // The field the dashboard feed renders.
          reason: `Server read headroom: ${words} of the ${LIMIT_MIB} MiB a single read may use.`,
        },
      });
      audited = true;
    }
    return { recorded: true, at, worsened, audited };
  },
});

/**
 * Measure, estimate, record. Scheduled nightly (crons.ts); safe to run by
 * hand any time: `npx convex run readHeadroom:nightly --prod`.
 *
 * An ACTION because it pages: every query it calls reads one bounded page,
 * so the check itself is nowhere near the limit it measures.
 */
export const nightly = internalAction({
  args: { reason: v.optional(v.string()) },
  handler: async (ctx, { reason }): Promise<Record<string, any>> => {
    const started = Date.now();
    const fail = async (why: string) =>
      await ctx.runMutation(internal.readHeadroom.recordResult, {
        result: { ok: false, why, reason: reason ?? null, measuredAt: new Date().toISOString() },
      });

    // A THROWN READ IS RECORDED AS A FAILED NIGHT, not left as silence: the
    // row would otherwise keep showing the last good night as if it were
    // tonight's. (Only the record itself is outside this net.)
    let result: Record<string, any>;
    try {
      const students = { rows: 0, bytes: 0, cashCopyBytes: 0, largestRowBytes: 0, rosterLookupBytes: 0, rosterLookupHits: 0 };
      let cursor: string | null = null;
      for (let i = 0; ; i++) {
        if (i >= MAX_PAGES) return await fail("the students table needed more than 200 pages");
        const p: any = await ctx.runQuery(internal.readHeadroom.studentsPage, { cursor });
        students.rows += p.rows; students.bytes += p.bytes; students.cashCopyBytes += p.cashCopyBytes;
        students.largestRowBytes = Math.max(students.largestRowBytes, p.largestRowBytes);
        students.rosterLookupBytes += p.rosterLookupBytes; students.rosterLookupHits += p.rosterLookupHits;
        if (p.isDone) break;
        cursor = p.cursor;
      }

      const psRoster = { rows: 0, bytes: 0 };
      cursor = null;
      for (let i = 0; ; i++) {
        if (i >= MAX_PAGES) return await fail("psRoster needed more than 200 pages");
        const p: any = await ctx.runQuery(internal.readHeadroom.rosterPage, { cursor });
        psRoster.rows += p.rows; psRoster.bytes += p.bytes;
        if (p.isDone) break;
        cursor = p.cursor;
      }

      const mirror = { rows: 0, bytes: 0, docs: [] as Array<{ doc: string; rows: number; bytes: number }> };
      const byDoc = new Map<string, { rows: number; bytes: number }>();
      cursor = null;
      for (let i = 0; ; i++) {
        if (i >= MAX_PAGES) return await fail("legacyMirror needed more than 200 pages");
        const p: any = await ctx.runQuery(internal.readHeadroom.mirrorPage, { cursor });
        mirror.rows += p.rows; mirror.bytes += p.bytes;
        for (const d of p.docs as Array<{ doc: string; rows: number; bytes: number }>) {
          const x = byDoc.get(d.doc) ?? { rows: 0, bytes: 0 };
          x.rows += d.rows; x.bytes += d.bytes;
          byDoc.set(d.doc, x);
        }
        if (p.isDone) break;
        cursor = p.cursor;
      }
      mirror.docs = [...byDoc.entries()].map(([doc, x]) => ({ doc, ...x }));

      const small: any = await ctx.runQuery(internal.readHeadroom.smallReads, {});
      const trends: any = await ctx.runQuery(internal.readHeadroom.trendsContextReads, {});
      const nowIso = new Date().toISOString();
      const measure: HeadroomMeasure = {
        nowIso,
        cutoffIso: small.cutoffIso,
        students,
        psRoster,
        teachers: small.teachers,
        loadSettingsBytes: small.loadSettingsBytes,
        mirror,
        trendsContext: { rows: trends.rows, bytes: trends.bytes },
      };
      const readers = estimateReaders(measure);
      const MiB = (b: number) => Math.round((b / 1048576) * 100) / 100;
      result = {
        ok: true,
        measuredAt: nowIso,
        reason: reason ?? null,
        limitMiB: LIMIT_MIB,
        bands: { amberPct: AMBER_PCT, redPct: RED_PCT },
        headline: headroomHeadline(readers),
        readers,
        projectedDates: projectDates(readers, nowIso),
        growth: growthOf(measure),
        tables: {
          students: { rows: students.rows, MiB: MiB(students.bytes), cashCopyMiB: MiB(students.cashCopyBytes) },
          psRoster: { rows: psRoster.rows, MiB: MiB(psRoster.bytes) },
          enrolmentLookups: { rows: students.rosterLookupHits, MiB: MiB(students.rosterLookupBytes) },
          teachers: { rows: small.teachers.rows, MiB: MiB(small.teachers.bytes) },
          legacyMirror: { rows: mirror.rows, MiB: MiB(mirror.bytes) },
          trendsContextReads: { rows: trends.rows, MiB: MiB(trends.bytes) },
        },
        cutoff: small.cutoffIso,
        method: "whole-row JSON size of what each reader reads, summed; within 1% of Convex's own count " +
          "for ledger rows and 7-10% high for student and roster rows (2026-10-05)",
        tookMs: Date.now() - started,
      };
    } catch (e) {
      return await fail(`a measuring read threw: ${String((e as any)?.message ?? e).slice(0, 300)}`);
    }
    console.log(`[readHeadroom] ${result.headline}`);
    return await ctx.runMutation(internal.readHeadroom.recordResult, { result });
  },
});

/**
 * The last result. Read-only; deploy key. `ageHours` is how long ago it was
 * recorded, and `stale` is true past 36 hours: a nightly check that has
 * stopped running leaves its last good night here, and that must not read as
 * tonight's.
 */
export const latest = internalQuery({
  args: {},
  handler: async (ctx) => {
    const row = await ctx.db.query("appState")
      .withIndex("by_key", (q) => q.eq("key", STATE_KEY)).unique();
    const value = row ? (row.value as any) : null;
    const at = Date.parse(String(value?.recordedAt ?? ""));
    const ageHours = Number.isFinite(at) ? Math.round(((Date.now() - at) / 3600000) * 10) / 10 : null;
    return { found: Boolean(row), value, ageHours, stale: Boolean(row) && (ageHours === null || ageHours > 36) };
  },
});

/** Switch the audit entry on or off. See the note at the top of this file. */
export const configure = internalMutation({
  args: { auditEntries: v.boolean() },
  handler: async (ctx, { auditEntries }) => {
    const at = new Date().toISOString();
    const row = await ctx.db.query("appState")
      .withIndex("by_key", (q) => q.eq("key", CONFIG_KEY)).unique();
    const value = { ...((row?.value as any) ?? {}), auditEntries, changedAt: at };
    if (row) await ctx.db.patch(row._id, { value, mirroredAt: at });
    else await ctx.db.insert("appState", { key: CONFIG_KEY, value, mirroredAt: at });
    return { auditEntries, at };
  },
});
