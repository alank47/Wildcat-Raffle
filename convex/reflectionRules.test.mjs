// The Reflection Room list's rules: who is on it, when, and when not. Run: npm test
//
// EVERY RULE IN reflectionRules.ts IS RUN HERE FOR REAL. The file is loaded
// together with scheduleRules.ts (its one import: the LA wall clock), so the
// daylight-saving cases go through the same clock the hall passes use.
//
// Each example in the build spec's section 3 is a case below, and so are the
// owner's answers of 2026-10-08, which override the spec where they differ:
// RSP, Designated ELD and 7002A students are pulled like everyone else (with
// their real class and teacher flagged), several violations on one list are
// one detention, and a student at school who does not come carries like an
// absent one.
//
// TEETH. scripts/reflection-teeth.mjs copies this file and the rules into a
// scratch folder, breaks one guard at a time, and requires the check named
// for that guard to FAIL. A check that still passes with its guard broken
// proves nothing, so the names below are load-bearing: rename one and the
// teeth script says so.
import { readFileSync } from "node:fs";
import ts from "typescript";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const strip = (s) => s.replace(/^import\b[\s\S]*?from\s*"[^"]*";[ \t]*\n/gm, "");
const js = ts.transpileModule(read("./scheduleRules.ts") + "\n" + strip(read("./reflectionRules.ts")), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const R = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));

let pass = 0, fail = 0;
const check = (n, c, why) => {
  c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${why ? "  (" + why + ")" : ""}`));
};
const J = (x) => JSON.stringify(x);

const TZ = "America/Los_Angeles";
const ON = R.reflectionSettingsOrDefault({
  modeByDivision: { ms: "shadow", hs: "shadow" },
  countFromDateByDivision: { ms: "2026-09-01", hs: "2026-09-01" },
});
const at = (date, hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return R.laWallToUtc(date, h * 60 + m, TZ);
};
const plus = (iso, ms) => new Date(Date.parse(iso) + ms).toISOString();

// ------------------------------------------------------------------ fixtures
const CODES = R.buildCodeBook([
  { id: 1, att_code: "A", description: "Absent", presence_status_cd: "Absent" },
  { id: 2, att_code: "T", description: "Tardy", presence_status_cd: "Present" },
  { id: 3, att_code: "D", description: "Excused Tardy", presence_status_cd: "Present" },
  { id: 4, att_code: "K", description: "Ditching", presence_status_cd: "Present" },
  { id: 5, att_code: "", description: "Present", presence_status_cd: "Present" },
  { id: 6, att_code: "S", description: "Suspended", presence_status_cd: "Absent" },
  { id: 7, att_code: "X", description: "Excused Absence", presence_status_cd: "Absent" },
]);
const CODE_ID = { A: "1", T: "2", D: "3", K: "4", P: "5", S: "6", X: "7" };

const S = "10001";             // the student every case is about: grade 7 (MS), Power-Up in slot 9
const SECTIONS = { 1: "PT-A", 2: "P1-A", 3: "P2-A", 4: "P3-A", 5: "P4-A", 6: "P5-A", 7: "P6-A", 9: "PU-7", 10: "PM-A" };
const TEACHERS = { 2: "Lee", 3: "Ng", 4: "Ortiz", 5: "Park", 6: "Diaz", 7: "Kim", 9: "Ruiz" };
function snap(sn, grade, sections, extra = {}) {
  const enrolled = Object.keys(sections).map(Number).sort((a, b) => a - b);
  const pu = enrolled.find((s) => s === 8 || s === 9) ?? null;
  return {
    studentNumber: sn, grade: String(grade), division: R.divisionOfGrade(grade),
    puSlot: pu, puSectionId: pu ? sections[pu] : null, puTeacherName: pu ? "Ruiz" : null, puTeacherEmail: null,
    puCourse: pu ? "Power Up 7A" : null, puFlag: null, puCheck: false,
    enrolledSlots: enrolled,
    sectionBySlot: Object.fromEntries(Object.entries(sections).map(([k, v]) => [String(k), v])),
    teacherBySlot: Object.fromEntries(Object.entries(TEACHERS).filter(([k]) => k in sections)),
    ...extra,
  };
}
const MON = "2026-10-12", TUE = "2026-10-13", WED = "2026-10-14";
const MON_SLOTS = [1, 2, 4, 6, 8, 9, 10];
const ALL_SLOTS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const slotOfSection = (sec, roster) => {
  const own = Object.entries(roster[S]?.sectionBySlot ?? {}).find(([, v]) => v === sec) ?? Object.entries(SECTIONS).find(([, v]) => v === sec);
  return Number(own[0]);
};

/**
 * One school day. `meet`: slots given 10 filler rows so they meet school-wide.
 * `marked`: S's own sections that have attendance marks (a classmate's row).
 * `marks`: [studentNumber, slot, code] for the student(s) under test.
 */
function day({ date = MON, meet = MON_SLOTS, marked = ["PT-A", "P1-A", "P3-A", "PU-7", "P5-A"], marks = [], roster: extra = {}, rows: more = [] } = {}) {
  const roster = { [S]: snap(S, 7, SECTIONS), ...extra };
  const rows = [];
  let id = 1;
  const row = (sn, slot, code) => rows.push({ id: String(id++), studentNumber: sn, attDate: date, periodId: 850 + slot, codeId: CODE_ID[code] });
  for (const slot of meet) {
    for (let i = 0; i < 10; i++) {
      const sn = `F${slot}-${i}`;
      roster[sn] = snap(sn, 7, { [slot]: `FILL-${slot}` });
      row(sn, slot, "A");
    }
  }
  for (const sec of marked) {
    const slot = slotOfSection(sec, roster);
    const sn = `C-${sec}`;
    roster[sn] = snap(sn, 7, { [slot]: sec });
    row(sn, slot, "A");
  }
  for (const [sn, slot, code] of marks) row(sn, slot, code);
  rows.push(...more);
  return { summary: R.summarizeDay(date, rows, CODES, roster), roster, rows };
}
const cands = (d, settings = ON, opts) => R.tardyCandidates(d.summary, d.roster, settings, opts).filter((c) => c.studentNumber === S);
const verdictAt = (d, slot, opts) => cands(d, ON, opts).find((c) => c.slot === slot)?.verdict ?? "none";

// ===========================================================================
console.log("\n3.1 WHAT COUNTS: SLOTS, CODES, LABELS\n");
{
  check("period id 851..860 is slot 1..10", R.slotOfPeriodId(851) === 1 && R.slotOfPeriodId(856) === 6 && R.slotOfPeriodId("860") === 10);
  check("period ids outside 851..860, and 0, have no slot", R.slotOfPeriodId(850) === null && R.slotOfPeriodId(861) === null
    && R.slotOfPeriodId(0) === null && R.slotOfPeriodId("x") === null);
  check("labels: slot s is P(s-1); 1 is Promise Time AM; 8 and 9 Power-Up; 10 Promise Time PM",
    R.slotLabel(2) === "P1" && R.slotLabel(7) === "P6" && R.slotLabel(1) === "Promise Time AM"
    && R.slotLabel(8) === "Power-Up" && R.slotLabel(9) === "Power-Up" && R.slotLabel(10) === "Promise Time PM");
  check("absent means presence status Absent: Ditching is coded Present, Suspended is coded Absent",
    CODES.byId[CODE_ID.K].absent === false && CODES.byId[CODE_ID.S].absent === true && CODES.byId[CODE_ID.T].absent === false);
  const noT = R.buildCodeBook([{ id: 1, att_code: "A", description: "Absent", presence_status_cd: "Absent" }]);
  check("no Tardy code in attendance_code: the read is refused with a reason", noT.ok === false && /Tardy \(T\)/.test(noT.reason));
  const d = day({ marks: [[S, 4, "T"]], rows: [
    { id: "u1", studentNumber: S, attDate: MON, periodId: 0, codeId: CODE_ID.T },
    { id: "u2", studentNumber: S, attDate: MON, periodId: 870, codeId: CODE_ID.T },
  ] });
  check("rows with an unknown period are counted for the banner, never dropped silently",
    d.summary.unmappedRows === 2 && J(d.summary.unmappedPeriodIds) === J([0, 870]), J(d.summary.unmappedPeriodIds));
  const c = cands(d)[0];
  check("the class teacher comes from the roster snapshot by student and slot", c && c.classTeacher === "Ortiz");
  const noTeacher = day({ marks: [[S, 4, "T"]], roster: { [S]: snap(S, 7, SECTIONS, { teacherBySlot: {} }) } });
  const c2 = cands(noTeacher)[0];
  check("a missing teacher never holds a tardy back: it is counted and reads 'Tardy P3'",
    c2 && c2.verdict === "counted" && c2.classTeacher === null && /: Tardy P3$/.test(R.tardyLine({ attDate: MON, slot: 4, classTeacher: null })));
  check("the natural key is student, date and period id", c.key === `${S}|${MON}|854` && R.tardyKey(S, MON, "854") === c.key);
  const ns = R.normalizeRows([{ id: 9, studentid: 77, att_date: MON + "T00:00:00", periodid: 852, attendance_codeid: 2 },
    { id: 10, studentid: 999, att_date: MON, periodid: 852, attendance_codeid: 2 }], { 77: S });
  check("PowerSchool's student id is mapped to the student number; an unknown one is counted, not guessed",
    ns.rows.length === 1 && ns.rows[0].studentNumber === S && ns.rows[0].attDate === MON && ns.unmatched === 1);
}

console.log("\n3.1 THE CONTROLS: WHAT IS NEVER LISTED\n");
{
  check("the D control: an Excused Tardy is never listed", cands(day({ marks: [[S, 4, "D"]] })).length === 0);
  check("Ditching (K) is not counted by default", cands(day({ marks: [[S, 4, "K"]] })).length === 0);
  const ditch = R.reflectionSettingsOrDefault({ ...ON, countDitching: true });
  check("...and is counted when countDitching is on",
    R.tardyCandidates(day({ marks: [[S, 4, "K"]] }).summary, day({ marks: [[S, 4, "K"]] }).roster, ditch).some((c) => c.studentNumber === S));
  const pt = day({ marks: [[S, 1, "T"], [S, 9, "T"], [S, 10, "T"]] });
  check("tardies in slots 1, 9 and 10 (Promise Time and Power-Up) are never listed", cands(pt).length === 0);
  const hsPu = day({ marks: [["20002", 8, "T"]], roster: { "20002": snap("20002", 10, { 1: "PT-H", 8: "PU-10" }) } });
  check("...nor slot 8 (HS Power-Up)", R.tardyCandidates(hsPu.summary, hsPu.roster, ON).length === 0);
  const pu = R.reflectionSettingsOrDefault({ ...ON, countPowerUpTardies: true });
  check("a Power-Up tardy is listed only when countPowerUpTardies is on",
    R.tardyCandidates(pt.summary, pt.roster, pu).filter((c) => c.studentNumber === S).map((c) => c.slot).join() === "9");
}

// ===========================================================================
console.log("\n3.2 WHICH SLOTS MET, AND SECTION MARKS\n");
{
  const d = day({ meet: [2], marked: [] });
  check("a slot with 10 rows met", R.slotMet(d.summary, 2) && d.summary.met.includes(2));
  const nine = R.summarizeDay(MON, Array.from({ length: 9 }, (_, i) => ({ id: "n" + i, studentNumber: "x" + i, attDate: MON, periodId: 852, codeId: "1" })), CODES, {});
  check("a slot with 9 rows did not meet", !R.slotMet(nine, 2));
  const future = [];
  for (const slot of [1, 2, 4, 6, 9, 10]) for (let i = 0; i < 3; i++) future.push({ id: `f${slot}${i}`, studentNumber: "y" + i, attDate: "2026-10-16", periodId: 850 + slot, codeId: "7" });
  const fs = R.summarizeDay("2026-10-16", future, CODES, {});
  check("18 future-dated rows (3 per slot) meet no slot", fs.met.length === 0);
  check("...and do not make a school day",
    R.schoolDayVerdict({ date: "2026-10-16", rowCounts: fs.rowCounts, readSucceeded: true }).verdict === "no");
  const m = day({ marked: ["PT-A"] });
  check("a section has marks when any student enrolled in it has a row in that slot",
    R.sectionHasMarks(m.summary, 1, "PT-A") && !R.sectionHasMarks(m.summary, 2, "P1-A"));
  check("rows from another date are not counted in the day",
    R.summarizeDay(MON, [{ id: "z", studentNumber: S, attDate: TUE, periodId: 852, codeId: "2" }], CODES, {}).rowCounts["2"] === undefined);
}

// ===========================================================================
console.log("\n3.3 ARRIVED LATE TO SCHOOL: THE SPEC'S EXAMPLES\n");
{
  check("PT AM tardy then first-class T is skipped", verdictAt(day({ marks: [[S, 1, "T"], [S, 2, "T"]] }), 2) === "arrival");
  check("absent at PT AM, then a first-class T, is skipped", verdictAt(day({ marks: [[S, 1, "A"], [S, 2, "T"]] }), 2) === "arrival");
  check("arrival during P3 is skipped", verdictAt(day({ marks: [[S, 1, "A"], [S, 2, "A"], [S, 4, "T"]] }), 4) === "arrival");
  check("present at PT AM (no row, its section has marks), then a T in P1, counts",
    verdictAt(day({ marks: [[S, 2, "T"]] }), 2) === "counted");
  const lateLater = day({ marks: [[S, 1, "A"], [S, 2, "T"], [S, 4, "T"]] });
  check("late arriver later tardy to P3 counts", verdictAt(lateLater, 4) === "counted");
  check("...and the P1 tardy that proves they arrived is skipped", verdictAt(lateLater, 2) === "arrival");
  check("absent all morning and absent at Power-Up, then a T in P5, is skipped",
    verdictAt(day({ marks: [[S, 1, "A"], [S, 2, "A"], [S, 4, "A"], [S, 9, "A"], [S, 6, "T"]] }), 6) === "arrival");
  // The spec pairs "Power-Up placed after slot 7" with the case above, but
  // that case is an arrival either way. This one is decided BY Power-Up.
  check("Power-Up comes before P5: absent all morning, at Power-Up, then T at P5 counts",
    verdictAt(day({ marks: [[S, 1, "A"], [S, 2, "A"], [S, 4, "A"], [S, 6, "T"]] }), 6) === "counted");
  check("a T with no earlier slot that met at all is an arrival",
    verdictAt(day({ meet: [2], marked: [], marks: [[S, 2, "T"]] }), 2) === "arrival");
  check("a blank Present code at PT AM is present", verdictAt(day({ marks: [[S, 1, "P"], [S, 2, "T"]] }), 2) === "counted");
  check("Ditching at PT AM is still present (coded Present, not T or D)", verdictAt(day({ marks: [[S, 1, "K"], [S, 2, "T"]] }), 2) === "counted");
  check("an Excused Tardy at PT AM is an arrival too", verdictAt(day({ marks: [[S, 1, "D"], [S, 2, "T"]] }), 2) === "arrival");
  check("Suspended at PT AM is absent", verdictAt(day({ marks: [[S, 1, "S"], [S, 2, "T"]] }), 2) === "arrival");
  check("an earlier Excused Tardy in a class proves presence",
    verdictAt(day({ marks: [[S, 1, "A"], [S, 2, "D"], [S, 4, "T"]] }), 4) === "counted");
}

console.log("\n3.3 THE ENROLMENT FILTER\n");
{
  // Enrolled in PT, P3 and Power-Up only: P1 met school-wide, but it is not theirs.
  const own = { "30003": snap("30003", 7, { 1: "PT-A", 4: "P3-A", 9: "PU-7" }) };
  const d = day({ marks: [["30003", 1, "A"], ["30003", 4, "T"]], roster: own });
  check("a class the student is not enrolled in is not evidence of being in school",
    R.tardyCandidates(d.summary, d.roster, ON).find((c) => c.studentNumber === "30003")?.verdict === "arrival");
  const none = day({ marks: [["40004", 1, "A"], ["40004", 4, "T"]] });
  check("a student with no roster rows skips the enrolment filter (P1 met, no row: present)",
    R.tardyCandidates(none.summary, none.roster, ON).find((c) => c.studentNumber === "40004")?.verdict === "counted");
  const nonePu = day({ marks: [["40004", 1, "A"], ["40004", 2, "A"], ["40004", 4, "A"], ["40004", 6, "T"]] });
  check("...but never reads the Power-Up slots as presence, since nobody knows which one is theirs",
    R.tardyCandidates(nonePu.summary, nonePu.roster, ON).find((c) => c.studentNumber === "40004")?.verdict === "arrival");
}

console.log("\n3.3 HOLDS: NO MARKS YET MEANS NOBODY KNOWS YET\n");
{
  const noPt = day({ marked: ["P1-A", "P3-A", "PU-7", "P5-A"], marks: [[S, 2, "T"]] });
  check("PT AM section with no marks holds the first-class T", verdictAt(noPt, 2) === "held");
  const held = cands(noPt).find((c) => c.slot === 2);
  check("the hold says what it waits for", held && J(held.unknownSlots) === J([1]) && /Promise Time AM/.test(held.reason));
  check("...it is released as counted once the section's marks are in", verdictAt(day({ marks: [[S, 2, "T"]] }), 2) === "counted");
  check("...or at the after-school read, when a section with no marks is taken as everyone present",
    verdictAt(noPt, 2, { final: true }) === "counted");
  check("an absent mark elsewhere does not turn a hold into a count",
    verdictAt(day({ marked: ["P3-A"], marks: [[S, 2, "A"], [S, 4, "T"]] }), 4) === "held");
  check("the banner counts Promise Time AM sections with no marks", R.blankSections(noPt.summary, noPt.roster, 1).includes("PT-A")
    && !R.blankSections(day().summary, day().roster, 1).includes("PT-A"));
  const hold = R.reflectionSettingsOrDefault({ ...ON, holdFirstClassOnPtNoRow: true });
  const ptNoRow = day({ marks: [[S, 2, "T"]] });
  const h = R.tardyCandidates(ptNoRow.summary, ptNoRow.roster, hold).find((c) => c.studentNumber === S);
  check("holdFirstClassOnPtNoRow: a first-class T resting only on 'no row at PT AM' waits for the after-school read", h?.verdict === "held");
  check("...and counts at the after-school read",
    R.tardyCandidates(ptNoRow.summary, ptNoRow.roster, hold, { final: true }).find((c) => c.studentNumber === S)?.verdict === "counted");
  check("...but a real Present mark at PT AM is not held by it",
    R.tardyCandidates(day({ marks: [[S, 1, "P"], [S, 2, "T"]] }).summary, day({ marks: [[S, 1, "P"], [S, 2, "T"]] }).roster, hold)
      .find((c) => c.studentNumber === S)?.verdict === "counted");
  check("the setting is off by default", R.reflectionSettingsOrDefault({}).holdFirstClassOnPtNoRow === false);
}

console.log("\n3.7 ABSENT THIS MORNING\n");
{
  check("absent in every class that met before Power-Up: flagged",
    R.absentThisMorning(day({ marks: [[S, 1, "A"], [S, 2, "A"], [S, 4, "A"]] }).summary, S, snap(S, 7, SECTIONS)));
  check("present in any of them: not flagged",
    !R.absentThisMorning(day({ marks: [[S, 1, "A"], [S, 2, "A"]] }).summary, S, snap(S, 7, SECTIONS)));
}

// ===========================================================================
console.log("\n3.4 UNIFORM: THE SERVER SETS THE DAY\n");
{
  const nowWed = at(WED, "08:10");
  const tue752 = Date.parse(at(TUE, "07:52"));
  const q = R.observedAtVerdict({ observedAt: tue752, nowIso: nowWed, tz: TZ, clientDay: WED });
  check("an entry queued Tue 07:52 and sent Wed 08:10 is filed under Tue", q.day === TUE && q.source === "observed" && q.at === at(TUE, "07:52"));
  check("...and is tagged saved late, with the time it was saved", q.savedAt === nowWed);
  const old = R.observedAtVerdict({ observedAt: Date.parse(nowWed) - 73 * 3600e3, nowIso: nowWed, tz: TZ });
  check("an observedAt older than 72 hours falls back to now and is counted", old.day === WED && old.source === "now" && old.outOfWindow);
  const fut = R.observedAtVerdict({ observedAt: Date.parse(nowWed) + 6 * 60e3, nowIso: nowWed, tz: TZ });
  check("an observedAt more than 5 minutes ahead falls back to now", fut.source === "now" && fut.outOfWindow);
  const fresh = R.observedAtVerdict({ observedAt: Date.parse(nowWed) - 9 * 60e3, nowIso: nowWed, tz: TZ });
  check("an entry saved within 10 minutes is not 'saved late'", fresh.source === "observed" && fresh.savedAt === null);
  const tomorrow = R.observedAtVerdict({ nowIso: nowWed, tz: TZ, clientDay: "2026-10-15" });
  check("a client day of tomorrow is ignored and counted", tomorrow.day === WED && tomorrow.clientDayMismatch && !tomorrow.outOfWindow);
  const evening = R.observedAtVerdict({ nowIso: "2026-10-15T00:30:00.000Z", tz: TZ });
  check("an entry at 17:30 LA is that LA day, not the UTC tomorrow", evening.day === WED);
}

// ===========================================================================
console.log("\n3.5 SCHOOL DAY\n");
{
  const counts = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [String(k), v]));
  check("a date marked with a schedule is a school day", R.schoolDayVerdict({ date: "2026-10-10", marked: { scheduleId: "s1" } }).verdict === "yes");
  check("a date marked noSchool never is, whatever PowerSchool shows",
    R.schoolDayVerdict({ date: MON, marked: { noSchool: true, scheduleId: "s1" }, rowCounts: counts({ 1: 150 }) }).verdict === "no");
  check("a weekend is never a school day unless marked, even with attendance rows",
    R.schoolDayVerdict({ date: "2026-10-10", rowCounts: counts({ 1: 150, 2: 90 }), readSucceeded: true }).verdict === "no");
  check("a weekday with 20 Promise Time AM rows is a school day", R.schoolDayVerdict({ date: MON, rowCounts: counts({ 1: 20 }) }).verdict === "yes");
  check("...19 is not enough on its own", R.schoolDayVerdict({ date: MON, rowCounts: counts({ 1: 19 }), readSucceeded: true }).verdict === "no");
  check("60 rows across two slots is a school day", R.schoolDayVerdict({ date: MON, rowCounts: counts({ 2: 40, 4: 20 }) }).verdict === "yes");
  check("...60 rows in one class slot is not", R.schoolDayVerdict({ date: MON, rowCounts: counts({ 2: 60 }), readSucceeded: true }).verdict === "no");
  check("an admin's 'This is a school day' is evidence", R.schoolDayVerdict({ date: MON, adminMarked: true }).verdict === "yes");
  check("uniform entries are not evidence",
    R.schoolDayVerdict({ date: MON, uniformRows: 3, readSucceeded: true }).verdict === "no");
  check("with no PowerSchool read yet, the day is unknown, not 'no'", R.schoolDayVerdict({ date: MON }).verdict === "unknown");
  check("the 07:30 read (before Promise Time) cannot prove there is no school",
    !R.provesNoSchool({ date: MON, lastGoodReadAt: at(MON, "07:30") }, TZ) && R.provesNoSchool({ date: MON, lastGoodReadAt: at(MON, "10:30") }, TZ));
}

console.log("\n3.5 SCHEDULE TYPE AND THE THREE TIMES\n");
{
  const kind = (o) => R.scheduleKindFor(o).kind;
  check("a marked schedule maps through settings.scheduleKinds", kind({ date: MON, marked: { scheduleId: "x" }, scheduleKinds: { x: "stack" } }) === "stack");
  check("...or by its name: the seeded names all match",
    kind({ date: MON, marked: { scheduleId: "a", scheduleName: "Regular · Wednesday" } }) === "wed"
    && kind({ date: MON, marked: { scheduleId: "b", scheduleName: "Minimum Day" } }) === "minimum"
    && kind({ date: MON, marked: { scheduleId: "c", scheduleName: "Stack Day / Return from Holiday" } }) === "stack"
    && kind({ date: MON, marked: { scheduleId: "d", scheduleName: "Regular · Mon/Thu" } }) === "regular");
  check("an unmarked Wednesday is wed, Mon/Tue/Thu/Fri regular", kind({ date: WED }) === "wed" && kind({ date: MON }) === "regular" && kind({ date: TUE }) === "regular");
  const six = R.scheduleKindFor({ date: TUE, rowCounts: { 2: 30, 3: 25 } });
  check("a six-period Tuesday (slots 2 and 3 both met) is detected and treated as minimum", six.kind === "minimum" && six.sixPeriodDetected && six.source === "detected");
  check("...as is one where slots 4 and 5 both met", R.scheduleKindFor({ date: "2026-10-15", rowCounts: { 4: 12, 5: 11 } }).kind === "minimum");
  check("a normal Monday (slots 2 and 4) is not six-period", R.scheduleKindFor({ date: MON, rowCounts: { 2: 40, 4: 40 } }).kind === "regular");
  const t = (k) => R.dayTimes(MON, k, ON, TZ);
  const hm = (m) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
  const row = (k) => [t(k).closeMinute, t(k).readyMinute, t(k).lastFreezeMinute].map(hm).join(" ");
  check("regular: close 11:45, ready 12:00, latest 12:21", row("regular") === "11:45 12:00 12:21", row("regular"));
  check("wed: close 11:20, ready 11:30, latest 11:32", row("wed") === "11:20 11:30 11:32", row("wed"));
  check("minimum: close 11:20, ready 11:30, latest 11:32", row("minimum") === "11:20 11:30 11:32", row("minimum"));
  check("stack: close 11:50, ready 12:00, latest 12:12", row("stack") === "11:50 12:00 12:12", row("stack"));
  check("a six-period Tuesday closes at 11:20", R.dayTimes(TUE, six.kind, ON, TZ).close === at(TUE, "11:20"));
}

console.log("\n3.5 DAYLIGHT SAVING: LA WALL CLOCK TO UTC\n");
{
  check("laWallToUtc 2026-10-30 11:45 is 18:45Z (PDT)", R.laWallToUtc("2026-10-30", 705, TZ) === "2026-10-30T18:45:00.000Z");
  check("laWallToUtc 2026-11-02 11:45 is 19:45Z (PST)", R.laWallToUtc("2026-11-02", 705, TZ) === "2026-11-02T19:45:00.000Z");
  check("laWallToUtc 2026-11-04 11:20 is 19:20Z (PST)", R.laWallToUtc("2026-11-04", 680, TZ) === "2026-11-04T19:20:00.000Z");
  check("laWallToUtc 2027-03-15 11:45 is 18:45Z (PDT again)", R.laWallToUtc("2027-03-15", 705, TZ) === "2027-03-15T18:45:00.000Z");
  const evid = (date) => ({ date, rowCounts: { 1: 150, 2: 80, 4: 70 }, lastGoodReadAt: at(date, "11:35"), readsDone: [] });
  const tick = (iso, date) => R.decideTick({ nowIso: iso, tz: TZ, day: evid(date), settings: ON });
  const isClosing = (d) => d.do === "read" && d.freeze === "closing";
  check("DST: 2026-10-30 18:45Z is 11:45 PDT, a closing read", isClosing(tick("2026-10-30T18:45:00.000Z", "2026-10-30")));
  check("DST: 2026-11-02 18:45Z is 10:45 PST, not a closing read", !isClosing(tick("2026-11-02T18:45:00.000Z", "2026-11-02")));
  check("DST: 2026-11-02 19:45Z is 11:45 PST, a closing read", isClosing(tick("2026-11-02T19:45:00.000Z", "2026-11-02")));
  check("DST: 2026-11-04 19:20Z is Wednesday 11:20 PST, a closing read", isClosing(tick("2026-11-04T19:20:00.000Z", "2026-11-04")));
  check("DST: 2027-03-15 18:45Z is 11:45 PDT, a closing read", isClosing(tick("2027-03-15T18:45:00.000Z", "2027-03-15")));
}

// ===========================================================================
// A whole day of ticks, every 5 minutes, against the pure tick and freeze.
function runDay({ date, settings = ON, marked = null, readWorks = () => true, counts = () => ({ 1: 150, 2: 80, 4: 70 }), adminMarked = false, uniformRows = 0 }) {
  const day = { date, marked, readsDone: [], rowCounts: null, lastGoodReadAt: null, adminMarkedSchoolDay: adminMarked, uniformRows };
  const log = [];
  for (let m = 7 * 60; m < 17 * 60; m += 5) {
    const nowIso = R.laWallToUtc(date, m, TZ);
    const d = R.decideTick({ nowIso, tz: TZ, day, settings });
    if (d.do === "read") {
      const ok = readWorks(m, d);
      log.push({ m, key: d.key, ok });
      if (!ok) continue;
      day.rowCounts = counts(m);
      day.lastGoodReadAt = nowIso;
      day.readsDone.push(d.key);
      if (d.freeze) {
        const fv = R.freezeVerdict({ nowIso: plus(nowIso, 20000), startedAt: nowIso, intent: d.freeze, day, settings, tz: TZ });
        if (fv.freeze) {
          day.frozenAt = plus(nowIso, 20000);
          day.freezeKind = fv.kind;
          if (fv.kind === "closing") day.closingReadStartedAt = nowIso;
        }
      }
    } else if (d.do === "fallback-freeze") {
      day.frozenAt = nowIso; day.freezeKind = "fallback"; log.push({ m, key: "fallback" });
    } else if (d.do === "latest-freeze") {
      day.noList = { ...d.noList, at: nowIso }; log.push({ m, key: "latest" });
    }
  }
  return { day, log };
}
const hhmm = (iso) => R.clockText(iso, TZ);

console.log("\n3.6 THE CLOSING READ, THE FALLBACK, THE LATEST TIME\n");
{
  const normal = runDay({ date: MON });
  check("a normal day is made by the first closing read at 11:45",
    normal.day.freezeKind === "closing" && hhmm(normal.day.closingReadStartedAt) === "11:45", J(normal.day));
  check("the morning reads run once each: 07:30, 08:30, 09:30, 10:30 and four pre-close reads",
    normal.log.filter((l) => l.m < 705).map((l) => l.key).join() === "opening,routine@510,routine@570,routine@630,pre-close@40,pre-close@30,pre-close@20,pre-close@10",
    normal.log.filter((l) => l.m < 705).map((l) => l.key).join());
  check("after the list: 13:00, 14:00, 15:00 and the after-school read at 15:45",
    normal.log.filter((l) => l.m > 705).map((l) => l.key).join() === "after-close@780,after-close@840,after-close@900,after-school");

  const late = runDay({ date: MON, readWorks: (m) => m < 705 || m >= 715 });
  check("closing fails 11:45 and 11:50, succeeds 11:55, is closing",
    late.day.freezeKind === "closing" && hhmm(late.day.closingReadStartedAt) === "11:55", J(late.day));

  const tStart = R.decideTick({ nowIso: at(MON, "11:57"), tz: TZ, day: { date: MON, rowCounts: { 1: 150 }, lastGoodReadAt: at(MON, "11:35") }, settings: ON });
  check("no closing read starts at 11:57 (11:57 + 4 min is past 12:00)", tStart.do === "none", J(tStart));

  const close = at("2026-10-30", "11:45");
  const exact = R.decideTick({ nowIso: close, tz: TZ, day: { date: "2026-10-30", rowCounts: { 1: 150 }, lastGoodReadAt: at("2026-10-30", "11:35") }, settings: ON });
  const exactFreeze = R.freezeVerdict({ nowIso: plus(close, 15000), startedAt: close, intent: "closing", day: { date: "2026-10-30", rowCounts: { 1: 150 } }, settings: ON, tz: TZ });
  check("a read starting exactly at close is closing", exact.do === "read" && exact.freeze === "closing" && exactFreeze.freeze === true);
  const early = R.freezeVerdict({ nowIso: close, startedAt: plus(close, -1000), intent: "closing", day: { date: "2026-10-30", rowCounts: { 1: 150 } }, settings: ON, tz: TZ });
  check("...and one that started a second before close never makes the list", early.freeze === false);

  const fb = runDay({ date: MON, readWorks: (m) => m < 705 });
  check("closing reads all fail but the day is known: the fallback makes it at 12:00",
    fb.day.freezeKind === "fallback" && hhmm(fb.day.frozenAt) === "12:00");
  check("...with the banner 'Made at 12:00 without a final PowerSchool read (last good read 11:35)'",
    R.freezeBanner(fb.day, TZ) === "Made at 12:00 without a final PowerSchool read (last good read 11:35).", R.freezeBanner(fb.day, TZ));

  const held = R.decideTick({ nowIso: at(MON, "12:00"), tz: TZ, settings: ON,
    day: { date: MON, rowCounts: { 1: 150 }, lastGoodReadAt: at(MON, "11:35") },
    lease: { runId: "r1", kind: "closing", startedAt: at(MON, "11:57"), expiresAt: at(MON, "12:01") } });
  check("a fallback tick while a closing lease is held does not freeze (it books itself again in 30 s)",
    held.do === "retry" && held.afterMs === 30000, J(held));
  const held9 = R.decideTick({ nowIso: at(MON, "12:00"), tz: TZ, settings: ON, retry: 8,
    day: { date: MON, rowCounts: { 1: 150 }, lastGoodReadAt: at(MON, "11:35") },
    lease: { runId: "r1", kind: "closing", startedAt: at(MON, "11:57"), expiresAt: at(MON, "12:01") } });
  check("...at most 8 times", held9.do === "none");
  // "Read PowerSchool now" pressed at 11:28 on a Wednesday is an after-close
  // read: it can never make the list. The fallback must not wait on it
  // through its whole 2-minute window (review, 2026-10-08).
  const manual = R.decideTick({ nowIso: at(WED, "11:30"), tz: TZ, settings: ON,
    day: { date: WED, rowCounts: { 1: 150 }, lastGoodReadAt: at(WED, "11:15") },
    lease: { runId: "m1", kind: "after-close", startedAt: at(WED, "11:28"), expiresAt: at(WED, "11:32") } });
  check("the fallback does not wait for a manual after-close read: a Wednesday still gets its list at 11:30",
    manual.do === "fallback-freeze", J(manual));
  const lateLease = R.decideTick({ nowIso: at(MON, "12:05"), tz: TZ, settings: ON,
    day: { date: MON, rowCounts: { 1: 150 }, lastGoodReadAt: at(MON, "11:35") },
    lease: { runId: "l1", kind: "late-closing", startedAt: at(MON, "12:03"), expiresAt: at(MON, "12:07") } });
  check("...but it does wait for a late closing read, which may make the list itself", lateLease.do === "retry", J(lateLease));

  const lateMade = runDay({ date: MON, readWorks: (m) => m >= 725, counts: () => ({ 1: 150, 2: 80 }) });
  check("regular day with no evidence until a read succeeds at 12:05 is made late",
    lateMade.day.freezeKind === "late" && hhmm(lateMade.day.frozenAt) === "12:05", J(lateMade.day));
  check("...with the banner 'Made late at 12:05. Check the time before pulling.'",
    R.freezeBanner(lateMade.day, TZ) === "Made late at 12:05. Check the time before pulling.");

  const wed = runDay({ date: WED, readWorks: () => false });
  check("Wednesday with no evidence by 11:30 has no list, and no late read is tried",
    !!wed.day.noList && !wed.day.frozenAt && !wed.log.some((l) => l.key === "late-closing"), J(wed.log.slice(-4)));

  const noTick = R.decideTick({ nowIso: at(MON, "11:41"), tz: TZ, settings: ON, day: { date: MON, rowCounts: { 1: 150 }, lastGoodReadAt: at(MON, "11:25"), readsDone: ["pre-close@40", "pre-close@30", "pre-close@20"] } });
  check("no read starts in the minutes before close, so the lease is free at close", noTick.do === "none", J(noTick));

  check("both divisions off: the tick does nothing",
    R.decideTick({ nowIso: at(MON, "11:45"), tz: TZ, settings: {}, day: { date: MON } }).do === "none");
  check("a date marked noSchool: the tick does nothing",
    R.decideTick({ nowIso: at(MON, "11:45"), tz: TZ, settings: ON, day: { date: MON, marked: { noSchool: true } } }).do === "none");
  const sixClose = R.decideTick({ nowIso: at(TUE, "11:20"), tz: TZ, settings: ON, day: { date: TUE, rowCounts: { 1: 150, 2: 40, 3: 40 }, lastGoodReadAt: at(TUE, "11:10") } });
  check("a six-period Tuesday's closing read starts at 11:20", sixClose.do === "read" && sixClose.freeze === "closing");
  const frozen = R.freezeVerdict({ nowIso: at(MON, "11:50"), startedAt: at(MON, "11:45"), intent: "closing", day: { date: MON, rowCounts: { 1: 150 }, frozenAt: at(MON, "11:46") }, settings: ON, tz: TZ });
  check("a read applied to a day already made never makes it again", frozen.freeze === false);
  const pastLatest = R.freezeVerdict({ nowIso: at(MON, "12:22"), startedAt: at(MON, "12:15"), intent: "late", day: { date: MON, rowCounts: { 1: 150 } }, settings: ON, tz: TZ });
  check("a late read that commits after the latest time does not make the list", pastLatest.freeze === false);
  check("'Read PowerSchool now' before close is a routine read; in the closing window a closing read",
    R.readNowIntent({ nowIso: at(MON, "10:00"), day: { date: MON }, settings: ON, tz: TZ }).freeze === null
    && R.readNowIntent({ nowIso: at(MON, "11:50"), day: { date: MON }, settings: ON, tz: TZ }).freeze === "closing");
  check("...after ready it may only make a late list, and after the latest time nothing",
    R.readNowIntent({ nowIso: at(MON, "12:10"), day: { date: MON }, settings: ON, tz: TZ }).freeze === "late"
    && R.readNowIntent({ nowIso: at(MON, "12:30"), day: { date: MON }, settings: ON, tz: TZ }).freeze === null);
}

// ===========================================================================
console.log("\n3.6 THE FREEZE: WHICH LIST A VIOLATION GOES ON\n");
const tardy = (o) => ({ id: o.id ?? "t" + Math.random().toString(36).slice(2, 7), studentNumber: S, attDate: MON, periodId: 850 + (o.slot ?? 2),
  slot: o.slot ?? 2, psRowIds: ["p1"], state: "countable", firstSeenAt: at(o.attDate ?? MON, "10:30"), classTeacher: "Lee", ...o });
const uni = (o) => ({ id: o.id ?? "u" + Math.random().toString(36).slice(2, 7), studentNumber: S, day: MON, at: at(o.day ?? MON, "07:52"), voided: false, ...o });
const claim = (dayKey, { tardies = [], uniforms = [], units = [], days = {}, settings = ON, divisionOf = { [S]: "ms" } } = {}) =>
  R.claimAtFreeze({ day: dayKey, tz: TZ, settings, divisionOf, tardies, uniforms, units, days });
{
  const merged = claim(MON, {
    tardies: [tardy({ id: "a", slot: 4, classTeacher: "Ortiz" }), tardy({ id: "b", attDate: "2026-10-09", slot: 7, classTeacher: "Kim" })],
    uniforms: [uni({ id: "u1", loaner: true })],
  });
  const r = merged.rows[0];
  check("one student, several violations on one list: one detention, one row (owner, 10/8)", merged.rows.length === 1 && r.owes === 1 && r.serve === "new");
  check("every violation shows its own date, in LA time",
    J(r.lines) === J(["Fri 10/9: Tardy P6 (Kim)", "Mon 10/12: Tardy P3 (Ortiz)", "Mon 10/12: Uniform 7:52 AM (loaner)"]), J(r.lines));
  check("Friday P6 is claimed Monday, tagged 'From Fri 10/9 P6 (after Power-Up)'", r.tags.includes("From Fri 10/9 P6 (after Power-Up)"), J(r.tags));
  check("the freeze claims exactly what it lists", J(merged.claimedTardyIds.sort()) === J(["a", "b"]) && J(merged.claimedUniformIds) === J(["u1"]));

  const p5 = claim(MON, { tardies: [tardy({ id: "p5", slot: 6 }), tardy({ id: "p6", slot: 7 })] });
  check("P5 never serves the same day", p5.rows.length === 0 && p5.claimedTardyIds.length === 0);
  const p5next = claim(TUE, { tardies: [tardy({ id: "p5", slot: 6 })] });
  check("...it serves the next list", p5next.claimedTardyIds.includes("p5"));
  const notYet = claim(MON, { tardies: [tardy({ id: "tue", attDate: TUE, slot: 2 })], uniforms: [uni({ id: "tu", day: TUE })] });
  check("nothing dated after the serve day is claimed", notYet.rows.length === 0);
  const states = ["held", "arrival", "cleared", "before-start", "review"];
  const none = claim(MON, { tardies: states.map((s) => tardy({ id: s, state: s })) });
  check("held, arrival, cleared, before-start and review tardies are never claimed", none.rows.length === 0, J(none.claimedTardyIds));
  const assigned = claim(MON, { tardies: [tardy({ id: "x", unitId: "U1" })] });
  check("a tardy already on a list is never claimed twice", assigned.rows.length === 0);
  const voided = claim(MON, { uniforms: [uni({ id: "v", voided: true }), uni({ id: "r", reflectionState: "review" })] });
  check("a voided uniform entry, or one in review, is never claimed", voided.rows.length === 0);
  const off = claim(MON, { tardies: [tardy({ id: "o" })], uniforms: [uni({ id: "ou" })],
    settings: R.reflectionSettingsOrDefault({ ...ON, modeByDivision: { ms: "off", hs: "shadow" } }) });
  check("a division that is switched off has no list", off.rows.length === 0);
  check("...and the other division's freeze leaves its items waiting, neither claimed nor parked (switching it on decides)",
    off.claimedTardyIds.length === 0 && off.claimedUniformIds.length === 0 && off.parked.tardyIds.length === 0 && off.parked.uniformIds.length === 0,
    J({ claimed: [off.claimedTardyIds, off.claimedUniformIds], parked: off.parked }));
  const unplaced = claim(MON, { tardies: [tardy({ id: "q" })], divisionOf: {} });
  check("a student with no division is reported, never guessed", unplaced.rows.length === 0 && J(unplaced.unplaced) === J([S]));

  // MS live from Tuesday 10/13 (it was the pilot before). Everything below is
  // claimable by the old rules; only Tuesday's own tardy may be listed.
  const LIVE = R.reflectionSettingsOrDefault({ modeByDivision: { ms: "live", hs: "off" }, countFromDateByDivision: { ms: TUE, hs: null } });
  const pilotCarry = { id: "PC", studentNumber: "10002", division: "ms", kind: "carry", state: "pending", recordedAt: at(TUE, "07:30"),
    carryCount: 1, mode: "shadow", carriedFromDay: MON, tags: [], lines: [] };
  const oldCarry = { id: "OC", studentNumber: "10003", division: "ms", kind: "carry", state: "pending", recordedAt: at(TUE, "07:30"),
    carryCount: 1, mode: "live", carriedFromDay: MON, tags: [], lines: [] };
  const atSwitch = claim(TUE, {
    settings: LIVE, divisionOf: { [S]: "ms", 10004: "ms", 10005: "ms" },
    tardies: [tardy({ id: "friArrivalNowCounted", attDate: MON, slot: 3 }), tardy({ id: "today", studentNumber: "10005", attDate: TUE, slot: 2 })],
    uniforms: [uni({ id: "queuedFri", studentNumber: "10004", day: MON })],
    units: [pilotCarry, oldCarry],
  });
  check("at the moment of claiming: a tardy or uniform entry dated before countFromDate, a pilot carry, and a carry from before the start are parked, never listed",
    J(atSwitch.rows.map((r) => r.studentNumber)) === J(["10005"]) && J(atSwitch.parked.tardyIds) === J(["friArrivalNowCounted"])
      && J(atSwitch.parked.uniformIds) === J(["queuedFri"]) && J(atSwitch.parked.unitIds.sort()) === J(["OC", "PC"]),
    J({ rows: atSwitch.rows.map((r) => r.studentNumber), parked: atSwitch.parked }));

  const carry = { id: "C1", studentNumber: S, division: "ms", kind: "carry", state: "pending", recordedAt: at("2026-10-09", "15:45"), carryCount: 1,
    tags: ["Carried over from Fri 10/9 (absent)"], lines: ["Thu 10/8: Tardy P1 (Lee)"] };
  const owes = claim(MON, { tardies: [tardy({ id: "n1" })], units: [carry] });
  const o = owes.rows[0];
  check("a carried detention plus new violations: the row says 'Owes 2' and the oldest is served",
    o.owes === 2 && o.serve === "C1" && J(o.queued) === J(["new"]) && o.tags.includes("Owes 2"), J(o));
  check("...the row shows the served detention's violations and its carry tag",
    J(o.lines) === J(carry.lines) && o.tags.includes("Carried over from Fri 10/9 (absent)"));
  check("...and the new detention is handed back to queue for the next list", o.newUnit && J(o.newUnit.tardyIds) === J(["n1"]) && R.QUEUED_TAG === "Queued: 2nd detention");

  const days = {
    "2026-10-09": { date: "2026-10-09", frozenAt: at("2026-10-09", "11:46"), freezeKind: "closing", closingReadStartedAt: at("2026-10-09", "11:45") },
    [MON]: { date: MON, noList: { reason: "x", at: at(MON, "12:25") } },
    [TUE]: { date: TUE, frozenAt: at(TUE, "12:00"), freezeKind: "fallback" },
    "2026-10-08": { date: "2026-10-08", frozenAt: at("2026-10-08", "11:46"), freezeKind: "closing", closingReadStartedAt: at("2026-10-08", "11:45") },
  };
  const tags = (t) => R.tardyTags(t, WED, days, TZ);
  check("tag: Entered late in PowerSchool (first seen after its date's closing read started)",
    tags(tardy({ attDate: "2026-10-09", slot: 2, firstSeenAt: at("2026-10-09", "13:00") })).includes("Entered late in PowerSchool (Fri 10/9 P1)"));
  check("...but not for a tardy the closing read itself saw",
    tags(tardy({ attDate: "2026-10-09", slot: 2, firstSeenAt: at("2026-10-09", "11:45") })).length === 0);
  check("tag: Held for attendance, when the hold was released after its list was made",
    tags(tardy({ attDate: "2026-10-08", slot: 4, wasHeld: true, firstSeenAt: at("2026-10-08", "10:30"), firstCountableAt: at("2026-10-08", "15:45"),
      heldReleasedAt: at("2026-10-08", "15:45") })).includes("Held for attendance (Thu 10/8 P3)"));
  check("...but a hold released BEFORE its list, then an arrival at the close and counted after it, is Entered late, never Held",
    J(tags(tardy({ attDate: "2026-10-08", slot: 4, wasHeld: true, firstSeenAt: at("2026-10-08", "09:30"), heldReleasedAt: at("2026-10-08", "10:30"),
      firstCountableAt: at("2026-10-08", "13:00") }))) === J(["Entered late in PowerSchool (Thu 10/8 P3)"]));
  check("tag: Found after the list was made, on a date the fallback made",
    tags(tardy({ attDate: TUE, slot: 2, firstSeenAt: at(TUE, "13:00") })).includes("Found after the list was made (PowerSchool unreadable at close, Tue 10/13)"));
  check("...and on an arrival seen before that list, counting only after it",
    J(tags(tardy({ attDate: TUE, slot: 2, firstSeenAt: at(TUE, "08:30"), firstCountableAt: at(TUE, "13:00") })))
      === J(["Found after the list was made (PowerSchool unreadable at close, Tue 10/13)"]));
  check("tag: List not made, on a date with no list", tags(tardy({ attDate: MON, slot: 2 })).includes("List not made Mon 10/12"));
  check("tag: Uniform logged after the list closed",
    R.uniformTags(uni({ day: "2026-10-09", at: at("2026-10-09", "11:52") }), MON, days, TZ).includes("Uniform logged after the list closed (Fri 10/9 11:52)"));
  check("tag: Saved late (observed Tue 7:52)",
    R.uniformTags(uni({ day: TUE, at: at(TUE, "07:52"), savedAt: at(WED, "08:10") }), WED, {}, TZ).includes("Saved late (observed Tue 7:52)"));
}

console.log("\n3.6 WHOLE DAYS: NO LIST, WEEKENDS, HOLIDAYS\n");
{
  const down = runDay({ date: MON, readWorks: (m) => m >= 760, counts: () => ({ 1: 150, 2: 80 }) });
  const next = claim(TUE, {
    tardies: [tardy({ id: "mon1", attDate: MON, slot: 2, firstSeenAt: at(MON, "12:40") })],
    days: { [MON]: down.day },
  });
  check("no read until 12:40 means no list; items on D+1",
    !!down.day.noList && !down.day.frozenAt && next.claimedTardyIds.includes("mon1") && next.rows[0]?.tags.includes("List not made Mon 10/12"),
    J({ noList: down.day.noList, frozen: down.day.frozenAt, tags: next.rows[0]?.tags }));
  check("...the latest freeze lands at the first tick from 12:21", down.log.some((l) => l.key === "latest" && l.m === 745));
  check("...and the screen says where today's violations went",
    R.noListBanner(down.day, R.nextSchoolDayGuess(MON, []), TZ) === "No list today: PowerSchool unreachable all morning. Today's violations will be on Tue 10/13's list.",
    R.noListBanner(down.day, R.nextSchoolDayGuess(MON, []), TZ));

  const sat = runDay({ date: "2026-10-10", uniformRows: 1 });
  check("a Saturday uniform entry makes no list", sat.log.length === 0 && !sat.day.frozenAt && !sat.day.noList);
  const mon = claim(MON, { uniforms: [uni({ id: "sat", day: "2026-10-10", at: at("2026-10-10", "10:00") })] });
  check("...and is on Monday's list", mon.claimedUniformIds.includes("sat"));

  // An unmarked weekday holiday: PowerSchool answers, with only the 18 future-dated rows.
  const holiday = runDay({ date: "2026-11-11", uniformRows: 1, counts: () => ({ 1: 3, 2: 3, 4: 3, 6: 3, 9: 3, 10: 3 }) });
  check("an unmarked weekday holiday with a uniform entry makes no list",
    !holiday.day.frozenAt && !holiday.day.noList, J({ frozen: holiday.day.frozenAt, kind: holiday.day.freezeKind, noList: holiday.day.noList }));
  check("...and after the 10:30 read shows no school, only the closing and after-school reads still run",
    holiday.log.filter((l) => l.m > 630).map((l) => l.key).join() === "closing,after-school", holiday.log.map((l) => l.key).join());
  const thu = claim("2026-11-12", { uniforms: [uni({ id: "hol", day: "2026-11-11", at: at("2026-11-11", "08:00") })] });
  check("...the holiday's uniform entry is claimed by the next school day's list", thu.claimedUniformIds.includes("hol"));
  check("the next school day skips weekends and noSchool dates",
    R.nextSchoolDayGuess("2026-11-20", ["2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26", "2026-11-27"]) === "2026-11-30");
}

// ===========================================================================
console.log("\n3.9 SWITCHING ON, AND LATENESS COUNTED IN LISTS\n");
{
  const s = ON;
  check("a division switched off decides nothing yet: its items are stored as they read, and setMode decides when it is switched on",
    R.admitState("2026-10-12", "ms", R.reflectionSettingsOrDefault({})) === null);
  const fromTue = R.reflectionSettingsOrDefault({ ...ON, countFromDateByDivision: { ms: TUE, hs: TUE } });
  check("violations dated before countFromDate are before-start, never listed",
    R.admitState(MON, "ms", fromTue) === "before-start" && R.admitState(TUE, "ms", fromTue) === null);
  check("a before-start tardy stays before-start whatever else is true",
    R.initialTardyState({ verdict: "counted", admit: "before-start", listsBeforeSeen: 0, lateEntryLists: 5 }).state === "before-start");

  const shadow = { ms: "shadow", hs: "shadow" };
  const made = (dates) => dates.map((d) => ({ date: d, frozenAt: at(d, "11:46"), modeByDivision: shadow }));
  const thanksgiving = made(["2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20"]);
  const n1120 = R.listsBeforeSeen({ attDate: "2026-11-20", firstSeenAt: at("2026-11-30", "07:30"), division: "ms", days: thanksgiving });
  const st1120 = R.initialTardyState({ verdict: "counted", admit: null, listsBeforeSeen: n1120, lateEntryLists: s.lateEntryLists });
  const c1120 = claim("2026-11-30", { tardies: [tardy({ id: "fri", attDate: "2026-11-20", slot: 7, state: st1120.state, firstSeenAt: at("2026-11-30", "07:30") })] });
  check("11/20 P6 lands on 11/30", n1120 === 0 && st1120.state === "countable" && c1120.claimedTardyIds.includes("fri"), J({ n1120, st1120 }));

  const winter = made(["2026-12-14", "2026-12-15", "2026-12-16", "2026-12-17", "2026-12-18"]);
  const n1218 = R.listsBeforeSeen({ attDate: "2026-12-18", firstSeenAt: at("2027-01-11", "07:30"), division: "ms", days: winter });
  const st1218 = R.initialTardyState({ verdict: "counted", admit: null, listsBeforeSeen: n1218, lateEntryLists: s.lateEntryLists });
  const c1218 = claim("2027-01-11", { tardies: [tardy({ id: "dec", attDate: "2026-12-18", slot: 6, state: st1218.state, firstSeenAt: at("2027-01-11", "07:30") })] });
  check("12/18 P5 lands on 1/11", n1218 === 0 && st1218.state === "countable" && c1218.claimedTardyIds.includes("dec"), J({ n1218, st1218 }));

  const five = made(["2026-10-14", "2026-10-15", "2026-10-16", "2026-10-19", "2026-10-20"]);
  const n5 = R.listsBeforeSeen({ attDate: TUE, firstSeenAt: at("2026-10-21", "07:30"), division: "ms", days: [...made([TUE]), ...five] });
  const st5 = R.initialTardyState({ verdict: "counted", admit: null, listsBeforeSeen: n5, lateEntryLists: 5 });
  check("a T first seen after 5 lists goes to admin review, never silently onto a list", n5 === 5 && st5.state === "review" && /5 lists/.test(st5.reason));
  const n4 = R.listsBeforeSeen({ attDate: TUE, firstSeenAt: at("2026-10-20", "07:30"), division: "ms", days: [...made([TUE]), ...five] });
  check("...after 4 lists it is still listed", n4 === 4 && R.initialTardyState({ verdict: "counted", admit: null, listsBeforeSeen: n4, lateEntryLists: 5 }).state === "countable");
  const offDays = five.map((d) => ({ ...d, modeByDivision: { ms: "off", hs: "shadow" } }));
  check("only lists made for the tardy's own division count",
    R.listsBeforeSeen({ attDate: TUE, firstSeenAt: at("2026-10-21", "07:30"), division: "ms", days: offDays }) === 0);

  // A pending T is never late: held on 10/13 (seen with 0 lists), released after 6 lists.
  const heldItem = tardy({ id: "h", attDate: TUE, slot: 2, state: "held", wasHeld: true, firstSeenAt: at(TUE, "10:30") });
  const rel = R.reclassify(heldItem, { verdict: "counted", reason: "", unknownSlots: [] }, { confirmedFull: true });
  const released = { ...heldItem, state: rel.state, firstCountableAt: at("2026-10-21", "07:30"), heldReleasedAt: at("2026-10-21", "07:30") };
  const c = claim("2026-10-21", { tardies: [released], days: { [TUE]: { date: TUE, frozenAt: at(TUE, "11:46"), freezeKind: "closing", closingReadStartedAt: at(TUE, "11:45") } } });
  check("a pending T is never late: a hold released after 6 lists is listed, tagged Held for attendance",
    rel.state === "countable" && c.claimedTardyIds.includes("h") && c.rows[0].tags.includes("Held for attendance (Tue 10/13 P1)"), J(c.rows[0]?.tags));
}

console.log("\n4.3 LOOKBACK AND SWEEP DATES\n");
{
  const verdicts = (list, v = true) => list.map((d) => ({ date: d, schoolDay: v }));
  const lb = R.lookbackDates({ today: "2026-10-15", n: 5, days: verdicts(["2026-10-07", "2026-10-08", "2026-10-09", "2026-10-12", "2026-10-13", "2026-10-14"]) });
  check("the lookback is the last 5 school days before today", J(lb) === J(["2026-10-08", "2026-10-09", "2026-10-12", "2026-10-13", "2026-10-14"]), J(lb));
  const after = R.lookbackDates({ today: "2026-11-30", n: 5, days: [
    ...verdicts(["2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20"]),
    ...["2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26", "2026-11-27"].map((d) => ({ date: d, schoolDay: false, noSchool: true })),
  ] });
  check("on the first day back from a break, the lookback reaches the day before the break", after.includes("2026-11-20") && after.length === 5, J(after));
  const gap = R.lookbackDates({ today: "2026-10-15", n: 5, days: verdicts(["2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-12"]) });
  check("...plus any weekday since the newest school day with no verdict yet", gap.includes("2026-10-13") && gap.includes("2026-10-14"), J(gap));
  check("...never before countFromDate",
    !R.lookbackDates({ today: "2026-10-15", n: 5, notBefore: "2026-10-12", days: verdicts(["2026-10-08", "2026-10-09", "2026-10-12"]) }).includes("2026-10-09"));
  const sw = R.sweepFrom({ today: "2026-10-30", days: verdicts(["2026-10-16", "2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29"]) });
  check("the after-school sweep reaches the earlier of 10 school days or 30 calendar days back", sw === "2026-09-30", sw);
}

// ===========================================================================
console.log("\n3.8 CARRY-OVER\n");
{
  // Wednesday: every slot meets. P4 (slot 5) is the last class before Power-Up, P5 (slot 6) the first after.
  const wed = (marks, o = {}) => day({ date: WED, meet: o.meet ?? ALL_SLOTS, marked: o.marked ?? Object.values(SECTIONS), marks });
  const v = (d, o = {}) => R.carryVerdict({
    unit: { carryCount: o.carryCount ?? 0 }, studentNumber: S, division: "ms", serveDay: WED,
    room: o.room ?? {}, final: o.final ?? true, summary: d.summary, snap: o.snap === undefined ? snap(S, 7, SECTIONS) : o.snap,
    enrolled: o.enrolled ?? true, maxCarries: 5,
  });
  check("pulled student present in P4 and P5 does not carry", v(wed([[S, 9, "A"]])).verdict === "served");
  check("absent in P4 and at Power-Up: carries", v(wed([[S, 5, "A"], [S, 9, "A"]])).verdict === "carry");
  check("present in P4, absent at Power-Up and in P5: carries", v(wed([[S, 9, "A"], [S, 6, "A"]])).verdict === "carry");
  check("present at Power-Up: served", v(wed([[S, 5, "A"], [S, 6, "A"]])).verdict === "served");
  const absentAll = wed([[S, 1, "A"], [S, 2, "A"], [S, 3, "A"], [S, 4, "A"], [S, 5, "A"], [S, 9, "A"], [S, 6, "A"], [S, 7, "A"], [S, 10, "A"]]);
  check("unticked student absent at Power-Up does not carry",
    v(absentAll, { room: { attendanceDone: true, notHere: false } }).verdict === "served");
  const ticked = v(wed([[S, 9, "A"]]), { room: { attendanceDone: true, notHere: true } });
  check("room attendance done: exactly the ticked rows carry, tagged (absent) when absent at Power-Up",
    ticked.verdict === "carry" && ticked.basis === "room" && ticked.tag === "Carried over from Wed 10/14 (absent)", J(ticked));
  const noShow = v(wed([]), { room: { attendanceDone: true, notHere: true } });
  check("at school but did not come: carries like an absence (owner, 10/8)",
    noShow.verdict === "carry" && noShow.tag === "Carried over from Wed 10/14 (at school: did not come)", J(noShow));
  const closed = v(wed([]), { room: { closed: true }, carryCount: 5 });
  check("room closed: every detention carries, tagged room closed, and it does not count toward the limit",
    closed.verdict === "carry" && closed.tag === "Carried over from Wed 10/14 (room closed)" && closed.countsTowardLimit === false, J(closed));
  const unit = { id: "U", studentNumber: S, division: "ms", kind: "new", state: "listed", recordedAt: at(WED, "11:46"), carryCount: 2, lines: ["x"] };
  check("...so the carried detention keeps its carry count", R.carriedUnit(unit, closed, at(WED, "15:45")).carryCount === 2
    && R.carriedUnit(unit, ticked, at(WED, "15:45")).carryCount === 3);
  // The Power-Up teacher took no attendance: no classmate marked, and no row for S at Power-Up.
  const noPuMarks = Object.values(SECTIONS).filter((s) => s !== "PU-7");
  const absentButPu = [1, 2, 3, 4, 5, 6, 7, 10].map((s) => [S, s, "A"]);
  const wd = v(day({ date: WED, meet: ALL_SLOTS, marked: noPuMarks, marks: absentAll.rows.length ? absentButPu : [] }));
  check("a Power-Up section with no marks uses the whole-day test: absent everywhere carries",
    wd.verdict === "carry" && wd.basis === "whole-day", J(wd));
  const wdPresent = v(day({ date: WED, meet: ALL_SLOTS, marked: noPuMarks, marks: absentButPu.filter(([, s]) => s !== 2) }));
  check("...present in any class that took attendance is served", wdPresent.verdict === "served" && wdPresent.basis === "whole-day", J(wdPresent));
  check("the Power-Up slot did not meet: no carry is decided, it goes to review",
    v(wed([[S, 9, "A"]], { meet: ALL_SLOTS.filter((s) => s !== 9), marked: noPuMarks })).reason === "Power-Up did not meet: was the room run?");
  const noPuSnap = snap(S, 7, Object.fromEntries(Object.entries(SECTIONS).filter(([k]) => k !== "9")));
  check("no Power-Up row: the whole-day test", v(wed([[S, 9, "A"]]), { snap: noPuSnap }).basis === "whole-day");
  check("no enrolment at all: review as attendance unknown", v(wed([[S, 9, "A"]]), { snap: null }).reason === "Attendance unknown at Power-Up");
  check("before the after-school read, with no room attendance, nothing is decided", v(wed([[S, 9, "A"]]), { final: false }).verdict === "undecided");
  check("6th carry goes to review", v(wed([[S, 5, "A"], [S, 9, "A"]]), { carryCount: 5 }).reason === "Carried 5 times");
  check("...the 5th carry still carries", v(wed([[S, 5, "A"], [S, 9, "A"]]), { carryCount: 4 }).verdict === "carry");
  check("a student no longer enrolled goes to review as left school", v(wed([[S, 5, "A"], [S, 9, "A"]]), { enrolled: false }).reason === "Left school");
  check("live mode: a day decided by PowerSchool raises one day-level review item",
    R.fallbackDayReview({ mode: "live", serveDay: TUE, attendanceDone: false, roomClosed: false, decidedByPowerSchool: 7 })?.reason
      === "Room attendance not recorded Tue 10/13 (7 detentions decided from PowerSchool)");
  check("...shadow mode, or a day with room attendance, raises none",
    R.fallbackDayReview({ mode: "shadow", serveDay: TUE, attendanceDone: false, roomClosed: false, decidedByPowerSchool: 7 }) === null
    && R.fallbackDayReview({ mode: "live", serveDay: TUE, attendanceDone: true, roomClosed: false, decidedByPowerSchool: 7 }) === null);
}

console.log("\nOWNER, 10/8: RSP, ELD AND 7002A ARE PULLED LIKE EVERYONE ELSE\n");
{
  const rsp = R.powerUpFrom([{ period: "9(A-E)", sectionId: "RSP1", courseName: "RSP A", teacherFirstName: "Ana", teacherLastName: "Cruz", teacherEmail: "a@x" }]);
  const eld = R.powerUpFrom([{ period: "9(A-E)", sectionId: "E1", courseName: "Designated ELD 3A", teacherFirstName: "Bo", teacherLastName: "Lin" }]);
  const c7002 = R.powerUpFrom([{ period: "8(A-E)", sectionId: "Z1", courseName: "", courseNumber: "7002A", teacherFirstName: "Cy", teacherLastName: "Moe" }]);
  const pu = R.powerUpFrom([{ period: "9(A-E)", sectionId: "P1", courseName: "Power Up 7A", teacherFirstName: "Di", teacherLastName: "Ruiz" }]);
  check("the Power-Up-time row is found by slot, whatever its course is called",
    rsp.puSlot === 9 && eld.puSlot === 9 && c7002.puSlot === 8 && pu.puSlot === 9);
  check("RSP, Designated ELD and 7002A are flagged with the class and teacher they are really in",
    rsp.puFlag === "RSP" && rsp.puCourse === "RSP A" && rsp.puTeacherName === "Ana Cruz"
    && eld.puFlag === "ELD" && c7002.puFlag === "7002A" && c7002.puCourse === "Course 7002A" && pu.puFlag === null);
  const rspSnap = snap(S, 7, { ...SECTIONS, 9: "RSP1" }, { puCourse: "RSP A", puFlag: "RSP", puSectionId: "RSP1" });
  const listed = claim(MON, { tardies: [tardy({ id: "r1", slot: 4 })], divisionOf: { [S]: rspSnap.division } });
  check("an RSP student is on the list like anyone (a slip, not a review item)", listed.rows.length === 1 && listed.unplaced.length === 0);
  const d = day({ date: WED, meet: ALL_SLOTS, marked: [...Object.values(SECTIONS).filter((s) => s !== "PU-7"), "RSP1"],
    roster: { [S]: rspSnap }, marks: [[S, 5, "A"], [S, 9, "A"]] });
  const cv = R.carryVerdict({ unit: { carryCount: 0 }, studentNumber: S, division: "ms", serveDay: WED, room: {}, final: true,
    summary: d.summary, snap: rspSnap, enrolled: true, maxCarries: 5 });
  check("...and carries like anyone when absent", cv.verdict === "carry" && cv.basis === "powerschool", J(cv));
  check("the rules hold no 'serve another way' path any more", !/serveAnotherWay/.test(read("./reflectionRules.ts")));
  const two = R.powerUpFrom([{ period: "9(A-E)", sectionId: "P1", courseName: "Power Up 7A" }, { period: "9(A-E)", sectionId: "P2", courseName: "Power Up 7B" }]);
  check("two Power-Up-time rows: 'Check PowerSchool' rather than a guess", two.puCheck === true);
  check("no Power-Up row at all: nothing invented", R.powerUpFrom([{ period: "2(A-E)", sectionId: "X" }]).puSlot === null);
}

console.log("\n4.5 THE ROSTER SNAPSHOT\n");
{
  const rows = [
    { studentNumber: "1", gradeLevel: "7", period: "1(A-E)", sectionId: "PT", teacherFirstName: "A", teacherLastName: "B" },
    { studentNumber: "1", gradeLevel: "7", period: "2(A-E)", sectionId: "P1", teacherFirstName: "C", teacherLastName: "D" },
    { studentNumber: "1", gradeLevel: "7", period: "9(A-E)", sectionId: "PU", courseName: "Power Up 7A", teacherFirstName: "E", teacherLastName: "F" },
    { studentNumber: "2", gradeLevel: "10", period: "8(A-E)", sectionId: "PUH", courseName: "Power Up 10A" },
  ];
  const snaps = R.rosterSnapshotRows(rows);
  const one = snaps.find((x) => x.studentNumber === "1");
  check("one snapshot row per student, with division, slots, sections and teachers",
    snaps.length === 2 && one.division === "ms" && J(one.enrolledSlots) === J([1, 2, 9]) && one.sectionBySlot["2"] === "P1"
    && one.teacherBySlot["2"] === "C D" && one.puSectionId === "PU" && snaps[1].division === "hs");
  const take = (o) => R.rosterSnapshotVerdict({ syncOk: true, syncedAts: ["s1"], studentCount: 600, previousCount: 607, ...o });
  check("a clean whole roster replaces the snapshot", take({}).take === true);
  check("the snapshot refuses mixed syncedAt", take({ syncedAts: ["s1", "s2"] }).take === false);
  check("the snapshot keeps the old one below 90%", take({ studentCount: 540 }).take === false && take({ studentCount: 547 }).take === true);
  check("...and keeps it when the sync failed or the roster is empty", take({ syncOk: false }).take === false && take({ studentCount: 0 }).take === false);
}

// ===========================================================================
console.log("\n3.10 KEYS AND CORRECTIONS\n");
{
  const cc = (code) => R.codeChangeVerdict(CODES.byId[CODE_ID[code]], ON);
  check("T to D: cleared, now Excused Tardy", cc("D").clear && cc("D").reason === "now Excused Tardy");
  check("T to an Absent-status code: cleared, now Absent", cc("A").reason === "now Absent" && cc("X").reason === "now Absent" && cc("S").reason === "now Absent");
  check("T to K: cleared, now Ditching", cc("K").reason === "now Ditching");
  check("T stays T: nothing changes", cc("T").clear === false);
  check("with countDitching on, T to K still counts", R.codeChangeVerdict(CODES.byId[CODE_ID.K], { countDitching: true }).clear === false);

  const base = day({ marks: [[S, 4, "T"]] });
  const item = { id: "I1", studentNumber: S, attDate: MON, periodId: 854, slot: 4, psRowIds: ["old-id"], state: "countable", firstSeenAt: at(MON, "10:30"), unitId: "U1" };
  const rec = (d, o = {}) => R.reconcileDate({ date: MON, candidates: R.tardyCandidates(d.summary, d.roster, ON), rows: d.rows, codes: CODES,
    items: [item], confirmed: o.confirmed ?? true, fullRead: true, settings: ON });
  const re = rec(base);
  check("a mark deleted and entered again (new id, same key) updates the record, never doubles it",
    re.repoint.length === 1 && re.repoint[0].itemId === "I1" && re.add.filter((a) => a.studentNumber === S).length === 0, J(re));
  const movedRows = base.rows.map((r) => r.studentNumber === S ? { ...r, id: "old-id", periodId: 852 } : r);
  const mv = R.reconcileDate({ date: MON, candidates: R.tardyCandidates(R.summarizeDay(MON, movedRows, CODES, base.roster), base.roster, ON),
    rows: movedRows, codes: CODES, items: [item], confirmed: true, fullRead: true, settings: ON });
  check("the same row id under another period is a move: the key moves and keeps its list assignment",
    mv.move.length === 1 && mv.move[0].toKey === `${S}|${MON}|852` && mv.add.filter((a) => a.studentNumber === S).length === 0 && mv.missing.length === 0, J(mv));
  const two = day({ marks: [[S, 4, "T"], [S, 4, "A"]] });
  check("two marks for one key go to review as a collision", rec(two).collisions.some((c) => c.key === `${S}|${MON}|854`));
  const toD = day({ marks: [[S, 4, "D"]] });
  check("a code change seen on a read applies on any read", rec(toD, { confirmed: false }).codeChange[0]?.reason === "now Excused Tardy");
  const gone = day({ marks: [] });
  check("a key missing from an UNCONFIRMED read is not even a candidate for removal", rec(gone, { confirmed: false }).missing.length === 0);
  check("...from a confirmed read it is a candidate, pending the direct id read", rec(gone).missing[0]?.itemId === "I1");
  const fresh = day({ marks: [[S, 2, "T"]] });
  check("a new key with a counted code is added", rec(fresh).add.some((a) => a.key === `${S}|${MON}|852`));
  const tOnly = R.reconcileDate({ date: MON, candidates: [], rows: fresh.rows.filter((r) => r.codeId === CODE_ID.T), codes: CODES,
    items: [], confirmed: true, fullRead: false, settings: ON });
  check("a new tardy seen only in a T-only read waits for a full confirmed read of its date before it is classified",
    tOnly.add.length === 0 && tOnly.needFullRead.includes(`${S}|${MON}|852`), J(tOnly));
  const toPt = base.rows.map((r) => r.studentNumber === S ? { ...r, id: "old-id", periodId: 851 } : r);
  const mvPt = R.reconcileDate({ date: MON, candidates: R.tardyCandidates(R.summarizeDay(MON, toPt, CODES, base.roster), base.roster, ON),
    rows: toPt, codes: CODES, items: [item], confirmed: true, fullRead: true, settings: ON });
  check("moved to Promise Time AM is not a move: it goes missing, for the direct read to confirm", mvPt.move.length === 0 && mvPt.missing[0]?.itemId === "I1", J(mvPt));

  const rv = (o) => R.removalVerdict({ readKind: "routine", confirmed: true, keyInRead: false, direct: { status: "none" }, item, settings: ON, ...o });
  check("the closing read never clears an item because its row is missing", rv({ readKind: "closing" }).remove === false && rv({ readKind: "late-closing" }).remove === false);
  check("an unconfirmed read never removes", rv({ confirmed: false }).remove === false);
  check("confirmed absence plus a direct read with no row: removed", rv({}).remove === true);
  check("a direct read that failed proves nothing", rv({ direct: { status: "error" } }).remove === false);
  check("a direct read finding the same tardy: kept", rv({ direct: { status: "row", studentNumber: S, attDate: MON, code: "T", periodId: 854 } }).remove === false);
  check("a direct read finding another student or date: removed",
    rv({ direct: { status: "row", studentNumber: "x", attDate: MON, code: "T", periodId: 854 } }).remove === true);
  check("a direct read finding it moved to Promise Time AM: removed",
    rv({ direct: { status: "row", studentNumber: S, attDate: MON, code: "T", periodId: 851 } }).reason === "moved to Promise Time AM");
  const picks = R.pickDirectChecks(Array.from({ length: 60 }, (_, i) => i));
  check("direct id reads are capped at 50 per read; the rest wait", picks.now.length === 50 && picks.later.length === 10);

  const arrival = { verdict: "arrival", reason: "", unknownSlots: [] };
  const counted = { verdict: "counted", reason: "", unknownSlots: [] };
  check("only a confirmed full read may reclassify", R.reclassify({ ...item, state: "countable" }, arrival, { confirmedFull: false }).changed === false);
  const after = R.reclassify({ ...item, state: "countable" }, arrival, { confirmedFull: true });
  check("an arrival found after the list was made: the list is not rewritten, the item is marked",
    after.state === "arrival" && after.afterList === true);
  const nowCounts = R.reclassify({ ...item, unitId: null, state: "arrival" }, counted, { confirmedFull: true });
  check("a tardy that becomes countable goes pending for the next list", nowCounts.state === "countable" && nowCounts.afterList === false);
  check("cleared, before-start and review items are never reclassified",
    ["cleared", "before-start", "review"].every((st) => R.reclassify({ ...item, state: st }, counted, { confirmedFull: true }).changed === false));
  check("every violation cleared releases the detention", R.unitReleased([{ cleared: true }, { cleared: true }]) && !R.unitReleased([{ cleared: true }, { cleared: false }]));
}

// ===========================================================================
console.log("\nTHE LAST-READ BANNER, AND A TARDY BACK AFTER ITS RELEASE\n");
{
  const banner = (hhmm, last, err) => R.lastReadBanner({ nowIso: at(TUE, hhmm), tz: TZ, date: TUE, closeMinute: 705,
    lastGoodReadAt: last ? at(TUE, last) : null, lastReadErrorAt: err ? at(TUE, err) : null });
  check("between scheduled reads it is information, with the next read: 12:35 after the 11:45 closing read",
    J(banner("12:35", "11:45")) === J({ level: "info", text: "Last good PowerSchool read 11:45. Next read 1:00." }), J(banner("12:35", "11:45")));
  check("...and 10:50, an hour-long gap that is the schedule's own, is not red", banner("10:50", "10:30").level === "info");
  check("a scheduled read more than 15 minutes overdue is red: the 1:00 read never ran by 1:20",
    J(banner("13:20", "11:45")) === J({ level: "alert", text: "Last good PowerSchool read 11:45: the 1:00 read is overdue." }), J(banner("13:20", "11:45")));
  check("a read that failed after the last good one is red at once",
    J(banner("13:02", "11:45", "13:01")) === J({ level: "alert", text: "Last good PowerSchool read 11:45: the latest read failed." }));
  check("no read yet at 07:40 is not an alarm; still none at 07:50 is",
    banner("07:40").level === "info" && J(banner("07:50")) === J({ level: "alert", text: "No PowerSchool read has worked yet today." }));
  check("outside school hours there is no banner", banner("06:30") === null && banner("16:30") === null);

  const pull = R.pullInstant(TUE, "regular", "ms", ON, TZ);
  check("a tardy back after its detention was released AFTER the pull rejoins it; released before the pull, it does not",
    pull === at(TUE, "12:31") && R.pullInstant(TUE, "regular", "hs", ON, TZ) === at(TUE, "12:57")
      && R.rejoinsReleasedDetention({ releasedAt: at(TUE, "13:00"), pullAt: pull })
      && !R.rejoinsReleasedDetention({ releasedAt: at(TUE, "12:10"), pullAt: pull }));
}

// ===========================================================================
console.log("\nSETTINGS\n");
{
  const d = R.reflectionSettingsOrDefault(undefined);
  check("the repo default is OFF for both divisions", d.modeByDivision.ms === "off" && d.modeByDivision.hs === "off");
  check("defaults: 5 lists late, 5 carries, no ditching, no Power-Up tardies",
    d.lateEntryLists === 5 && d.maxCarries === 5 && !d.countDitching && !d.countPowerUpTardies && d.lastFreezeMarginMin === 10);
  const bad = R.reflectionSettingsOrDefault({ closeMinuteByKind: { regular: 707, wed: 690, stack: 715, minimum: 670 } });
  check("close minutes must be whole 5-minute steps that leave a closing read room before ready",
    bad.closeMinuteByKind.regular === 705 && bad.closeMinuteByKind.wed === 680 && bad.closeMinuteByKind.stack === 715 && bad.closeMinuteByKind.minimum === 670,
    J(bad.closeMinuteByKind));
  check("an unknown mode reads as off", R.reflectionSettingsOrDefault({ modeByDivision: { ms: "on", hs: "live" } }).modeByDivision.ms === "off");
}

console.log("\nWIRING\n");
{
  const pkg = JSON.parse(read("../package.json"));
  check("this test, and the teeth that break its guards, run in npm test",
    /node convex\/reflectionRules\.test\.mjs/.test(pkg.scripts.test) && /node scripts\/reflection-teeth\.mjs/.test(pkg.scripts.test));
  check("the rules import nothing but the school clock",
    (read("./reflectionRules.ts").match(/^import .*$/gm) || []).join("\n") === 'import { localSchoolTime } from "./scheduleRules";');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) process.exit(1);
