// Projecting a grade, and refusing to.
//
// The owner's goal: a student seeing what handing work in would do. Kids read
// percentages, not points. The obstacle was category weights, which this
// PowerSchool instance exposes nowhere -- and a missing summative in a 70%
// category moves a grade far more than a missing homework in a 10% one.
//
// The way through is not to obtain the weights. It is to CHECK THE MODEL: the
// total-points percent is computed and compared against the percent PowerSchool
// already posts. Agreement means the section grades by total points and the
// arithmetic is exact. Disagreement means something else is happening, and the
// app says so instead of guessing.
//
// Being wrong about a child's grade is worse than saying nothing, so most of
// these assertions are about refusing.
//
// Run: npm test

import { projectGrade, TOLERANCE_PCT } from "./gradeProjection.ts";

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };

console.log("\nA total-points section projects exactly");
{
  // 80 of 100 earned, posted as 80%. One missing assignment worth 20.
  const r = projectGrade(80, 80, 100, 20);
  check("it projects", r.canProject === true);
  check("from the posted grade", r.currentPercent === 80);
  check("to the arithmetic answer", r.projectedPercent === 100);
  check("naming the gain", r.gainPercent === 20);
  check("and what it is worth", r.pointsAvailable === 20);
}

console.log("\nThe denominator does not grow, because the zero is already in it");
{
  // 45 of 100, one missing worth 10. The work is counted and scored zero, so
  // possible is already 100. Treating it as (45+10)/(100+10) would understate
  // the gain and quietly discourage the student.
  const r = projectGrade(45, 45, 100, 10);
  check("handing it in gives the full ten points", r.projectedPercent === 55);
  check("not the smaller number a growing denominator would give",
    r.projectedPercent !== 50);
}

console.log("\nA weighted section is refused, not guessed");
{
  // Computed 80%, posted 72%. The section is not total points.
  const r = projectGrade(72, 80, 100, 20);
  check("it refuses", r.canProject === false);
  check("saying the class weights categories", /weights categories/.test(r.reason));
  check("and still encourages handing the work in",
    /Handing the work in still helps/.test(r.reason));
  check("it reports what it computed, for diagnosis", r.computedPercent === 80);
}

console.log("\nThe tolerance is tight enough to catch weighting, loose enough for rounding");
{
  const justInside = projectGrade(80 - TOLERANCE_PCT + 0.01, 80, 100, 5);
  check("a rounding-sized difference still projects", justInside.canProject === true);
  const justOutside = projectGrade(80 - TOLERANCE_PCT - 0.01, 80, 100, 5);
  check("anything larger does not", justOutside.canProject === false);
}

console.log("\nEverything unknown is refused");
{
  check("no posted grade to check against",
    projectGrade(null, 80, 100, 10).canProject === false);
  check("and it says why, rather than showing a bare failure",
    /No posted grade to check against/.test(projectGrade(null, 80, 100, 10).reason));
  check("no totals yet", projectGrade(80, null, null, 10).canProject === false);
  check("a zero denominator is not a zero grade",
    projectGrade(0, 0, 0, 10).canProject === false);
  check("and that case says the class has no totals",
    /no graded work totals/.test(projectGrade(0, 0, 0, 10).reason));
  check("nothing outstanding is not a projection",
    projectGrade(80, 80, 100, 0).canProject === false);
}

console.log("\nIt never promises more than 100%");
{
  const r = projectGrade(95, 95, 100, 50);
  check("the ceiling is 100", r.projectedPercent === 100);
  check("and the gain is only what is really available", r.gainPercent === 5);
}

console.log("\nA real case, end to end");
{
  // Gizell's class: two assignments worth 100 each, both scored zero.
  // Suppose the section total is 600 possible, 400 earned -> 66.7%.
  const r = projectGrade(66.7, 400, 600, 200);
  check("it projects to the right number", r.projectedPercent === 100);
  check("from the posted grade", r.currentPercent === 66.7);
  check("a third of a grade, which is what a student wants to know",
    r.gainPercent === 33.3);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) process.exit(1);
