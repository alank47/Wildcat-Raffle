// Ticket history is filed by grade. Nothing may be dropped on the way.
//
// THE BUG.
//
// `ticketHistoriesToSave` was built at the top of saveData from `students`.
// The main transaction then REASSIGNED `students`, splitting former students
// into nonEnrolledStudents, and the Convex roster refresh could replace the
// array outright mid-save. `studentGradeById` was built after all that, from
// the shrunken array — so every student who had left was absent from the
// index, their grade read as `undefined` rather than NaN, and the `else`
// branch threw their ticket history away.
//
// That mattered because the load path RECOMPUTES pbisTickets /
// attendanceTickets / academicTickets from ticket history. No saved history
// meant the counters reset to zero, so tickets a teacher had already awarded
// disappeared on the next reload. Roughly a hundred students per save.
//
// Run: npm test

import { readFileSync } from "node:fs";
const script = readFileSync(new URL("./script.js", import.meta.url), "utf8");

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };

/** The partition rule, mirrored from saveData. */
function partition(histories, gradeById) {
  const ms = {}, hs910 = {}, hs1112 = {}, unknown = {};
  Object.keys(histories).forEach((sid) => {
    const g = gradeById[sid];
    if (g >= 6 && g <= 8) ms[sid] = histories[sid];
    else if (g >= 9 && g <= 10) hs910[sid] = histories[sid];
    else if (g >= 11 && g <= 12) hs1112[sid] = histories[sid];
    else unknown[sid] = histories[sid];
  });
  return { ms, hs910, hs1112, unknown };
}

console.log("\nEvery student's history lands somewhere");
{
  const histories = { a: [1], b: [1], c: [1], d: [1], e: [1] };
  const grades = { a: 7, b: 9, c: 11, d: NaN, e: undefined };
  const out = partition(histories, grades);
  const filed = Object.keys(out.ms).length + Object.keys(out.hs910).length +
                Object.keys(out.hs1112).length + Object.keys(out.unknown).length;
  check("nothing is dropped, whatever the grade", filed === Object.keys(histories).length);
  check("grade 7 files under MS", out.ms.a !== undefined);
  check("grade 9 files under HS 9-10", out.hs910.b !== undefined);
  check("grade 11 files under HS 11-12", out.hs1112.c !== undefined);
  check("an unparseable grade files under unknown", out.unknown.d !== undefined);
  check("a missing grade files under unknown, not nowhere", out.unknown.e !== undefined);
  // The boundaries, because an off-by-one here silently moves a whole cohort.
  check("grade 6 is MS, not unknown", partition({ x: [1] }, { x: 6 }).ms.x !== undefined);
  check("grade 8 is MS", partition({ x: [1] }, { x: 8 }).ms.x !== undefined);
  check("grade 12 is HS 11-12", partition({ x: [1] }, { x: 12 }).hs1112.x !== undefined);
  check("grade 13 is unknown rather than silently HS",
    partition({ x: [1] }, { x: 13 }).unknown.x !== undefined);
}

console.log("\nThe reported scenario: a student who left");
{
  // Histories collected while the roster still had them; the index built
  // afterwards, from a list they had been filtered out of.
  const histories = { enrolled1: [1], departed1: [1], departed2: [1] };
  const indexAfterReassignment = { enrolled1: 7 };

  const out = partition(histories, indexAfterReassignment);
  check("a departed student's history is STILL saved",
    out.unknown.departed1 !== undefined && out.unknown.departed2 !== undefined);
  check("and the enrolled student is unaffected", out.ms.enrolled1 !== undefined);
  check("nothing is lost even under the old ordering",
    Object.keys(out.ms).length + Object.keys(out.unknown).length === 3);
}

console.log("\nBut the ordering is fixed too, so the index is not wrong to begin with");
{
  const save = script.slice(script.indexOf("const ticketHistoriesToSave = {};"));
  const oneLoop = save.slice(0, save.indexOf("const sectionsToSave"));
  check("the grade index is built in the same pass as the histories",
    /const studentGradeById = \{\};[\s\S]*?students\.forEach\(s => \{[\s\S]*?studentGradeById\[s\.id\] = parseInt\(s\.grade\);[\s\S]*?ticketHistoriesToSave\[s\.id\] = s\.ticketHistory;/.test(oneLoop));
  check("and NOT rebuilt later from a reassigned array",
    script.split("students.forEach(s => { studentGradeById[s.id] = parseInt(s.grade); });").length === 1);
  check("the reason is written down next to it",
    /`students` is reassigned partway through this save/.test(script));
}

console.log("\nThe unknown document is a real document, not a black hole");
{
  check("it is written", /\['ticket_history_unknown',\s+unknownHistoriesToSave/.test(script));
  check("it is fetched on load",
    /ticketHistoryUnknownSnap = snapOf\('ticket_history_unknown'\)/.test(script));
  // The check that used to sit here asserted this document was destructured at
  // the right INDEX of a twenty-two element Promise.all, because the reads were
  // positional and a document inserted in the middle silently shifted every
  // snapshot after it onto the wrong variable. The reads moved to Convex on
  // 2026-08-31 and are now bound by name through snapOf(), so that entire class
  // of bug cannot occur: there is no ordering to get wrong. Asserting the name
  // binding above is what replaces it. Do not reinstate a positional check.
  check("nothing reads these documents by position any more",
    !/_allSnaps\.slice\(/.test(script),
    "a positional slice is what made inserting a document a silent corruption",
  );
  check("its entries are merged back into each student's history",
    /collect\(unknownHistories\[sid\]\);/.test(script));
  check("and its student ids are in the set that drives that merge",
    /\.\.\.Object\.keys\(unknownHistories\),/.test(script));
  check("it feeds the combined result downstream code reads",
    /\.\.\.unknownResult\.mergedHistories/.test(script));
  check("a non-empty bucket is reported rather than left silent",
    /have ticket history but no readable grade/.test(script));
  // The whole point: the else branch must never discard again.
  check("the else branch no longer drops history",
    !/history not saved\./.test(script));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
