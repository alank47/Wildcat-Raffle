// The leaderboard's stored copy: when it is rebuilt, and whether a build is
// kept. Run: npm test
//
// Every rule here is pure (leaderboardSnapshotRules.ts), so it is tested by
// the clock it will see: weekday mornings in daylight time, the first school
// days after the 1 November clock change, Saturdays, and the minutes the
// PowerSchool sync replaces the roster. The shipped source is transpiled as
// it is (fake-convex.mjs's loader), never copied.
//
// THE DEFAULT CADENCE IS PINNED (owner, 2026-10-13): every 15 minutes in
// school hours, so a board at least 10 minutes old is rebuilt and one 5
// minutes old is not.
import { loadConvex } from "../fake-convex.mjs";

let pass = 0, fail = 0;
const check = (n, c, why) => {
  c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${why ? "  (" + why + ")" : ""}`));
};
const J = (x) => JSON.stringify(x);

const loaded = await loadConvex(new URL("../", import.meta.url), ["leaderboardSnapshotRules", "leaderboardRules"]);
try {
  const R = loaded.mods.leaderboardSnapshotRules;
  const { LEADERBOARD_SNAPSHOT_VERSION } = loaded.mods.leaderboardRules;
  const TZ = "America/Los_Angeles";
  const ago = (iso, minutes) => new Date(Date.parse(iso) - minutes * 60000).toISOString();
  const later = (iso, minutes) => new Date(Date.parse(iso) + minutes * 60000).toISOString();
  const state = (nowIso, age, extra) => R.stateOrEmpty({
    snapshotId: "leaderboardSnapshots:1", version: LEADERBOARD_SNAPSHOT_VERSION, serve: "all",
    builtAt: ago(nowIso, age), ...(extra || {}),
  });
  const CFG = R.configOrDefault({ mode: "live" });
  const decide = (nowIso, age, o) => R.decideSnapshotTick({
    mode: o?.mode ?? "live", nowIso, tz: o && "tz" in o ? o.tz : TZ,
    state: o?.state ?? state(nowIso, age, o?.extra), config: o?.config ?? CFG, force: o?.force,
  });

  // Tuesday 2026-10-13, 08:03 PDT.
  const TUE_0803 = "2026-10-13T15:03:00.000Z";

  console.log("\n-- the cadence, by the school's wall clock --");
  {
    check("the default is every 15 minutes in school hours, 6 hours otherwise",
      CFG.schoolEveryMinutes === 15 && CFG.offHoursEveryMinutes === 360 && CFG.failGraceMinutes === 60 && CFG.maxAgeMinutes === 780);
    check("weekday 08:03 PDT, the 15-minute default: a board 10 minutes old is rebuilt",
      decide(TUE_0803, 10).build === true, J(decide(TUE_0803, 10)));
    check("  ...and one 5 minutes old is not", decide(TUE_0803, 5).build === false, J(decide(TUE_0803, 5)));
    const thirty = R.configOrDefault({ mode: "live", schoolEveryMinutes: 30 });
    check("set to 30: weekday 08:03 PDT builds at age 26, not at age 20",
      decide(TUE_0803, 26, { config: thirty }).build === true && decide(TUE_0803, 20, { config: thirty }).build === false);
    // Saturday 2026-10-17, 10:03 PDT.
    const SAT = "2026-10-17T17:03:00.000Z";
    check("Saturday: nothing at 2 hours, a build at 6 hours",
      decide(SAT, 120).build === false && decide(SAT, 360).build === true, J([decide(SAT, 120), decide(SAT, 360)]));
    check("  ...said as off hours", /off-hours/.test(decide(SAT, 120).why));
    // Weekday evening, 18:03 PDT.
    check("a weekday at 18:03 school time is off hours too", decide("2026-10-14T01:03:00.000Z", 30).build === false);
  }

  console.log("\n-- the sync windows, in UTC --");
  {
    const at = (hhmm) => `2026-10-13T${hhmm}:00.000Z`;
    check("UTC 13:03 and 19:03: no build", decide(at("13:03"), 600).build === false && decide(at("19:03"), 600).build === false,
      J([decide(at("13:03"), 600), decide(at("19:03"), 600)]));
    check("UTC 13:18 and 19:18: a build is allowed", decide(at("13:18"), 600).build === true && decide(at("19:18"), 600).build === true,
      J([decide(at("13:18"), 600), decide(at("19:18"), 600)]));
    check("UTC 13:33 and 19:48: no build", decide(at("13:33"), 600).build === false && decide(at("19:48"), 600).build === false);
    check("the windows' edges: 13:00 and 13:25 in, 13:15 and 14:00 out",
      R.inSyncWindow(at("13:00")) && R.inSyncWindow(at("13:25")) && R.inSyncWindow(at("19:59")) &&
      !R.inSyncWindow(at("13:15")) && !R.inSyncWindow(at("14:00")) && !R.inSyncWindow(at("12:59")) && !R.inSyncWindow(at("20:00")));
    check("not even a forced build or a missing copy starts inside one",
      decide(at("13:03"), 600, { force: true }).build === false &&
      decide(at("19:33"), 0, { state: R.stateOrEmpty(null) }).build === false);
  }

  console.log("\n-- the 1 November clock change --");
  {
    check("Friday 2026-10-30 07:03 PDT is school hours", decide("2026-10-30T14:03:00.000Z", 10).build === true &&
      /school-hours/.test(decide("2026-10-30T14:03:00.000Z", 10).why));
    check("Monday 2026-11-02 06:48 PST is school hours", decide("2026-11-02T14:48:00.000Z", 10).build === true &&
      /school-hours/.test(decide("2026-11-02T14:48:00.000Z", 10).why));
    check("06:30 school time is not", decide("2026-11-02T14:30:00.000Z", 10).build === false &&
      /off-hours/.test(decide("2026-11-02T14:30:00.000Z", 10).why));
    // Built 01:40 PDT on Sunday 1 November; at 01:18 PST, 38 minutes later,
    // the wall clock says the board was built 22 minutes in the future.
    const every30 = R.configOrDefault({ mode: "live", offHoursEveryMinutes: 30 });
    const across = R.decideSnapshotTick({ mode: "live", nowIso: "2026-11-01T09:18:00.000Z", tz: TZ, config: every30,
      state: R.stateOrEmpty({ snapshotId: "s", version: LEADERBOARD_SNAPSHOT_VERSION, serve: "all", builtAt: "2026-11-01T08:40:00.000Z" }) });
    check("age is measured in UTC: a board built before the clock went back is 38 minutes old, not -22",
      across.build === true && /off-hours/.test(across.why), J(across));
  }

  console.log("\n-- the switch, the lease, the version --");
  {
    check("no school time zone: the school cadence, and the reason says so",
      decide("2026-10-17T17:03:00.000Z", 10, { tz: null }).build === true &&
      /no-timezone/.test(decide("2026-10-17T17:03:00.000Z", 10, { tz: null }).why));
    check("mode off does nothing, not even with no copy at all",
      J(decide(TUE_0803, 600, { mode: "off", state: R.stateOrEmpty(null) })) === J({ build: false, markStale: null, why: "off" }));
    const lease = (minutesLeft) => ({ runId: "lb_x", startedAt: ago(TUE_0803, 2), expiresAt: later(TUE_0803, minutesLeft) });
    check("a build holding a live lease means no second one",
      decide(TUE_0803, 600, { extra: { lease: lease(5) } }).build === false && decide(TUE_0803, 600, { extra: { lease: lease(5) } }).why === "busy");
    check("  ...and an expired lease does not hold the next one up", decide(TUE_0803, 600, { extra: { lease: lease(-1) } }).build === true);
    check("no copy yet: build", decide(TUE_0803, 0, { state: R.stateOrEmpty(null) }).build === true);
    check("a copy written by another compactStudent (a deploy bumped the version): build at once",
      decide(TUE_0803, 1, { extra: { version: LEADERBOARD_SNAPSHOT_VERSION + 1 } }).build === true &&
      decide(TUE_0803, 1, { extra: { version: LEADERBOARD_SNAPSHOT_VERSION + 1 } }).why === "version");
    check("runNow (force) builds whatever the age", decide(TUE_0803, 1, { force: true }).build === true);
  }

  console.log("\n-- when the copy stops being served --");
  {
    const failingFor = (m) => decide(TUE_0803, 30, { extra: { firstFailAt: ago(TUE_0803, m) } });
    check("in live, a failure 60 minutes old marks it failing", failingFor(60).markStale === "failing");
    check("  ...59 minutes is still inside the grace", failingFor(59).markStale === null);
    check("in live, a board 780 minutes old marks it stale", decide(TUE_0803, 780).markStale === "stale");
    check("  ...779 does not", decide(TUE_0803, 779).markStale === null);
    check("in pilot too", decide(TUE_0803, 780, { mode: "pilot", extra: { serve: "pilot" } }).markStale === "stale");
    check("shadow never marks stale (it serves nobody)",
      decide(TUE_0803, 5000, { mode: "shadow", extra: { serve: "none", firstFailAt: ago(TUE_0803, 500) } }).markStale === null);
    check("a copy already not served is not marked again", decide(TUE_0803, 5000, { extra: { serve: "none" } }).markStale === null);
    check("stopping serving is decided inside a sync window and under a lease too",
      decide("2026-10-13T13:03:00.000Z", 900).markStale === "stale" &&
      decide(TUE_0803, 900, { extra: { lease: { runId: "x", startedAt: TUE_0803, expiresAt: later(TUE_0803, 5) } } }).markStale === "stale");
  }

  console.log("\n-- a held enrolment drop is read again, 20 minutes on --");
  {
    const held = (m) => decide(TUE_0803, 600, { extra: { pendingDrop: { at: ago(TUE_0803, m), enrolled: 300, syncAt: null } } });
    check("a pending drop builds at 20 minutes", held(20).build === true && held(20).why === "drop-recheck", J(held(20)));
    check("  ...and not at 15, however old the board", held(15).build === false && held(15).why === "drop-wait");
    const sat = "2026-10-17T17:03:00.000Z";
    check("  ...off hours as well", decide(sat, 30, { extra: { pendingDrop: { at: ago(sat, 25), enrolled: 300, syncAt: null } } }).build === true);
  }

  console.log("\n-- whether a build is kept --");
  {
    const NOW = "2026-10-13T18:03:00.000Z";
    const prev = { rows: 763, enrolled: 607, syncAt: "2026-10-13T13:04:00.000Z" };
    const base = { prev, pendingDrop: null, rows: 763, enrolled: 607, rosterSteady: true, syncAtNow: prev.syncAt, nowIso: NOW };
    const A = (o) => R.acceptBuild({ ...base, ...o });
    check("the roster moved during the build: refused", J(A({ rosterSteady: false })) === J({ verdict: "refuse", code: "roster-moved" }));
    check("no rows at all: refused", A({ rows: 0, prev: null }).code === "no-rows");
    // ONE STUDENT ROW DELETED BY HAND (review, 2026-10-13): refusing every
    // smaller build wedged the copy for good. A fall is held and re-read.
    const fewer = A({ rows: 762 });
    check("fewer student rows than last time is held, not kept and not refused for good",
      fewer.verdict === "hold" && fewer.code === "rows-held" && fewer.pendingDrop.rows === 762 && fewer.pendingDrop.at === NOW, J(fewer));
    check("  ...and kept when a build 20 minutes on reads the same count",
      J(A({ rows: 762, pendingDrop: fewer.pendingDrop, nowIso: later(NOW, 20) })) === J({ verdict: "accept", why: "rows-confirmed" }));
    const tooSoon = A({ rows: 762, pendingDrop: fewer.pendingDrop, nowIso: later(NOW, 15) });
    const other = A({ rows: 740, pendingDrop: fewer.pendingDrop, nowIso: later(NOW, 30) });
    check("  ...a re-read too soon stays held from the first time; a different count starts a new wait",
      tooSoon.verdict === "hold" && tooSoon.pendingDrop.at === NOW &&
      other.verdict === "hold" && other.pendingDrop.rows === 740 && other.pendingDrop.at === later(NOW, 30), J([tooSoon, other]));
    check("  ...and a lost page that comes back is simply kept", A({ rows: 763, pendingDrop: fewer.pendingDrop, nowIso: later(NOW, 5) }).verdict === "accept");
    check("more than 7,000 rows: refused", A({ rows: 7001 }).code === "too-many-rows" && A({ rows: 7000 }).verdict === "accept");
    check("the first build is kept", J(A({ prev: null })) === J({ verdict: "accept", why: "first" }));
    check("the same, more rows, or more enrolled: kept", A({}).verdict === "accept" && A({ rows: 770, enrolled: 615 }).verdict === "accept");
    check("a small drop (within max(15, 3%)) is kept", A({ enrolled: 607 - 18 }).verdict === "accept");
    const h = A({ enrolled: 300 });
    check("a big enrolment drop with no new sync is held, not kept",
      h.verdict === "hold" && h.code === "drop-held" && h.pendingDrop.at === NOW && h.pendingDrop.enrolled === 300 && h.pendingDrop.syncAt === prev.syncAt, J(h));
    check("  ...the threshold is 15 for a small school", R.acceptBuild({ ...base, prev: { ...prev, enrolled: 100 }, enrolled: 84 }).verdict === "hold");
    const pending = h.pendingDrop;
    check("held, then a build 20 minutes later that agrees within 2: kept",
      J(A({ enrolled: 302, pendingDrop: pending, nowIso: later(NOW, 20) })) === J({ verdict: "accept", why: "drop-confirmed" }));
    const early = A({ enrolled: 301, pendingDrop: pending, nowIso: later(NOW, 15) });
    check("  ...one that agrees too soon is held again, without restarting the wait",
      early.verdict === "hold" && early.pendingDrop.at === NOW);
    const moved = A({ enrolled: 250, pendingDrop: pending, nowIso: later(NOW, 30) });
    check("  ...one that disagrees starts a new wait from its own figure",
      moved.verdict === "hold" && moved.pendingDrop.enrolled === 250 && moved.pendingDrop.at === later(NOW, 30));
    check("a big drop with a newer sync on record is kept at once",
      J(A({ enrolled: 300, syncAtNow: "2026-10-13T19:05:00.000Z" })) === J({ verdict: "accept", why: "drop-new-sync" }));
  }

  console.log("\n-- the switch's settings --");
  {
    const d = R.configOrDefault(null);
    check("no config row: off, with the defaults", d.mode === "off" && d.schoolEveryMinutes === 15 && J(d.pilotIds) === "[]");
    check("an unknown mode is off", R.configOrDefault({ mode: "on" }).mode === "off");
    check("an unusable cadence falls back to its default, never to a guess",
      R.configOrDefault({ mode: "live", schoolEveryMinutes: 2 }).schoolEveryMinutes === 15 &&
      R.configOrDefault({ mode: "live", schoolEveryMinutes: "30" }).schoolEveryMinutes === 15 &&
      R.configOrDefault({ mode: "live", schoolEveryMinutes: 30 }).schoolEveryMinutes === 30);
    check("a pilot list keeps at most 50 distinct ids",
      R.configOrDefault({ pilotIds: Array.from({ length: 60 }, (_, i) => "p" + (i % 55)) }).pilotIds.length === 50);
    check("serve follows the mode: off and shadow none, pilot pilot, live all",
      R.serveFor("off") === "none" && R.serveFor("shadow") === "none" && R.serveFor("pilot") === "pilot" && R.serveFor("live") === "all");
    const NOW = "2026-10-13T23:00:00.000Z";
    const clean = { kind: "logic", at: ago(NOW, 60), comparisons: 4500, differ: 0, version: LEADERBOARD_SNAPSHOT_VERSION };
    check("live is allowed after a clean logic compare in the last 72 hours", R.liveRefusal(clean, NOW) === null);
    check("  ...but not on a logic compare made by another version of the copy (a deploy changed it since)",
      typeof R.liveRefusal({ ...clean, version: LEADERBOARD_SNAPSHOT_VERSION - 1 }, NOW) === "string" &&
      typeof R.liveRefusal({ ...clean, version: undefined }, NOW) === "string");
    check("  ...refused with none on record, a fresh one, differences, nothing compared, or one too old",
      R.liveRefusal(null, NOW) && R.liveRefusal({ ...clean, kind: "fresh" }, NOW) && R.liveRefusal({ ...clean, differ: 1 }, NOW) &&
      R.liveRefusal({ ...clean, comparisons: 0 }, NOW) && R.liveRefusal({ ...clean, at: ago(NOW, 73 * 60) }, NOW));
    const days = Array.from({ length: 10 }, (_, i) => ({ day: `2026-10-0${i}`, builds: 1, refusals: 0, bytesRead: 5 }));
    const bumped = R.bumpDay(days, "2026-10-13", { builds: 1, bytesRead: 7 });
    check("builds are counted by day, the last eight kept",
      bumped.length === 8 && bumped[7].day === "2026-10-13" && bumped[7].builds === 1 && bumped[7].bytesRead === 7);
    const rows = Array.from({ length: 40 }, (_, i) => (i % 5 === 0 ? { id: "x" + i, enrolled: false } : { id: "x" + i }));
    const sample = R.spreadSample(rows, ["x1"], 10);
    check("a pilot sample is enrolled students only, spread through the school, no shared ids",
      sample.length === 10 &&
      sample.every((id) => rows.find((r) => r.id === id).enrolled !== false) && !sample.includes("x1") &&
      new Set(sample).size === 10 && J(R.spreadSample(rows, ["x1"], 10)) === J(sample));
  }
} finally {
  loaded.cleanup();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
