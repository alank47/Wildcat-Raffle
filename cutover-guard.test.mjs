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
  const branch = script.slice(
    script.indexOf("if (DATA_SOURCE === 'convex')"),
    script.indexOf("if (DATA_SOURCE === 'convex')") + 900,
  );
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
  const fn = script.slice(
    script.indexOf("async function loadRosterFromConvex"),
    script.indexOf("async function loadRosterFromConvex") + 900,
  );
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
  const at = script.indexOf("DATA_WRITE === 'both'");
  const branch = script.slice(at, at + 2200);
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
  const fn = script.slice(
    script.indexOf("async function refreshRosterFromConvex"),
    script.indexOf("async function refreshRosterFromConvex") + 1800,
  );
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
  check(
    "it closes only after the teacher is saved",
    script.indexOf("closeAddTeacherModal();", script.indexOf("teachers.push(newTeacher)")) > 0,
    "closing on click would dismiss a validation failure too",
  );
  check("the form still has its original ids", /newTeacherName/.test(html) && /newTeacherPassword/.test(html));
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

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
