// Searching the Award Cash roster.
//
// With All Students selected the table is 600-odd rows across 13 pages, and
// finding one child meant paging to them. This adds a search box.
//
// THE ONE THING THAT MUST NOT BREAK. Award Cash is scoped: a classroom teacher
// may award only the students psRoster says are theirs, and a teacher with no
// SIS roster sees NOBODY -- absent data must not read as unrestricted. A
// search box is the obvious way to undo that by accident, so the assertion
// that matters here is about ORDER: the search filters what scoping already
// allowed, never the roster.
//
// Run: npm test

import { readFileSync } from "node:fs";

const script = readFileSync(new URL("./script.js", import.meta.url), "utf8");
const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };

// The whole function, bounded by the NEXT function declaration at the same
// indentation. An earlier version of this line chained three indexOf calls and
// one of them returned -1, which silently produced a slice of negative length
// and two assertions that failed for no reason anyone could see. A boundary
// that can be wrong without saying so is worse than no boundary.
const start = script.indexOf("function updateCashTable(keepPage)");
if (start === -1) { console.log("  FAIL  updateCashTable not found"); process.exit(1); }
const end = script.indexOf("\n        function ", start + 10);
if (end === -1) { console.log("  FAIL  could not find the end of updateCashTable"); process.exit(1); }
const fn = script.slice(start, end);

console.log("\n-- the slice this test reasons about --");
{
  check("updateCashTable was located and bounded", fn.length > 2000 && fn.length < 20000);
  check("it is the whole function, ending after the table is built", fn.includes("view.slice.forEach"));
}

console.log("\n-- the box exists and is reachable --");
{
  check("the input is in the Award Cash tab", html.includes('id="cashStudentSearch"'));
  const tab = html.slice(html.indexOf('id="awardCashTab"'), html.indexOf('id="cashActivityTab"'));
  check("and it is inside that tab, not another one", tab.includes('id="cashStudentSearch"'));
  check("it redraws the table as you type", /id="cashStudentSearch"[\s\S]{0,220}oninput="updateCashTable\(\)"/.test(html));
  check("it has a label for screen readers", /for="cashStudentSearch"/.test(html));
  check("autocomplete is off, so the browser does not offer other children's names",
    /id="cashStudentSearch"[\s\S]{0,220}autocomplete="off"/.test(html));
}

console.log("\n-- ORDER: search narrows, it can never widen --");
{
  const scopeAt = fn.indexOf("WildcatRoster.scopeStudents");
  const searchAt = fn.indexOf("if (search) {");
  check("scopeStudents is still called", scopeAt !== -1);
  check("the search runs AFTER scoping, not before", scopeAt !== -1 && searchAt > scopeAt);
  // The filter must read from the scoped array, so there is nothing in it to
  // find that the teacher could not already award.
  const searchBlock = fn.slice(searchAt, fn.indexOf("}", fn.indexOf("funnel.afterSearch")));
  check("it filters filteredStudents, not the raw roster",
    /filteredStudents = filteredStudents\.filter/.test(searchBlock));
  check("it never reaches for students or enrolledStudents again",
    !/enrolledStudents\(\)/.test(searchBlock) && !/\bstudents\.filter/.test(searchBlock));
  check("the scoping call is not made conditional on the search",
    !/if \(search\)[\s\S]{0,200}scopeStudents/.test(fn));
}

console.log("\n-- what it matches --");
{
  const searchAt = fn.indexOf("if (search) {");
  const block = fn.slice(searchAt, searchAt + 1400);
  check("first name", /firstName/.test(block));
  check("last name", /lastName/.test(block));
  // The table sorts "Last, First" but people type "First Last". Matching only
  // one of them makes half of all searches silently fail.
  check("matches 'first last' as typed", /first \+ ' ' \+ last/.test(block));
  check("matches 'last, first' as displayed", /last \+ ', ' \+ first/.test(block));
  check("student number", /studentNumber/.test(block));
  check("the app's own id too", /st\.id/.test(block));
  check("case-insensitive", /toLowerCase\(\)/.test(fn.slice(fn.indexOf("const search ="), fn.indexOf("const search =") + 200)));
  check("whitespace is trimmed, so a stray space is not a failed search",
    /\.trim\(\)\.toLowerCase\(\)/.test(fn));
}

console.log("\n-- the predicate, EXECUTED --");
{
  // Everything above reads the source. This runs it. The filter is lifted out
  // of the shipped function and applied to a real array, so a regex that
  // matches while the logic is wrong cannot pass this section.
  const blockStart = fn.indexOf("filteredStudents = filteredStudents.filter(st => {");
  const blockEnd = fn.indexOf("});", blockStart) + 3;
  const src = fn.slice(blockStart, blockEnd);
  check("the filter block was located", blockStart !== -1 && blockEnd > blockStart);

  const roster = [
    { id: "1", studentNumber: "10021", firstName: "Milachi", lastName: "Rogers" },
    { id: "2", studentNumber: "10345", firstName: "Nadia",   lastName: "Vega" },
    { id: "3", studentNumber: "10999", firstName: "Leo",     lastName: "Contreras" },
    { id: "4", studentNumber: "11200", firstName: "Ava",     lastName: "Rogers" },
    { id: "5", studentNumber: "11201", firstName: "ROSA",    lastName: "de la Cruz" },
    { id: "6", studentNumber: "",      firstName: "",        lastName: "" },
  ];
  const run = (term) => {
    const f = new Function("filteredStudents", "search", src + "\nreturn filteredStudents;");
    return f(roster.slice(), term.trim().toLowerCase()).map((x) => x.id);
  };
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  check('"rogers" finds both Rogers', eq(run("rogers"), ["1", "4"]));
  check('"milachi rogers" -- first then last, as people type', eq(run("milachi rogers"), ["1"]));
  check('"rogers, ava" -- last then first, as the table shows it', eq(run("rogers, ava"), ["4"]));
  check('"ROGERS" in capitals still matches', eq(run("ROGERS"), ["1", "4"]));
  check('"  nadia  " with stray spaces still matches', eq(run("  nadia  "), ["2"]));
  check('"10999" finds by student number', eq(run("10999"), ["3"]));
  check('"rosa" matches a name stored in capitals', eq(run("rosa"), ["5"]));
  check('"zzz" finds nobody rather than everybody', eq(run("zzz"), []));
  // A blank-name record must not match every search through its empty strings.
  check("an empty student record is not a wildcard", !run("rogers").includes("6"));
}

console.log("\n-- an empty result explains itself --");
{
  check("a search that matches nobody is its own funnel stage", /funnel\.stage = 'search'/.test(fn));
  check("and says so, rather than blaming the roster", /No student you can award matches/.test(fn));
  check("it tells you how to get back", /Clear the search box/.test(fn));
  // The pre-existing messages must survive: "no roster loaded" and "your
  // class rosters matched nobody" send the reader somewhere different.
  check("the no-roster message still exists", /No roster is loaded yet/.test(fn));
  check("the scope reason still wins where it applies", /funnel\.scopeReason/.test(fn));
}

console.log("\n-- the header cannot claim to show more than it does --");
{
  check("the title says a search is active", /matching/.test(fn));
  check("the count becomes a match count", /match` \+/.test(fn) || /matches/.test(fn));
  check("period and grade stay visible alongside it", /titleText \+=/.test(fn));
}

console.log("\n-- selection cannot outlive the row --");
{
  // Awarding reads checked boxes out of the DOM, and the table is rebuilt on
  // every search. A student filtered out therefore has no checkbox at all, so
  // there is no way to award someone you cannot see.
  check("award reads checkboxes from the table body, not a saved list",
    /#cashStudentTableBody input\[type="checkbox"\]:checked/.test(script));
  check("the table body is emptied on every redraw", /tbody\.innerHTML = '';/.test(fn));
  // The header box is the one thing that does survive a redraw, and left
  // ticked it claims every row is selected while every row is drawn unticked.
  check("select-all is unticked whenever the table is redrawn",
    /getElementById\('cashSelectAll'\)/.test(fn) && /selectAllBox\.checked = false/.test(fn));
}

console.log("\n-- paging --");
{
  // updateCashTable() with no argument resets to page 1. Searching from page 7
  // must not leave the reader on a page the result set no longer has.
  check("search calls updateCashTable with no keepPage argument",
    /oninput="updateCashTable\(\)"/.test(html));
  check("paginate resets to page 1 when keepPage is falsy",
    /if \(!keepPage\) state\.page = 1;/.test(script));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
