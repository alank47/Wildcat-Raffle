// Guards for the Convex cutover that cannot be unit tested through an import,
// because script.js is a 20,000 line browser file with no module boundary.
//
// These read the source. That is a weak form of test and it is the right one
// here: both failures below are SILENT in a browser. Losing the fallback shows
// up as an empty roster in front of a class, and a stale cache buster shows up
// as a teacher running last week's code with no indication anything is wrong.
//
// Run: npm test

import { readFileSync } from "node:fs";

const script = readFileSync(new URL("./script.js", import.meta.url), "utf8");
const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const auth = readFileSync(new URL("./wildcat-auth.js", import.meta.url), "utf8");


/**
 * The body of a top-level function, by brace matching.
 *
 * These guards used to slice a fixed number of characters after the function
 * name, which is fine until somebody adds twenty lines to the function and an
 * assertion fails for a reason that has nothing to do with what it tests. That
 * happened, and a guard that cries wolf gets deleted rather than fixed.
 */
function fnBody(source, name) {
  const start = source.indexOf(name);
  if (start === -1) return "";
  const open = source.indexOf("{", start);
  if (open === -1) return "";
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return source.slice(start);
}

let pass = 0;
let fail = 0;
function check(label, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail ? `  (${detail})` : ""}`);
  }
}

console.log("\nConvex cutover switches");
{
  const source = script.match(/const DATA_SOURCE = '(\w+)'/);
  const write = script.match(/const DATA_WRITE = '(\w+)'/);
  check("DATA_SOURCE is declared", Boolean(source), "the read switch is missing");
  check("DATA_WRITE is declared", Boolean(write), "the write switch is missing");
  check(
    "DATA_SOURCE is one of the two known values",
    ["convex", "firestore"].includes(source?.[1]),
    source?.[1],
  );
  check(
    "DATA_WRITE is one of the three known values",
    ["convex", "firestore", "both"].includes(write?.[1]),
    write?.[1],
  );
}

console.log("\nThe fallback is intact");
{
  // The Convex read must be inside a try with a catch that does NOT rethrow.
  // If it rethrows, or the catch is removed, a Convex outage stops being a
  // degraded roster and becomes a blank one.
  // Bounded by a STABLE ANCHOR rather than a character count. This slice was
  // `+ 900`, and adding two lines inside the branch pushed the console.error
  // past the window: the assertion failed while the code it describes was
  // correct, which is the worst way for a test to be wrong.
  const branchStart = script.indexOf("if (DATA_SOURCE === 'convex')");
  const branchEnd = script.indexOf("const secondaryData = secondarySnap.exists()", branchStart);
  const branch = script.slice(branchStart, branchEnd);
  check("the branch is bounded by its real end, not a guessed length",
    branchStart > 0 && branchEnd > branchStart);
  check("the Convex read is guarded by try", /try\s*\{/.test(branch));
  check("and has a catch", /catch\s*\(/.test(branch), branch.slice(0, 80));
  check(
    "the catch does not rethrow, so Firestore still answers",
    !/catch\s*\([^)]*\)\s*\{[^}]*\bthrow\b/.test(branch),
  );
  check(
    "the failure is reported rather than swallowed silently",
    /console\.(error|warn)/.test(branch),
  );
}

console.log("\nloadRosterFromConvex refuses to fake success");
{
  const fn = fnBody(script, "async function loadRosterFromConvex");
  check("it throws when not signed in", /throw new Error\('Not signed in/.test(fn));
  check(
    "it throws rather than returning an empty roster",
    /throw new Error\('appData:load returned no students/.test(fn),
    "an empty array and a failed request must not look the same",
  );
  check("it passes the id token", /session\.idToken/.test(fn));
}

console.log("\nThe shadow write cannot break a save that already worked");
{
  // Bounded by a STABLE ANCHOR rather than a character count. This was
  // `+ 2200`, and adding the Convex-only cash payload pushed the console.error
  // past the window: the assertion failed while the code it describes was
  // correct. The same brittleness already bit the roster branch above.
  const at = script.indexOf("DATA_WRITE === 'both'");
  const branchEnd = script.indexOf("TRANSACTION 2", at);
  const branch = script.slice(at, branchEnd > at ? branchEnd : at + 4000);
  check("the shadow-write branch is bounded by its real end",
    at > 0 && branchEnd > at);
  check("the Convex write is guarded by try", /try\s*\{/.test(branch));
  check(
    "and its catch does not rethrow",
    !/catch\s*\([^)]*\)\s*\{[^}]*\bthrow\b/.test(branch),
    "the Firestore transaction has already committed; a shadow failure must not surface as a failed save",
  );
  check("the failure is still logged", /console\.error/.test(branch));
  // Ordering matters: writing to Convex BEFORE the transaction commits would
  // record an award that Firestore then rejected.
  check(
    "it runs after the transaction, not before",
    script.indexOf("Main document saved (transaction)") < at,
  );
}

console.log("\nThe roster is re-read once a Convex session exists");
{
  check(
    "script.js listens for wildcat-auth-signin",
    /addEventListener\('wildcat-auth-signin'/.test(script),
    "wildcat-auth emits it; without a listener, signing in never re-reads the roster",
  );
  check("there is a refresh function", /async function refreshRosterFromConvex/.test(script));
  const fn = fnBody(script, "async function refreshRosterFromConvex");
  check(
    "it carries ticketHistory across, rather than blanking it",
    /ticketHistory/.test(fn),
    "the Convex roster has no ticket history; it lives in a separate Firestore doc",
  );
  check("it re-renders after replacing the roster", /switchTab\(/.test(fn));
  check(
    "the tab name is read from the onclick, since there is no data-tab attribute",
    /switchTab\\\('\(\[\^'\]\+\)/.test(fn) || /getAttribute\('onclick'\)/.test(fn),
  );
  check(
    "the resumed-session poll is bounded",
    /attempts >= \d+/.test(script),
    "an unbounded timer would re-fetch the roster all afternoon",
  );
}

console.log("\nPagination and the teacher modal");
{
  check("both tables share one paginator", /function paginate\(/.test(script));
  check(
    "the student renderer slices rather than drawing everything",
    /view\.slice\.map/.test(script),
    "646 rows were going into the DOM at once",
  );
  check("the teachers table paginates too", /paginate\('teachers'/.test(script));
  check(
    "a page beyond the end is clamped",
    /state\.page > pages/.test(script),
    "deleting the last row on the last page must not strand the view",
  );
  check(
    "the pager hides itself on a single page",
    /info\.pages <= 1/.test(script),
    "Page 1 of 1 is noise",
  );
  check("the add-teacher modal has an opener", /function openAddTeacherModal/.test(script));
  check("and a closer", /function closeAddTeacherModal/.test(script));
  check(
    "the backdrop click checks the target",
    /event\.target\.id === 'addTeacherModal'/.test(script),
    "without it, a drag from inside the form closes it and loses the input",
  );
  check("Escape closes it", /event\.key !== 'Escape'/.test(script));
  // Was: "it closes only after the teacher is saved", against the old
  // create-account form. That form is gone. The equivalent invariant for the
  // invite flow is that the modal closes only after the server confirms, which
  // is asserted in the invite section below.
  check(
    "the modal closes only after a successful invite",
    script.indexOf("closeAddTeacherModal();", script.indexOf("sendStaffInvite")) >
      script.indexOf("convexMutation('staffInvites:inviteStaff'"),
    "closing before the mutation returns would hide a refused invite",
  );
  check("the modal exists in the markup", /id="addTeacherModal"/.test(html));
  check("the teachers list survived the move", /Current Teachers/.test(html));
}

console.log("\nRemoved and collapsed sections");
{
  check(
    "the CSV student import UI is gone",
    !/onclick="uploadFile\(\)"/.test(html) && !/id="fileInput"/.test(html),
    "the SIS owns the roster; a CSV import could only fight it",
  );
  check("perfect attendance upload is behind a button", /openAttendanceUploadModal\(\)/.test(html));
  check("its modal exists", /id="perfectAttendanceUploadModal"/.test(html));
  check(
    "its form keeps the original ids",
    /id="perfectAttendanceFile"/.test(html) && /id="perfectAttendanceWeek"/.test(html),
  );
  check(
    "opening it refreshes the week list with the REAL function name",
    /initPerfectAttendanceUploadUI\(\)/.test(script) && !/populatePerfectAttendanceWeeks/.test(script),
    "currentWeek moves during a session, so a load-time fill goes stale",
  );
  check("the preview modal it feeds still exists", /id="perfectAttendanceModal"/.test(html));
  // Two different modals, two different close functions. The upload panel was
  // first given the preview modal's name, which is a duplicate declaration and
  // takes the entire file down at parse time.
  check(
    "the upload modal does not reuse the preview modal's close function",
    /function closeAttendanceUploadModal/.test(script) && /function closePerfectAttendanceModal/.test(script),
  );
  check(
    "and the preview modal keeps its own close wired up",
    (html.match(/closePerfectAttendanceModal\(\)/g) || []).length >= 2,
  );
}

console.log("\nStudents page shows the enrolled roster only");
{
  check("there is one helper, not a repeated filter", /function enrolledStudents\(\)/.test(script));
  check(
    "it hides only an EXPLICIT false",
    /s\.enrolled !== false/.test(script),
    "an unflagged student is an unknown, and hiding unknowns makes real children vanish",
  );
  const uses = (script.match(/enrolledStudents\(\)/g) || []).length;
  check("every students-page path uses it", uses >= 7, `${uses} uses`);
  check(
    "the table, search and sort all start from it",
    !/let filteredStudents = \[\.\.\.students\]/.test(script),
    "a raw [...students] here puts prior-year students back on the page",
  );
  check(
    "SAVING still carries every student",
    /studentsToSave = students\.concat\(nonEnrolledStudents\)/.test(script),
    "saving only the enrolled would drop the 88 prior-year records and their balances",
  );
}

console.log("\nEnrolled and former students are split at the source");
{
  check("former students are held separately", /let nonEnrolledStudents = \[\]/.test(script));
  check(
    "the Convex overlay splits them",
    /nonEnrolledStudents = fresh\.students\.filter/.test(script),
    "roughly thirty places read `students`; filtering at each is how one gets missed",
  );
  check(
    "SAVING stitches them back on",
    /students\.concat\(nonEnrolledStudents\)/.test(script),
    "the Firestore document is a wholesale replace, so omitting them DELETES them",
  );
  check(
    "and the post-save reassignment re-splits instead of restoring all of them",
    /students = savedAll\.filter/.test(script) && !/students = mainTransactionResult\.studentsToSave\.map/.test(script),
    "otherwise the roster is right on load and wrong again after the first award",
  );
  check(
    "the raffle draws from the enrolled roster",
    /const roster = enrolledStudents\(\)/.test(script) && /const pbisRoster = enrolledStudents\(\)/.test(script),
    "a transferred student could otherwise be drawn as a winner",
  );
}

console.log("\nThe session survives a reload");
{
  check(
    "there is a silent resume",
    /async function resumeSession/.test(auth),
    "without it the session existed for exactly ONE page load, the redirect return",
  );
  check("it uses the cached MSAL account", /acquireTokenSilent/.test(auth));

  // THIS CHECK USED TO ASSERT THE OPPOSITE, and it was wrong.
  //
  // It required `resumeSession().catch` to appear so that a resume ran on
  // every page load. That did fix the reload problem it was written for, and
  // it opened a worse one: these are shared Chromebooks, MSAL caches the
  // teacher's account, and a resume on load meant the next person to open the
  // app was silently signed in AS that teacher with no click anywhere. It also
  // pulled 270KB of Microsoft SDK into every student's browser, on a student
  // entrance the owner has said must never touch Microsoft.
  //
  // The session still survives a reload. It is now recovered by the staff
  // sign-in button, one click, instead of by the page load.
  check(
    "it does NOT run from onReady: a page load is not a person",
    !/resumeSession\(\)\.catch/.test(auth),
    "on a shared Chromebook that silently hands the next student the last teacher's session",
  );
  check(
    "silent resume is gated on an explicit staff gesture",
    /if \(!staffSignInRequested\)/.test(auth) && /staffSignInRequested = true;/.test(auth),
  );
  check(
    "and refuses while the student entrance is on screen",
    /function staffEntranceActive/.test(auth) && /if \(!staffEntranceActive\(\)\)/.test(auth),
  );
  check(
    "the staff button is what recovers the session",
    /const resumed = await resumeSession\(\);/.test(auth),
    "otherwise a returning teacher pays a full redirect on every reload",
  );
  check(
    "a student signing in wipes the cached Microsoft account",
    /function forgetCachedStaffAccount/.test(auth) &&
      /k\.startsWith\('msal\.'\)\) doomed\.push\(k\)/.test(auth),
    "and does it with storage keys, because loading MSAL to forget MSAL is the bug",
  );
  check(
    "a failed resume is NOT an error",
    /console\.debug\('\[wildcat-auth\] no session to resume/.test(auth),
    "nobody being signed in is the normal state of a login screen",
  );
  check("it is exported so the app can retry", /\n    resumeSession,/.test(auth));
  check(
    "MSAL still caches where a reload can find it",
    /cacheLocation: 'sessionStorage'/.test(auth),
    "localStorage or memory would change what resume can recover",
  );
}

console.log("\nStaff are invited from the directory, not created with a password");
{
  check(
    "the cleartext password field is GONE from the form",
    !/newTeacherPassword/.test(html),
    "that field is the reason the Convex migration exists",
  );
  check("so are the hand-typed name and username fields", !/newTeacherUsername/.test(html));
  check("addTeacher() is no longer reachable from the UI", !/onclick="addTeacher\(\)"/.test(html));
  check("the modal searches the directory", /id="staffSearchInput"/.test(html));
  check("and picks an access level at invite time", /id="staffInviteRole"/.test(html));
  check(
    "search is debounced",
    /setTimeout\(\(\) => runStaffSearch/.test(script),
    "it fires per keystroke and each one is a round trip",
  );
  check(
    "a person who already has access is shown, not hidden",
    /alreadyHasAccess/.test(script),
    "hiding them makes an admin search again for a colleague they can see in Outlook",
  );
  check(
    "the invite refreshes from the server rather than guessing the row",
    /refreshRosterFromConvex\('staff invite'\)/.test(script),
  );
}

console.log("\nStudents sign in with Google, and only with Google");
{
  check(
    "the name lookup input is gone from the form",
    !/id="studentLoginId"/.test(html),
    "it matched on LAST NAME alone: typing a common surname signed you in as that student",
  );
  check(
    "and the matching code is gone from script.js",
    !/lastName\.toLowerCase\(\) === input/.test(script),
    "removing the form is only removing the handle; every function here is global",
  );
  check(
    "studentLogin() still exists and refuses",
    /function studentLogin\(\)/.test(script) && /is retired/.test(script),
    "callable from the console, so it has to refuse rather than merely be unreachable",
  );
  check("the Google button is still the way in", /id="googleSignInButton"/.test(html));
  check(
    "and the page says which account to use",
    /westbrookacademy\.org/.test(html),
    "a student who cannot sign in needs to know what to ask the office for",
  );
}

console.log("\nNFC tags");
{
  check(
    "a tag URL is a QUERY STRING, not a path",
    /\[\?&\]tap=/.test(script) && /\?tap=/.test(html),
    "GitHub Pages cannot route /tap/<slug> to index.html without a 404 trick",
  );
  check(
    "the slug is removed from the URL after handling",
    /function clearTapFromUrl/.test(script) && /searchParams\.delete\('tap'\)/.test(script),
    "otherwise a reload re-taps and logs a tap the student never made",
  );
  check(
    "tapping is handled after sign-in too",
    /addEventListener\('wildcat-auth-signin', \(\) => \{ handleTapArrival/.test(script),
    "a tag opens the app before the student has a session; the slug must survive the redirect",
  );
  /**
   * Pull the argument object out of every call to the named mutations,
   * whatever the whitespace or line breaks look like.
   *
   * This used to be one regex matching the whole call on a single line, which
   * meant a reformat that wrapped the arguments turned the guard off silently
   * and the suite went red for a reason that had nothing to do with the
   * property. Brace matching instead of a line shape, so it survives the next
   * reformat and keeps checking the thing it is here for.
   *
   * Anything that is not a plain object literal is reported as such and FAILS,
   * because a variable or a spread could carry a student identifier in and
   * this file could not tell.
   */
  const mutationArgs = (source, names) => {
    const out = [];
    const re = new RegExp(
      "convexMutation\\(\\s*['\"](?:" + names.join("|") + ")['\"]\\s*,",
      "g",
    );
    let m;
    while ((m = re.exec(source)) !== null) {
      let i = re.lastIndex;
      while (i < source.length && /\s/.test(source[i])) i++;
      if (source[i] !== "{") { out.push("NOT_AN_OBJECT_LITERAL"); continue; }
      let depth = 0;
      const start = i;
      for (; i < source.length; i++) {
        if (source[i] === "{") depth++;
        else if (source[i] === "}") { depth--; if (depth === 0) { i++; break; } }
      }
      out.push(source.slice(start, i).replace(/\s+/g, " "));
    }
    return out;
  };

  const tapCalls = mutationArgs(script, ["hallPasses:tap", "hallPasses:beginTap"]);

  check(
    "the tap mutations are actually called",
    tapCalls.length >= 2,
    "the guard below proves nothing if it found nothing: " + JSON.stringify(tapCalls),
  );

  // A tap must never be attributable to a student the CALLER names. The only
  // student a tap can belong to is the one the verified token says it is.
  const namesAStudent = tapCalls.filter((args) =>
    args === "NOT_AN_OBJECT_LITERAL" ||
    /\bstudent\w*\s*:/i.test(args) ||
    /\bemail\s*:/i.test(args) ||
    /\bpersonId\s*:/i.test(args) ||
    /\bid\s*:/i.test(args) ||
    /\.\.\./.test(args),
  );

  check(
    "the tap mutations take NO student identifier",
    tapCalls.length >= 2 && namesAStudent.length === 0,
    "an id argument would let any session close any student's pass: " +
      JSON.stringify(namesAStudent),
  );

  check(
    "and the redeeming call carries an intent token",
    tapCalls.some((a) => /intentToken\s*:/.test(a)),
    "a bare slug is not proof of presence; a forged link supplies one just as easily",
  );

  /**
   * The gesture rule, which is the half that lives in this file.
   *
   * beginTap mints proof that a person pressed something. If the page mints it
   * on arrival, it proves only that the page loaded, which is precisely what a
   * link sent by somebody else causes. So the arrival handler must not call a
   * mutation at all.
   */
  const arrival = (() => {
    const at = script.indexOf("async function handleTapArrival()");
    if (at < 0) return null;
    let depth = 0;
    let i = script.indexOf("{", at);
    const start = i;
    for (; i < script.length; i++) {
      if (script[i] === "{") depth++;
      else if (script[i] === "}") { depth--; if (depth === 0) { i++; break; } }
    }
    return script.slice(start, i);
  })();

  check(
    "arriving with ?tap= writes NOTHING",
    arrival !== null && !/convexMutation/.test(arrival),
    "a tap performed by a page load is a tap performed by whoever sent the link",
  );
  check("staff tapping a tag registers it", /openTagRegistration/.test(script));
  check("there is a tag manager", /id="tagManagerBody"/.test(html) && /function renderTagManager/.test(script));
  check(
    "the encoding instructions say to lock the tag",
    /[Ll]ock the tag read-only/.test(html),
    "an unlocked tag can be rewritten by any phone that touches it",
  );
  check(
    "retiring is offered, deleting is not",
    /tapLocations:retire/.test(script) && !/tapLocations:delete/.test(script),
    "tapEvents refer to a slug; deleting a location orphans its history",
  );
}

console.log("\nCache busters");
{
  const tags = [...html.matchAll(/(script|wildcat-auth)\.js\?v=([\w-]+)/g)].map((m) => m[2]);
  check("both script tags carry a version", tags.length >= 2, JSON.stringify(tags));
  check(
    "and they match, so one cannot ship without the other",
    new Set(tags).size === 1,
    JSON.stringify(tags),
  );
}

console.log("\nThe app never reloads itself unprompted");
// This one cost a submitted referral. The old check compared the deployed
// file's Last-Modified against the moment the PAGE loaded, which are different
// kinds of thing, so every session past the first minute after a deploy
// reloaded itself every five minutes forever. A reload mid-save loses whatever
// saveInBackground was still writing.
check("no unconditional auto-reload survives in script.js",
  !/^\s*location\.reload\(true\)/m.test(script));
check("the update check compares a VERSION, not a timestamp",
  /script\\.js\\?v=\(\[\^"&\]\+\)/.test(script) || /script\.js\?v=/.test(script));
// Ignore comment lines: the replacement documents the old broken comparison
// on purpose, and a guard that forbids naming a bug stops it being explained.
check("SCRIPT_LOAD_TIME is gone from the CODE (the comment may still explain it)",
  !script.split("\n").some((l) => /SCRIPT_LOAD_TIME/.test(l) && !/^\s*(\/\/|\*)/.test(l)));
check("an available update surfaces as a dismissible bar",
  /wcUpdateBar/.test(script) && /wc-update-later/.test(script));
check("and the reload button flushes a save before reloading",
  /saveData\(\)[\s\S]{0,200}location\.reload\(\)/.test(script));

console.log("\nThe referral save merges, and its transaction is side-effect free");
// referral-save.test.mjs models this path. These assertions keep the model
// honest: if the real code stops matching it, the model proves nothing.
//
// Anchored on `mergedReferrals`, which appears only in the save path. The
// string 'raffle_data', 'referrals' also matches the LOAD path earlier in the
// file, and anchoring there silently measured the wrong code.
{
  const at = script.indexOf("mergedReferrals");
  check("the save path is findable at all", at !== -1);
  const near = script.slice(Math.max(0, at - 2500), at + 2500);

  check("referrals are written in a transaction, not a bare setDoc",
    /runTransaction/.test(near) && !/setDoc\(\s*doc\([^)]*'referrals'\)/.test(near));
  check("the stored list is read before writing", /transaction\.get\(/.test(near));
  check("and merged rather than replaced", /WildcatMerge\.mergeById/.test(near));
  // Firestore retries the callback. Assigning outer state inside it is safe
  // only by accident of idempotency, and lies about state if it then fails.
  check("the in-memory list is assigned AFTER the transaction, not inside it",
    /if \(mergedReferrals\) behaviorReferrals = mergedReferrals;/.test(near));
  check("nothing assigns behaviorReferrals inside the callback",
    !/transaction\.set\([\s\S]{0,400}behaviorReferrals =/.test(near));
  check("the counter cannot go backwards", /Math\.max\(/.test(near));
}

console.log("\nAnalytics tabs are not suppressed by the legacy-subtab rule");
// styles.css has:
//   #disciplineContent .subtab-button { display: none !important; }
// written when discipline navigation moved to the sidebar. The analytics tabs
// live inside #disciplineContent, so using that class made them invisible with
// no way to override it: present in the DOM, display:none, zero height.
{
  const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
  check("the suppression rule still exists (this guard is about it)",
    /#disciplineContent \.subtab-button\s*\{[^}]*display:\s*none/.test(css));
  check("no analytics tab uses the suppressed class",
    !/class="[^"]*\bsubtab-button\b[^"]*"[^>]*data-atab=/.test(html));
  check("analytics tabs use their own class", /class="analytics-tab/.test(html));
  check("and that class is actually styled", /\.analytics-tab\s*\{/.test(css));
  check("the trend grain buttons are not suppressed either",
    !/class="[^"]*\bsubtab-button\b[^"]*"[^>]*id="trendGrain/.test(html));
  check("the switcher targets the class the markup uses",
    script.includes(".analytics-tabs .analytics-tab"));
}

console.log("\nAnalytics panes live inside the analytics section");
// A pane inserted by string anchor landed 670 lines away, inside the cash
// activity table, and the tabs silently did nothing. Structure, not strings.
{
  const lines = html.split("\n");
  const start = lines.findIndex((l) => l.includes('id="behaviorAnalytics"'));
  let depth = 0, end = -1;
  for (let i = start; i < lines.length; i++) {
    depth += (lines[i].match(/<div\b/g) || []).length - (lines[i].match(/<\/div>/g) || []).length;
    if (depth === 0 && i > start) { end = i; break; }
  }
  check("the analytics section is balanced and findable", start !== -1 && end > start);

  const panes = ["all", "trends", "behaviors", "demographics", "closed"];
  for (const name of panes) {
    const at = lines.findIndex((l) => l.includes(`data-apane="${name}"`));
    check(`pane ${name} is inside the analytics section`, at > start && at < end);
  }
  for (const name of panes) {
    check(`tab ${name} has a button`, html.includes(`data-atab="${name}"`));
  }
}

console.log("\nTombstones and the watchdog are off Firestore");
// Both moved to Convex on 2026-08-31. Both fail SILENTLY if they regress: a
// tombstone that does not persist lets a deleted entry come back on the next
// load, and a watchdog that never fires lets a stale tab write last week's
// currentWeek over this week's. Neither throws, so only the call site can say.
{
  const persist = fnBody(script, "async function persistTombstone");
  check("persistTombstone calls Convex", /convexMutation\('tombstones:record'/.test(persist));
  check("and no longer touches Firestore", !/firebaseDb|arrayUnion|firebaseModules/.test(persist));
  check(
    "it still records locally before the write, so the filter applies either way",
    persist.indexOf("localTombstones.push") < persist.indexOf("convexMutation"),
  );
  check(
    "a failed write is reported rather than returning as success",
    /persisted: false/.test(persist),
  );

  const load = fnBody(script, "async function loadPersistentTombstones");
  check("loadPersistentTombstones reads Convex", /convexQuery\('tombstones:list'/.test(load));
  check("and no longer touches Firestore", !/firebaseDb|firebaseModules/.test(load));

  const dog = fnBody(script, "function startWeekStalenessWatchdog");
  check("the watchdog reads appData:freshness", /convexQuery\('appData:freshness'/.test(dog));
  check("and no longer reads raffle_data/main", !/firebaseDb|raffle_data/.test(dog));
  check(
    "it no longer refuses to start when Firebase is absent",
    !/firebaseInitialized/.test(dog),
    "that guard meant a tab which failed to reach Firebase silently had no watchdog at all",
  );
  check(
    "it still only acts when the server is AHEAD",
    /svCycleNum > localCycleNum/.test(dog) && /svWeek > currentWeek/.test(dog),
    "a null must never read as week zero and reload every tab in the school",
  );
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
