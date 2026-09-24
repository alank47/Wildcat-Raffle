// Cash behaviours have to actually save. Run: npm test
//
// THE BUG, reported by the owner 2026-09-24: "I went to cash settings and I
// tried to add a new behavior, it showed it saved but did not show on the
// system." wildcatCashBehaviors was a hardcoded list that no save carried and
// no load read -- the reward catalogue's bug (rewards-persist.test.mjs), a
// second time, missed when rewards were fixed. The console said only
// "Saved to localStorage": this browser's own copy, never the server's.
//
// The fix saves the list beside the rewards (merged by id), restores it on
// load, retires instead of deleting (the server's union by id would bring a
// deleted one back), confirms only what the server accepted, and pulls the
// list on the idle timer so forty open tabs see an addition without reloading.
import { readFileSync } from "node:fs";

const script = readFileSync(new URL("./script.js", import.meta.url), "utf8");
const storeSrc = readFileSync(new URL("./wildcat-store.js", import.meta.url), "utf8");
const legacy = readFileSync(new URL("./convex/legacyData.ts", import.meta.url), "utf8");
const dirtySrc = readFileSync(new URL("./wildcat-dirty.js", import.meta.url), "utf8");
new Function(dirtySrc)();
const Dirty = globalThis.WildcatDirty;
const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
new Function(storeSrc)();
const S = globalThis.WildcatStore;

let pass = 0, fail = 0;
const check = (n, c, why) => {
  c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${why ? "  (" + why + ")" : ""}`));
};

const CORE = [
  { id: "wc1", name: "Be Present", points: 100, type: "positive" },
  { id: "wc5", name: "Not Being Present", points: -100, type: "negative" },
];
const T0 = Date.parse("2026-09-24T15:00:00Z");
const iso = (ms) => new Date(ms).toISOString();

console.log("\n-- the rules for one behaviour --");
{
  check("a name, a type and a non-zero whole amount are required",
    !S.validateBehavior({ name: "", type: "positive", points: 50 }).ok
      && !S.validateBehavior({ name: "Help", type: "sideways", points: 50 }).ok
      && !S.validateBehavior({ name: "Help", type: "positive", points: 0 }).ok
      && !S.validateBehavior({ name: "Help", type: "positive", points: 12.5 }).ok
      && S.validateBehavior({ name: "Help", type: "positive", points: 50 }).ok);
  check("the sign follows the type: a deduction is always negative, an award always positive",
    S.normalizeBehavior({ id: "a", name: "x", points: 50, type: "negative" }, T0, {}).points === -50
      && S.normalizeBehavior({ id: "b", name: "x", points: -50, type: "positive" }, T0, {}).points === 50);
  // Ids go into an onclick attribute, and every behaviour now comes back from
  // the server as something another person wrote.
  check("an id that is not a plain token is refused (it would sit inside an onclick)",
    S.normalizeBehavior({ id: "x');alert(1);//", name: "x", points: 5, type: "positive" }, T0, {}) === null);
  const r = S.retireBehavior({ id: "wc_custom_1", name: "Help", points: 50, type: "positive", custom: true }, T0, { name: "Admin" });
  check("retiring sets active false, retiredAt and retiredBy", r.active === false && r.retiredAt === iso(T0) && r.retiredBy === "Admin");
  // The server keeps whichever copy has the newer updatedAt (legacyData
  // touchedAt). A retirement that did not move it would lose to the stored
  // active copy and the behaviour would come back -- the reward lesson.
  check("...and ALSO updatedAt, so the retirement wins the server's merge", r.updatedAt === iso(T0));
  const fields = legacy.slice(legacy.indexOf("function touchedAt"), legacy.indexOf("function touchedAt") + 400);
  check("the server's merge really does decide on updatedAt", /"updatedAt"/.test(fields));
}

console.log("\n-- two tabs, one list (the merge a tab and the server both use) --");
{
  const custom = { id: "wc_custom_1", name: "Helping a classmate", points: 50, type: "positive", custom: true,
    createdAt: iso(T0), updatedAt: iso(T0) };
  // Tab A added it and saved; tab B loads the server's list.
  const tabB = S.mergeBehaviorLists(CORE, [...CORE, custom], CORE, T0);
  check("a behaviour saved by one tab appears in another tab's list", tabB.some((b) => b.id === "wc_custom_1" && b.active));
  // Tab A retires it later; tab B, still holding the active copy, saves --
  // the retirement must survive, and tab B must adopt it on its next pull.
  const retired = S.retireBehavior(custom, T0 + 60000, { name: "Admin" });
  const server = S.mergeBehaviorLists([...CORE, custom], [...CORE, retired], CORE, T0 + 70000);
  check("a retirement beats an older active copy: it does NOT come back", server.find((b) => b.id === "wc_custom_1").active === false);
  // A behaviour this tab has not finished saving is not dropped by a pull.
  const mine = { id: "wc_custom_2", name: "Mine", points: 20, type: "positive", custom: true, createdAt: iso(T0 + 5), updatedAt: iso(T0 + 5) };
  check("a behaviour only this tab knows is kept when the server's list arrives",
    S.mergeBehaviorLists([...CORE, mine], [...CORE, custom], CORE, T0).some((b) => b.id === "wc_custom_2"));
  // The core eight are always there and always on, whatever the server says.
  const damaged = S.mergeBehaviorLists(CORE, [custom, Object.assign({}, CORE[0], { active: false, retiredAt: iso(T0) })], CORE, T0);
  check("a core behaviour missing from the server is put back", damaged.some((b) => b.id === "wc5"));
  check("...and a core behaviour marked retired is kept on (it cannot be removed from the screen)",
    damaged.find((b) => b.id === "wc1").active === true);
  check("order: the core list first, then the school's own, oldest first",
    S.mergeBehaviorLists(CORE, [mine, custom], CORE, T0).map((b) => b.id).join() === "wc1,wc5,wc_custom_1,wc_custom_2");
  check("a row that cannot be a behaviour (no name, zero amount, bad id) is dropped, not guessed at",
    S.mergeBehaviorLists(CORE, [{ id: "z", name: "", points: 5 }, { id: "y", name: "Y", points: 0 }, { id: "a b", name: "Q", points: 5 }], CORE, T0).length === 2);
}

console.log("\n-- the list is saved, restored, and cached --");
{
  const lists = script.slice(script.indexOf("const secondaryLists = {"), script.indexOf("};", script.indexOf("const secondaryLists = {")));
  check("wildcatCashBehaviors is in secondaryLists, beside the rewards", /wildcatCashRewards,[\s\S]*wildcatCashBehaviors,/.test(lists));
  check("which are written with mergeLegacySlice on 'id'", /mergeLegacySlice\('secondary', key, sent, 'id'\)/.test(script));
  // Taking the saved array back at the end of a save could put an OLDER list
  // over one a refresh swapped in meanwhile (found in review).
  check("the end of a save does NOT put an older behaviour list back", !/wildcatCashBehaviors = mergedSecondary\.wildcatCashBehaviors;/.test(script));
  check("the loader reads the server's list and merges it onto the core",
    /const serverBehaviors = secondaryData\.wildcatCashBehaviors;[\s\S]{0,300}mergeBehaviorLists\(\s*wildcatCashBehaviors, serverBehaviors, CORE_CASH_BEHAVIORS/.test(script));
  check("so does the offline fallback load", /data\.wildcatCashBehaviors, CORE_CASH_BEHAVIORS/.test(script));
  const success = script.slice(script.indexOf("// Also save to localStorage"), script.indexOf("}));", script.indexOf("// Also save to localStorage")));
  check("the offline copy carries it", /wildcatCashBehaviors,/.test(success));
  const fallback = script.slice(script.indexOf("// Fall back to localStorage only"), script.indexOf("}));", script.indexOf("// Fall back to localStorage only")));
  check("and so does the copy written when the server save fails", fallback.length > 200 && /wildcatCashBehaviors,/.test(fallback));
  check("the manual backup carries it", /wildcatCashRewards,\s*wildcatCashBehaviors,\s*cashYearArchives,/.test(script));
  check("the core defaults stay as the seed, copied rather than shared",
    /const CORE_CASH_BEHAVIORS = \[/.test(script) && /let wildcatCashBehaviors = CORE_CASH_BEHAVIORS\.map\(b => Object\.assign\(\{\}, b\)\);/.test(script));
  check("legacyData needed no behaviour-specific merge code (mergeSlice is generic)", !/mergeSlice[\s\S]{0,4000}wildcatCashBehaviors/.test(legacy.slice(legacy.indexOf("export const mergeSlice"))));
}

console.log("\n-- second review (2026-09-24): the timing, the clock, the cap --");
{
  // THE TIMING BUG, replayed with the real fingerprint code. A save starts
  // sending the list; the admin adds a behaviour while it is in flight; the
  // save finishes. Marking the LIVE list recorded the new one as written, so
  // the next save skipped it and it never reached the server.
  const live = [{ id: "wc1" }];
  const bad = Dirty.create();
  const sentOld = JSON.parse(JSON.stringify(live));        // what the request carried
  live.push({ id: "wc_custom_9" });                          // added mid-flight
  bad.markWritten("k", live);                                // the old way
  check("the old way: the mid-flight addition looked saved (proving the bug was real)", bad.changed("k", live) === false);
  const good = Dirty.create();
  good.markWritten("k", sentOld);                            // the new way
  check("the new way: the addition still counts as unsaved, so the next save sends it", good.changed("k", live) === true);
  const loop = script.slice(script.indexOf("const secondaryWrites = [];"), script.indexOf("const secondaryResults = await"));
  check("both secondary save loops send a copy and mark THAT copy",
    (loop.match(/const sent = JSON\.parse\(JSON\.stringify\(value\)\);/g) || []).length === 2
      && (loop.match(/saveDirty\.markWritten\('secondary:' \+ key, sent\)/g) || []).length === 2
      && !/markWritten\('secondary:' \+ key, value\)/.test(loop));

  // A pull that changes nothing must not look like a change (it re-sent the
  // whole list after every idle pull, widening the timing window).
  const once = S.mergeBehaviorLists(CORE, [...CORE], CORE, T0);
  const again = S.mergeBehaviorLists(once, [...CORE], CORE, T0 + 3600000);
  check("a merge that brings nothing new gives the identical list an hour later", JSON.stringify(once) === JSON.stringify(again));

  // The core eight come from the code: a stored copy cannot rename or reprice them.
  const tampered = S.mergeBehaviorLists(CORE, [{ id: "wc1", name: "Be Present", points: 5000, type: "positive", updatedAt: iso(T0 + 999999) }], CORE, T0);
  check("a stored copy cannot change a core behaviour's amount or name", tampered.find((b) => b.id === "wc1").points === 100);

  // The clock: a retirement always outranks the copy it retires.
  const ahead = { id: "wc_custom_1", name: "Typo", points: 10, type: "positive", custom: true, updatedAt: iso(T0 + 300000) };
  const r = S.retireBehavior(ahead, T0, { name: "Admin" });          // this device is five minutes behind
  check("a retirement from a slow clock is still newer than the copy it retires",
    Date.parse(r.updatedAt) > Date.parse(ahead.updatedAt), r.updatedAt);

  // The cap: the server refuses any single movement over $5,000.
  check("$5,000 is allowed, $5,001 is refused with a reason",
    S.validateBehavior({ name: "Big", type: "positive", points: 5000 }).ok
      && /cannot be more than \$5000/.test(S.validateBehavior({ name: "Big", type: "positive", points: 5001 }).errors.join()));
  check("the store's limit is the server's (MAX_CASH_DELTA 5000)",
    /MAX_CASH_DELTA = 5000/.test(readFileSync(new URL("./convex/appDataShape.ts", import.meta.url), "utf8"))
      && /var BEHAVIOR_MAX_AMOUNT = 5000;/.test(storeSrc));
  check("and the form says so too", /id="newBehaviorPoints"[^>]*max="5000"/.test(html));

  check("the 'Most Common Behaviors' tally has no prototype for a name like __proto__ to poison",
    /const behaviorFreq = Object\.create\(null\);/.test(script));
  check("the idle pull waits while a save is running", /if \(typeof isSyncing !== 'undefined' && isSyncing\) return;/.test(script));
}

console.log("\n-- it says what really happened --");
{
  const add = script.slice(script.indexOf("async function addNewBehavior"), script.indexOf("function updateBehaviorsList"));
  check("adding WAITS for the save before saying anything", /landed = await saveBehaviorListTruthfully\(\{/.test(add));
  check("the old unconditional 'added successfully' is gone from the code", !/alert\(['"`]✅ Behavior added successfully/.test(script));
  check("a save that did not land says so, plainly", /was NOT saved to the server/.test(add));
  const truth = script.slice(script.indexOf("async function saveBehaviorListTruthfully"), script.indexOf("let _behaviorSaving"));
  check("'landed' is decided by THIS list's fingerprint, not by unrelated writes in the same save",
    /if \(saveDirty\.changed\('secondary:wildcatCashBehaviors', wildcatCashBehaviors\)\) return false;/.test(truth));
  check("...and then by the server's own copy of the row that changed (an accepted write can be outranked)",
    /const row = await behaviorOnServer\(expect\.id\);/.test(truth)
      && /saveBehaviorListTruthfully\(\{ id: behavior\.id, active: true \}\)/.test(script)
      && /saveBehaviorListTruthfully\(\{ id: retired\.id, active: false \}\)/.test(script));
  check("a double click saves once", /if \(_behaviorSaving\) return;/.test(add));
  check("the same name twice is refused", /already exists/.test(add));
}

console.log("\n-- removing is retiring --");
{
  const del = script.slice(script.indexOf("async function deleteBehavior"), script.indexOf("let _behaviorsPulledAt"));
  check("a removed behaviour is RETIRED, never spliced out (the server would bring it back)",
    /retireBehavior\(/.test(del) && !/\.splice\(/.test(del));
  check("only the school's own can be removed, never a core one", /!wildcatCashBehaviors\[index\]\.custom\) return;/.test(del));
  const list = script.slice(script.indexOf("function updateBehaviorsList"), script.indexOf("async function deleteBehavior"));
  check("the settings list hides retired behaviours", /wildcatCashBehaviors\.filter\(b => b\.active !== false\)/.test(list));
  // Every award and deduct menu already filtered on active.
  const menus = (script.match(/wildcatCashBehaviors\.filter\(b => b\.type === [^)]*b\.active !== false\)/g) || []).length;
  check("the award and deduct menus leave retired ones out (three menus)", menus >= 3, String(menus));
}

console.log("\n-- names are text, never markup --");
{
  const list = script.slice(script.indexOf("function updateBehaviorsList"), script.indexOf("async function deleteBehavior"));
  check("the settings list escapes the name", /escapeHtml\(String\(behavior\.name \|\| ''\)\)/.test(list) && !/\$\{behavior\.name\}/.test(list));
  check("and the id inside the onclick", /deleteBehavior\('\$\{escapeHtml\(String\(behavior\.id\)\)\}'\)/.test(list));
  check("the 'Most Common Behaviors' report escapes it too", /font-weight: 600;">\$\{escapeHtml\(String\(name\)\)\}<\/span>/.test(script));
  check("the name box is limited to 60 characters, as the rule is", /id="newBehaviorName"[^>]*maxlength="60"/.test(html));
}

console.log("\n-- the other forty tabs, without anyone reloading --");
{
  check("the idle timer pulls the list", /pullCashBehaviors\(\);/.test(script.slice(script.indexOf("autoRefreshInterval = setInterval")))
  );
  const pull = script.slice(script.indexOf("async function pullCashBehaviors"), script.indexOf("async function pullCashBehaviors") + 1600);
  check("at most every five minutes, staff only", /Date\.now\(\) - _behaviorsPulledAt < 5 \* 60 \* 1000/.test(pull) && /!currentUser/.test(pull));
  check("merged by the same rule, never replaced", /mergeBehaviorLists\(\s*wildcatCashBehaviors, server, CORE_CASH_BEHAVIORS/.test(pull));
  const q = legacy.slice(legacy.indexOf("export const loadSlice"), legacy.indexOf("export const loadDoc"));
  check("the server read is staff only", /await requireStaff\(ctx\)/.test(q));
  check("and a narrow door: only the slices it lists", /SLICES_READABLE_ALONE\[doc\] \|\| \[\]\)\.includes\(collection\)/.test(q)
    && /secondary: \["wildcatCashBehaviors"\]/.test(legacy));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
