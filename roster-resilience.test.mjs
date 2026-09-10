// A teacher's roster must not vanish because of one bad student record.
//
// FOUND 2026-09-09 while checking why Yadira Funez could not see her rosters.
// Her data turned out to be perfect -- 8 sections, 126 rows, 77 enrolled
// students, all joining cleanly -- but the lookup that serves it was one
// duplicated student number away from failing completely:
//
//   .withIndex("by_studentNumber", q => q.eq("studentNumber", num)).unique()
//
// .unique() answers a data fault by throwing a plain Error, and Convex redacts
// a plain Error to "Server Error" in production. That error is not scoped to
// the one student: it takes down the WHOLE teacherRoster query, so the teacher
// sees no classes at all. From her chair that is indistinguishable from not
// being timetabled -- the exact symptom we spent the morning chasing.
//
// views_app.ts already made this call correctly for psAttendance, with the
// reasoning written out. These two sites had not caught up.
//
// Run: npm test

import { readFileSync } from "node:fs";

const views = readFileSync(new URL("./convex/views_app.ts", import.meta.url), "utf8");

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };

console.log("\n-- no student lookup throws on a duplicate --");
{
  // Every by_studentNumber lookup and the terminator that follows it.
  //
  // Scanned forward from each occurrence rather than matched in one regex: the
  // index argument is `(q) => q.eq("studentNumber", num))`, which contains
  // parentheses, so a `[^)]*` pattern stops inside it and matches nothing. The
  // first version of this assertion failed for that reason and not because the
  // code was wrong -- a test that cannot find what it is checking must say so,
  // which is why the count is asserted before the contents.
  const lookups = [];
  let at = views.indexOf('withIndex("by_studentNumber"');
  while (at !== -1) {
    const window = views.slice(at, at + 220);
    const m = window.match(/\.(unique|first|collect)\(\)/);
    if (m) lookups.push(m[1]);
    at = views.indexOf('withIndex("by_studentNumber"', at + 1);
  }

  check("the roster lookups were found", lookups.length >= 2);
  check(
    !lookups.includes("unique")
      ? "no by_studentNumber lookup uses .unique()"
      : `still using .unique() at ${lookups.filter((l) => l === "unique").length} site(s)`,
    !lookups.includes("unique")
  );
}

console.log("\n-- the reason is written down where the next person will look --");
{
  check("the comment explains the redaction to Server Error", /redacts to "Server\s*\n?\s*\/\/ Error"|redacted|redacts/.test(views));
  check("and that it kills the WHOLE roster, not one student", /WHOLE roster fetch/.test(views));
  check("and records that there were no duplicates when it was changed",
    /757 students, 757 distinct numbers/.test(views));
}

console.log("\n-- the roster query still works the way it must --");
{
  const fn = views.slice(views.indexOf("export const teacherRoster = query"),
                         views.indexOf("export const teacherRosterFor"));
  check("teacherRoster is still staff-gated", /await requireStaff\(ctx\)/.test(fn));
  check("it still looks rows up through the index, never a table scan",
    /withIndex\("by_teacherEmail"/.test(fn) && !/query\("psRoster"\)\.collect\(\)/.test(fn));
  check("it still resolves the address through rosterEmailFor",
    /rosterEmailFor\(ctx, teacher\)/.test(fn));
  check("it still de-duplicates students before looking them up",
    /new Set\(rows\.map\(\(r\) => r\.studentNumber\)\)/.test(fn));
  // A missing student record must skip that student, not abort the roster.
  check("a student with no app record is skipped, not fatal", /if \(s\) students\.set\(num, s\)/.test(fn));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
