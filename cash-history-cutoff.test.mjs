// The browser was the one resurrecting last term's cash, and a reload made it
// worse rather than better.
//
// THE INCIDENT, 2026-09-14. Student launch day. Three times the owner reported
// Wildcat Cash from before that morning's 8:30 history clear reappearing in
// analytics. Two server write paths were found and guarded -- the cash_tx_*
// ledger in legacyData:mergeSlice, then the per-student arrays in
// appDataShape.planPatch -- and the database was measured clean and held flat
// for twelve one-minute samples. The old figures were still on screen.
//
// Because by then it was not the database. It was the tab, on every boot:
//
//   1. loadData() runs before a session exists. The Convex query refuses with
//      "Not signed in to Convex", and the catch calls loadDataLocal(), which
//      fills `students` from the localStorage `raffleData` blob -- including
//      each student's wildcatCashTransactions from before the clear.
//   2. The session lands and loadData() re-runs successfully. `students` is now
//      non-empty, so it takes the MERGE branch (script.js ~2458), which spreads
//      `...localStudent` over `...serverStudent`. The four cash COUNTERS are
//      taken back from the server on the next line -- that was fixed after the
//      2026-09-13 $4.9M resurrection -- but wildcatCashTransactions was not, so
//      the local array won.
//   3. reconcileCashLedger() unions those arrays into `cashTransactions`, which
//      is the array every cash analytic counts. "628 movement(s) recovered".
//
// A cache-stamp bump was going to be the fix for the display. It could not have
// been: the reload goes through step 1 again and lands in exactly the same
// place. This is the fix -- the server hands down the cutoff it already
// enforces on writes, and the client applies the same rule, with the same hour
// of clock slack, to what the local overlay may contribute.
//
// Run: npm test

import { readFileSync } from "node:fs";

const code = readFileSync(new URL("./script.js", import.meta.url), "utf8");
const load = readFileSync(new URL("./convex/appData.ts", import.meta.url), "utf8");
const shape = readFileSync(new URL("./convex/appDataShape.ts", import.meta.url), "utf8");

let pass = 0, fail = 0;
const check = (n, c, d) => {
  if (c) { pass++; console.log(`  PASS  ${n}`); }
  else { fail++; console.log(`  FAIL  ${n}${d ? "  (" + d + ")" : ""}`); }
};

/** Lift one 8-space-indented function out of the shipped script.js. */
const lift = (name) => {
  const start = code.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} is not in script.js`);
  const end = code.indexOf("\n        }\n", start) + 11;
  return code.slice(start, end);
};

// The real functions, executed. Not regexes over them: the whole class of bug
// here was code that looked right and merged the wrong way round.
const makeH = (store) => new Function("localStorage",
  "const HISTORY_CUTOFF_KEY = 'wcHistoryCutoff';\n" +
  "const HISTORY_CUTOFF_SLACK_MS = 3600000;\n" +
  // The seed expression is lifted from the shipped file rather than retyped,
  // so a change to how a boot recovers the cutoff is a change this test sees.
  "let _historyCutoffMs = " + seedSrc + ";\n" +
  lift("noteHistoryCutoff") + lift("cashRowIsPreCutoff") +
  lift("cashRowKey") + lift("mergeCashHistory") +
  "\nreturn { noteHistoryCutoff, cashRowIsPreCutoff, cashRowKey, mergeCashHistory," +
  " cutoff: () => _historyCutoffMs };")(store);

/** A localStorage stand-in. `throws` models private mode, where every call throws. */
const fakeStorage = (seed, throws) => {
  const map = new Map(seed ? [["wcHistoryCutoff", seed]] : []);
  return {
    getItem: (k) => { if (throws) throw new Error("denied"); return map.has(k) ? map.get(k) : null; },
    setItem: (k, v) => { if (throws) throw new Error("denied"); map.set(k, String(v)); },
    removeItem: (k) => { if (throws) throw new Error("denied"); map.delete(k); },
    _map: map,
  };
};

// The seed expression as shipped: `(function () { ... })()` after the `=`.
const seedSrc = (() => {
  const at = code.indexOf("let _historyCutoffMs = ");
  const end = code.indexOf(";", code.indexOf("})()", at));
  return code.slice(at + "let _historyCutoffMs = ".length, end);
})();

const H = makeH(fakeStorage(null, false));

const CUTOFF_ISO = "2026-09-14T15:30:00Z";   // 8:30am PDT, the real one

console.log("\nThe cutoff the server sends is the cutoff the client applies");
{
  H.noteHistoryCutoff(CUTOFF_ISO);
  check("an ISO cutoff is remembered as a number",
    H.cutoff() === Date.parse(CUTOFF_ISO));
  H.noteHistoryCutoff(null);
  check("null clears it", H.cutoff() === null);
  H.noteHistoryCutoff("not a date");
  check("and so does junk, rather than becoming NaN", H.cutoff() === null);
}

console.log("\nWhat counts as pre-cutoff");
{
  H.noteHistoryCutoff(CUTOFF_ISO);
  check("a row from last term is stale",
    H.cashRowIsPreCutoff({ timestamp: "2026-08-20T16:37:14.634Z" }) === true);
  check("a row from this morning is not",
    H.cashRowIsPreCutoff({ timestamp: "2026-09-14T16:42:29.550Z" }) === false);

  // AN UNDATED ROW IS NEVER STALE. It cannot be proved old, and dropping a
  // teacher's award to look tidy is the worse error. Same decision as
  // pruneHistoryArray on the server.
  check("an undated row is never stale", H.cashRowIsPreCutoff({ amount: 100 }) === false);
  check("nor is a row with an unparseable date",
    H.cashRowIsPreCutoff({ timestamp: "sometime tuesday" }) === false);

  // CLOCK SLACK, the same hour the server allows.
  check("thirty minutes before the cutoff is kept",
    H.cashRowIsPreCutoff({ timestamp: "2026-09-14T15:00:00Z" }) === false);
  check("two hours before it is not",
    H.cashRowIsPreCutoff({ timestamp: "2026-09-14T13:00:00Z" }) === true);

  // NO CUTOFF, NOTHING STALE. A tab that has never had a successful load knows
  // no cutoff, and must not start deleting history on a guess.
  H.noteHistoryCutoff(null);
  check("with no cutoff known, nothing is stale",
    H.cashRowIsPreCutoff({ timestamp: "2020-01-01T00:00:00Z" }) === false);
}

console.log("\nThe load-time merge: the server's history, plus only what it would accept");
{
  H.noteHistoryCutoff(CUTOFF_ISO);
  const server = [
    { id: "a", amount: 100, timestamp: "2026-09-14T16:00:00Z" },
    { id: "b", amount: 100, timestamp: "2026-09-14T17:00:00Z" },
  ];

  // THE ACTUAL INCIDENT: a localStorage copy from before the clear.
  const stalePreClear = [
    { id: "old1", amount: -4000, timestamp: "2026-08-18T21:58:35.993Z" },
    { id: "old2", amount: 100, timestamp: "2026-09-11T06:14:26.811Z" },
  ];
  const healed = H.mergeCashHistory(server, stalePreClear);
  check("a pre-clear local copy contributes nothing",
    healed.map((r) => r.id).join(",") === "a,b");

  // AND THE AWARD THIS TAB JUST MADE STILL SURVIVES. That is the whole reason
  // this is a filter and not `serverStudent.wildcatCashTransactions`: a tab
  // mid-save holds a row the server has not got yet.
  const withOwnWork = H.mergeCashHistory(server, [
    ...stalePreClear,
    { id: "mine", amount: 250, timestamp: "2026-09-14T18:30:00Z" },
  ]);
  check("but an unsaved award made since the clear does not",
    withOwnWork.map((r) => r.id).join(",") === "a,b,mine");

  // An undated local row is kept, for the same reason it is never stale.
  check("an undated local row is kept",
    H.mergeCashHistory(server, [{ id: "u", amount: 100 }]).length === 3);

  // DEDUPE. The server's copy and the tab's copy of the same award are one row.
  check("the same row from both sides appears once",
    H.mergeCashHistory(server, [{ id: "a", amount: 100, timestamp: "2026-09-14T16:00:00Z" }])
      .length === 2);

  // The server's rows are taken as they are -- they are inside the cutoff by
  // definition, because that is what the save enforces. Even a server row that
  // somehow predates the cutoff is kept rather than silently dropped: the
  // client is not the authority on what the database holds.
  const oddServerRow = H.mergeCashHistory(
    [{ id: "z", amount: 100, timestamp: "2026-01-01T00:00:00Z" }], []);
  check("a server row is never dropped by the client", oddServerRow.length === 1);

  // Nothing at all is a valid answer, not a crash.
  check("undefined on either side is handled",
    H.mergeCashHistory(undefined, undefined).length === 0
    && H.mergeCashHistory(null, [{ id: "x", timestamp: "2026-09-14T16:00:00Z" }]).length === 1);

  // WITH NO CUTOFF the merge is a plain union, which is the behaviour before
  // any of this existed.
  H.noteHistoryCutoff(null);
  check("with no cutoff the merge drops nothing",
    H.mergeCashHistory(server, stalePreClear).length === 4);
}

console.log("\nAnd it is wired into the paths that actually run");
{
  // THE MERGE LINE. Without this the `...localStudent` spread above it wins and
  // the whole incident repeats. Pinned by shape, not by argument list.
  check("the load-time merge takes the history through mergeCashHistory",
    /\.\.\.serverCashCounters\(serverStudent\),[\s\S]{0,1500}wildcatCashTransactions: mergeCashHistory\(\s*serverStudent\.wildcatCashTransactions,\s*localStudent\.wildcatCashTransactions\)/
      .test(code));   // the window is wide because the WHY sits between them
  check("and it comes AFTER the local overlay, so it wins",
    code.indexOf("...localStudent,") <
    code.indexOf("wildcatCashTransactions: mergeCashHistory("));

  // THE CUTOFF IS CAPTURED AT THE ONE CHOKE POINT every successful load passes
  // through, before anything merges.
  // ORDER, NOT ADJACENCY. This was a 200-character proximity window, which
  // broke the moment the cash rebase moved in between the two lines on
  // 2026-09-22 -- a real and necessary change that the assertion called a
  // regression. What actually matters is that both run inside this loader,
  // base first, and that the cutoff is recorded before the function returns.
  {
    const fn = code.slice(code.indexOf("async function loadRosterFromConvex"));
    const body = fn.slice(0, fn.indexOf("\n        }"));
    // RE-POINTED 2026-09-23. The cash base is no longer seeded here at the
    // read: it is seeded when the rows go on screen, by install() ->
    // commitRosterCash, because loadData shows them seconds later. What this
    // pins is unchanged in substance: the cutoff is recorded by the loader,
    // before any caller can install (and so merge) the rows.
    const install = body.indexOf("install() {");
    const cutoff = body.indexOf("noteHistoryCutoff(data.historyCutoff)");
    check("loadRosterFromConvex records the cutoff the server sent", cutoff > 0);
    check("and records it before the rows can be installed and merged",
      install > 0 && cutoff > 0 && cutoff < install, `cutoff ${cutoff} install ${install}`);
  }

  // THE FUNNEL. reconcileCashLedger is the single path from the per-student
  // arrays into the array the analytics count.
  // The window widened: the same funnel now also rejects a row with no usable
  // amount, which is what reached a teacher's screen as
  // "Alan Kent | Unknown | Negative | -$NaN" on 2026-09-16. An undated row is
  // kept on purpose and can therefore never age out, so junk out of a
  // localStorage fallback copy needed a different test -- an amount is the one
  // field a cash movement cannot be missing.
  check("reconcileCashLedger refuses a pre-cutoff row",
    /function reconcileCashLedger\(\)[\s\S]{0,2400}if \(cashRowIsPreCutoff\(t\)\) return;/
      .test(code));
  check("and a row carrying no money at all",
    /function reconcileCashLedger\(\)[\s\S]{0,2400}if \(!isFinite\(Number\(t\.amount\)\)\) return;/
      .test(code));

  // THE FALLBACK COPY. loadDataLocal runs before EVERY successful load, because
  // the first loadData() call has no session yet. It is where the stale rows
  // entered memory.
  // Window widened 900 -> 1300 on 2026-09-23: loadDataLocal now also shows
  // each balance as base + pending list (showCashByTheRule) right after it
  // reads the copy. The pruning pinned here is untouched.
  check("loadDataLocal prunes the localStorage copy it reads",
    /function loadDataLocal\(\)[\s\S]{0,1300}st\.wildcatCashTransactions\.filter\(t => !cashRowIsPreCutoff\(t\)\)/
      .test(code));

  // THE SERVER SENDS IT. Without this the client's cutoff is always null and
  // every rule above is inert.
  check("appData:load returns the cutoff",
    /historyCutoff: \(cutoffRow\?\.value as Record<string, unknown> \| undefined\)\?\.iso \?\? null/
      .test(load));
  check("read from the appState key the purge tool writes",
    /q\.eq\("key", "historyCutoff"\)/.test(load));

  // BOTH ENDS AGREE ABOUT THE SLACK. If these drift, the server refuses rows
  // the client keeps showing, or the client hides rows the server accepted.
  const clientSlack = /const HISTORY_CUTOFF_SLACK_MS = (\d+);/.exec(code)?.[1];
  const serverSlack = /const HISTORY_SLACK_MS = ([^;]+);/.exec(shape)?.[1];
  check("the client's slack is an hour", clientSlack === "3600000");
  check("and so is the server's", /60 \* 60 \* 1000/.test(String(serverSlack)),
    String(serverSlack));
}

console.log("\nA boot knows the cutoff before it has loaded anything");
{
  // WHY THIS EXISTS. loadData() runs before a session exists, so loadDataLocal()
  // reads the localStorage copy while the page has not yet heard from the
  // server. With nothing seeded the cutoff is null at that moment, nothing is
  // filtered, and reconcileCashLedger unions the pre-clear rows into the ledger
  // -- the exact sequence this file's header describes. The successful load a
  // second later replaces the ledger outright, so it self-corrects WHEN THE
  // SESSION COMES BACK. A tab whose session does not resume, or whose roster
  // query throws, sits on the resurrected figures indefinitely.
  const seeded = makeH(fakeStorage("2026-09-14T15:30:00Z", false));
  check("a boot recovers the last cutoff it was told",
    seeded.cutoff() === Date.parse("2026-09-14T15:30:00Z"));
  check("and filters with it before any load has happened",
    seeded.cashRowIsPreCutoff({ timestamp: "2026-08-20T16:37:14.634Z" }) === true);

  check("junk in storage seeds nothing rather than NaN",
    makeH(fakeStorage("last tuesday", false)).cutoff() === null);
  check("an empty store seeds nothing",
    makeH(fakeStorage(null, false)).cutoff() === null);

  // PRIVATE MODE. Every localStorage call throws. No cutoff is the safe answer:
  // it keeps MORE history, never less.
  check("a storage that throws is survivable at boot",
    makeH(fakeStorage("2026-09-14T15:30:00Z", true)).cutoff() === null);
  const hostile = makeH(fakeStorage(null, true));
  hostile.noteHistoryCutoff("2026-09-14T15:30:00Z");
  check("and the session still applies the cutoff in memory",
    hostile.cutoff() === Date.parse("2026-09-14T15:30:00Z"));
}

console.log("\nAnd a cutoff the server withdraws is withdrawn everywhere");
{
  // If an admin clears the cutoff (legacyPurge:setHistoryCutoff with iso: null)
  // and the cached copy stayed behind, every tab would go on hiding history the
  // server is happy to serve -- an invisible filter on data nobody asked to
  // hide.
  const store = fakeStorage(null, false);
  const h = makeH(store);
  h.noteHistoryCutoff("2026-09-14T15:30:00Z");
  check("setting the cutoff stores it",
    store._map.get("wcHistoryCutoff") === "2026-09-14T15:30:00.000Z");
  h.noteHistoryCutoff(null);
  check("clearing it removes the stored copy too",
    !store._map.has("wcHistoryCutoff") && h.cutoff() === null);

  // Junk from the server clears it as well, rather than leaving the old one
  // quietly in force.
  const store2 = fakeStorage("2026-09-14T15:30:00Z", false);
  makeH(store2).noteHistoryCutoff("not a date");
  check("and so does an unusable answer", !store2._map.has("wcHistoryCutoff"));
}

{
  // The seed and the store agree on the key, which is the one thing that would
  // silently break the round trip.
  check("the boot seed reads the key noteHistoryCutoff writes",
    /const HISTORY_CUTOFF_KEY = 'wcHistoryCutoff';/.test(code)
    && /localStorage\.getItem\(HISTORY_CUTOFF_KEY\)/.test(code)
    && /localStorage\.setItem\(HISTORY_CUTOFF_KEY,/.test(code)
    && /localStorage\.removeItem\(HISTORY_CUTOFF_KEY\)/.test(code));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
