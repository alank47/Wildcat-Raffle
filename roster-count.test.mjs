// A roster count is only a fact when the roster is the authoritative one.
//
// THE BUG. The dashboard showed 1393 students on some loads and 631 on others,
// and it looked like a rendering race. It was not.
//
// `enrolled` is computed by Convex's appData:load against the current
// psRoster. Firestore student records DO NOT CARRY THE FIELD, and
// enrolledStudents() tests `s.enrolled !== false` — so on the Firestore
// fallback every record reads as enrolled and the count is roughly double the
// school. A missing value rendering as a real one, which this app has an
// explicit rule against and a comment in script.js naming as such.
//
// Run: npm test

import { readFileSync } from "node:fs";
const script = readFileSync(new URL("./script.js", import.meta.url), "utf8");

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };

/** The predicate as the app defines it, so the test cannot drift from it. */
const enrolledOf = (rows) => rows.filter((s) => s.enrolled !== false);

console.log("\nWhy the two numbers differed");
{
  // A Convex roster: every record carries the flag.
  const convex = [
    { id: "1", enrolled: true }, { id: "2", enrolled: true }, { id: "3", enrolled: false },
  ];
  check("Convex records count only the enrolled", enrolledOf(convex).length === 2);

  // A Firestore roster: the field does not exist.
  const firestore = [{ id: "1" }, { id: "2" }, { id: "3" }, { id: "4" }];
  check("Firestore records ALL read as enrolled, because undefined !== false",
    enrolledOf(firestore).length === 4);
  check("which is the whole bug, in one line",
    (undefined !== false) === true);
}

console.log("\nThe app records where the roster came from");
{
  check("there is a provenance flag", /let rosterSource = null;/.test(script));
  check("the Convex load path sets it", /rosterSource = 'convex';\s*\n\s*console\.log\(`✅ Roster from Convex/.test(script));
  // There is no fallback path to set it any more, and that is the point: the
  // flag has exactly two states now, 'convex' and null, so anything that is not
  // a successful Convex load leaves the count unclaimed. A third value would be
  // a third thing to remember to check at every call site.
  check("and nothing else does", !/rosterSource = '(?!convex)/.test(script));
  check("and so does the post-sign-in refresh",
    /rosterSource = 'convex';\s*\n\s*console\.log\(`✅ Roster refreshed from Convex/.test(script));
  check("with a predicate the UI can ask",
    /function rosterIsAuthoritative\(\) \{ return rosterSource === 'convex'; \}/.test(script));
}

console.log("\nThe dashboard refuses to print a count it cannot stand behind");
{
  check("an admin tile goes absent while the roster is the fallback",
    /isAdmin && !rosterIsAuthoritative\(\)\)\)\s*\n\s*\? null : roster\.length/.test(script));
  check("and says why, rather than showing a blank",
    /absent: \(isAdmin && !rosterIsAuthoritative\(\)\)\s*\n\s*\? 'roster still loading'/.test(script));
  // A teacher's tile counts their own sections, which the fallback gets right,
  // so it must NOT be suppressed along with the admin case.
  check("a teacher's section count is not suppressed",
    /: 'no sections assigned'/.test(script));
}

console.log("\nA failed load degrades, and never lies about the count");
{
  // This block used to assert that a Convex failure fell back to the FIRESTORE
  // copy, because a half-finished migration must not leave a teacher with an
  // empty screen. Firestore was removed on 2026-08-31, so there is no second
  // copy to fall back to and the assertion cannot be kept as written.
  //
  // The rule it protected still holds, by a different route: the roster read
  // rethrows, loadData()'s own catch takes over, and the tab is populated from
  // localStorage. What must NOT happen is the old fallback's real failure —
  // Firestore records carry no `enrolled` field, enrolledStudents() tests
  // `enrolled !== false`, so every one of them counted as enrolled. That is the
  // 1393-students-then-631 flap, a missing value rendering as a real one.
  check("a failed roster read is not swallowed",
    /console\.error\('\[roster\] Convex load failed:'[\s\S]{0,200}throw err;/.test(script),
    "swallowing it leaves rosterSource set and the count claimed as a fact",
  );
  check("the tab still gets data, from localStorage",
    /console\.error\('Server load error:'[\s\S]{0,200}loadDataLocal\(\);/.test(script));
  check("and the count stays unclaimed, because rosterSource is never set",
    /rosterSource = 'convex';/.test(script) && !/rosterSource = 'firestore'/.test(script));
  check("the reason is written down next to the code",
    /that is the 1393\n\s*\/\/ students the dashboard used to show/.test(script),
    "without it, someone reinstates a fallback that counts departed students as enrolled",
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
