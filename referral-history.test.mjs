// Student History says Open / Closed / Loop closed, and prints what was
// stored as text. Run: npm test
//
// THE TILES. They were labelled Minor / Major / Severe Referrals, in severity
// colours, long after severity was retired; the numbers under them were open,
// closed and loop-closed counts. A child with three closed referrals read as
// having three MAJOR ones, the last tile in red. Now: Total, Open, Closed,
// Loop closed, with a note that Loop closed is counted inside Closed.
//
// THE TABLE wrote behaviorType, location, referredBy and consequence into
// innerHTML raw. Any staff save can write a referral's fields, so a stored
// "<img onerror=...>" would run for every admin who opened that child's
// history. A missing location printed "undefined", a closed "No Action
// Required" referral read "Pending", and new Date(dateTime) put a date-only
// Oct 5 incident on Oct 4.
//
// THE SHIPPED CODE RUNS: updateStudentReferralHistory is lifted out of
// script.js and run against a small fake DOM built from index.html's ids, with
// the real wildcat-discipline.js. Every "TEETH" check breaks the code on
// purpose and shows the assertion catches it.

process.env.TZ = "America/Los_Angeles";

import { readFileSync } from "node:fs";

const script = readFileSync(new URL("./script.js", import.meta.url), "utf8");
const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const discSrc = readFileSync(new URL("./wildcat-discipline.js", import.meta.url), "utf8");
const D = (() => { const sb = {}; new Function("globalThis", discSrc).call(sb, sb); return sb.WildcatDiscipline; })();

let pass = 0, fail = 0;
const check = (n, c, why) => {
  c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${why ? "  (" + why + ")" : ""}`));
};

function liftFn(src, name) {
  const m = new RegExp("\\n        (?:async )?function " + name + "\\(").exec(src);
  if (!m) throw new Error("missing function " + name);
  const start = m.index + 1;
  const end = src.indexOf("\n        }\n", start);
  if (end < 0) throw new Error("unterminated function " + name);
  return src.slice(start, end + 10);
}
function breakOnce(src, from, to, label) {
  const at = src.indexOf(from);
  if (at < 0 || src.indexOf(from, at + 1) >= 0) throw new Error(`teeth "${label}": anchor not found exactly once`);
  return src.slice(0, at) + to + src.slice(at + from.length);
}

function makeEl(id) {
  const cls = new Set();
  return {
    id, innerHTML: "", textContent: "", value: "",
    classList: {
      add: (...c) => c.forEach((x) => cls.add(x)),
      remove: (...c) => c.forEach((x) => cls.delete(x)),
      contains: (c) => cls.has(c),
    },
  };
}
/** Only the ids index.html really has; anything else is null, as in a browser. */
function makeDom(page) {
  const els = {};
  return {
    els,
    getElementById: (id) => (new RegExp(`\\bid="${id}"`).test(page) ? (els[id] || (els[id] = makeEl(id))) : null),
  };
}

/** Draw one student's history. Returns the fake DOM. */
function draw(src, referrals, page = html) {
  const document = makeDom(page);
  document.getElementById("historyStudentSelect").value = "S1";
  const body = `
    ${liftFn(src, "escapeHtml")}
    ${liftFn(src, "updateStudentReferralHistory")}
    updateStudentReferralHistory();
  `;
  new Function("document", "window", "students", "behaviorReferrals", body)(
    document, { WildcatDiscipline: D }, [{ id: "S1", firstName: "A", lastName: "Student" }], referrals);
  return document;
}

const ref = (over) => Object.assign({
  id: "R", studentId: "S1", date: "2026-10-01", time: "09:00", dateTime: "2026-10-01T09:00",
  behaviorType: "Defiance", behavior: "Defiance", location: "Hallway", referredBy: "Teacher T",
  status: "open", resolutionType: "", consequence: "", loopClosed: false,
  submittedAt: "2026-10-01T17:00:00.000Z",
}, over);

const XSS = '<img src=x onerror="alert(1)">';
const ROWS = [
  ref({ id: "OPEN1" }),
  // Open with a stray loopClosed flag: not closed, so not "loop closed" either.
  ref({ id: "OPEN2", loopClosed: true, date: "2026-10-02", dateTime: "2026-10-02T09:00" }),
  ref({ id: "SHUT1", status: "closed", resolutionType: "action_taken", consequence: "Notified parents/guardians promptly",
        date: "2026-09-29", dateTime: "2026-09-29T09:00" }),
  ref({ id: "LOOP1", status: "closed", resolutionType: "action_taken", consequence: "Restorative circle", loopClosed: true,
        date: "2026-09-30", dateTime: "2026-09-30T09:00" }),
  ref({ id: "NOACT", status: "closed", resolutionType: "no_action", consequence: "",
        date: "2026-09-28", dateTime: "2026-09-28T09:00" }),
];

console.log("\n-- the tiles --");
{
  const dom = draw(script, ROWS);
  const t = (id) => String(dom.els[id] && dom.els[id].textContent);
  check("Open counts what is not closed", t("summaryMinor") === "2", t("summaryMinor"));
  check("Closed counts what is closed", t("summaryMajor") === "3", t("summaryMajor"));
  check("Loop closed counts closed referrals whose loop is closed, inside Closed", t("summarySevere") === "1", t("summarySevere"));
  check("Total is every referral, and Open + Closed = Total",
    t("summaryTotal") === "5" && Number(t("summaryMinor")) + Number(t("summaryMajor")) === 5);
}

/** The summary block of index.html, and the label printed beside each id. */
const summaryHtml = (page) => page.slice(page.indexOf('id="studentReferralSummary"'), page.indexOf("<!-- History Table -->"));
const labelFor = (page, id) => {
  const m = new RegExp(`<div class="stat-label">([^<]*)</div>\\s*<div class="stat-num" id="${id}">`).exec(summaryHtml(page));
  return m ? m[1] : null;
};

console.log("\n-- the labels --");
{
  const block = summaryHtml(html);
  check("no tile says Minor, Major or Severe Referrals",
    !/Minor Referrals|Major Referrals|Severe Referrals/.test(block));
  check("and none wears a severity colour", !/wc-stat-(minor|major|severe)/.test(block));
  check("Total, Open, Closed and Loop closed sit on the right numbers",
    labelFor(html, "summaryTotal") === "Total" && labelFor(html, "summaryMinor") === "Open" &&
    labelFor(html, "summaryMajor") === "Closed" && labelFor(html, "summarySevere") === "Loop closed",
    [labelFor(html, "summaryTotal"), labelFor(html, "summaryMinor"), labelFor(html, "summaryMajor"), labelFor(html, "summarySevere")].join("/"));
  check("in that order", block.indexOf('id="summaryTotal"') < block.indexOf('id="summaryMinor"') &&
    block.indexOf('id="summaryMinor"') < block.indexOf('id="summaryMajor"') &&
    block.indexOf('id="summaryMajor"') < block.indexOf('id="summarySevere"'));
  check("the page says Loop closed is counted inside Closed", /Loop closed is counted inside Closed/.test(block));
  const table = html.slice(html.indexOf('id="studentReferralHistoryContainer"'), html.indexOf('id="studentReferralHistoryBody"'));
  check("the table's column is Status, not Severity", />Status</.test(table) && !/Severity/.test(table));
}

console.log("\n-- the table prints stored fields as text --");
{
  const dom = draw(script, [ref({
    id: "BAD", behaviorType: XSS, behavior: XSS, location: XSS, referredBy: XSS,
    status: "closed", resolutionType: "action_taken", consequence: XSS,
  })]);
  const out = dom.els.studentReferralHistoryBody.innerHTML;
  check("no stored tag reaches the page", !/<img/i.test(out));
  check("it is shown escaped, all four times", (out.match(/&lt;img/g) || []).length === 4, String((out.match(/&lt;img/g) || []).length));

  const gaps = draw(script, [ref({ id: "GAP", location: undefined, referredBy: "" })]).els.studentReferralHistoryBody.innerHTML;
  check("a missing location is a dash, not 'undefined'", !/undefined/.test(gaps) && /—/.test(gaps));
}

console.log("\n-- what the consequence column says --");
{
  const out = draw(script, ROWS).els.studentReferralHistoryBody.innerHTML;
  const rowOf = (id) => out.slice(out.lastIndexOf("<tr", out.indexOf(`'${id}'`)), out.indexOf("</tr>", out.indexOf(`'${id}'`)));
  check("closed with No Action Required says so, not 'Pending'",
    /No action required/.test(rowOf("NOACT")) && !/Pending/.test(rowOf("NOACT")));
  check("an open referral is still Pending", /Pending/.test(rowOf("OPEN1")));
  check("a closed referral shows its consequence", /Notified parents\/guardians promptly/.test(rowOf("SHUT1")));
}

console.log("\n-- the date is the incident's calendar day --");
{
  const out = draw(script, [ref({ id: "D1", date: "2026-10-05", time: "", dateTime: "2026-10-05" })])
    .els.studentReferralHistoryBody.innerHTML;
  check("a date-only Oct 5 incident shows Oct 5", /Oct 5, 2026/.test(out));
  check("not the 4th", !/Oct 4|10\/4\/2026/.test(out));

  const order = draw(script, ROWS).els.studentReferralHistoryBody.innerHTML;
  const at = (id) => order.indexOf(`'${id}'`);
  check("newest incident first",
    at("OPEN2") < at("OPEN1") && at("OPEN1") < at("LOOP1") && at("LOOP1") < at("SHUT1") && at("SHUT1") < at("NOACT"));
}

console.log("\n-- TEETH --");
{
  const raw = breakOnce(script, "<td style=\"padding: 14px;\">${orDash(ref.behavior || ref.behaviorType)}</td>",
    "<td style=\"padding: 14px;\">${ref.behaviorType}</td>", "escape behaviour");
  check("TEETH: writing behaviorType raw lets the tag through",
    /<img/i.test(draw(raw, [ref({ behaviorType: XSS, behavior: XSS })]).els.studentReferralHistoryBody.innerHTML));

  const oldDate = breakOnce(script, "${escapeHtml(D.dayLabel(D.incidentDay(ref))) || muted('—')}",
    "${new Date(ref.dateTime).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}", "date");
  check("TEETH: parsing dateTime puts the Oct 5 incident on Oct 4",
    !/Oct 5, 2026/.test(draw(oldDate, [ref({ date: "2026-10-05", time: "", dateTime: "2026-10-05" })]).els.studentReferralHistoryBody.innerHTML));

  const pending = breakOnce(script, "else if (ref.resolutionType === 'no_action') consequence = D.resolutionLabel('no_action');",
    "", "no action");
  check("TEETH: without the no_action branch a finished referral reads Pending",
    !/No action required/.test(draw(pending, ROWS).els.studentReferralHistoryBody.innerHTML));

  const oldHtml = html.replace('<div class="stat-label">Open</div>', '<div class="stat-label">Minor Referrals</div>');
  check("TEETH: the old Minor label is caught", labelFor(oldHtml, "summaryMinor") !== "Open");

  const anyLoop = breakOnce(script, "studentReferrals.filter(r => r.status === 'closed' && r.loopClosed).length",
    "studentReferrals.filter(r => r.loopClosed).length", "loop inside closed");
  check("TEETH: counting a stray loopClosed on an open referral breaks 'inside Closed'",
    String(draw(anyLoop, ROWS).els.summarySevere.textContent) !== "1");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
