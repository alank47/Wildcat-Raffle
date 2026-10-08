// A fake PowerSchool, for running the SHIPPED attendance rebuild in tests.
//
// WHY IT HONOURS EVERY FILTER (2026-10-02). The rebuild now reads the year in
// month pieces and proves them against PowerSchool's own count. A fake that
// ignored `q` -- the one excused-tardy.test.mjs used to have -- would hand
// every piece the whole table, and nothing about the proof could be tested.
// So every clause is applied, a clause naming a field the fixture row does
// not have THROWS (a fixture cannot silently ignore a filter), and a blank or
// missing value is SQL NULL: it matches no ==, ge or le clause, so a row with
// no date is counted by the year query and by no dated piece -- exactly what
// the real thing would do.
//
// It serves:
//   POST /oauth/access_token
//   GET  /ws/schema/table/<table>?q=&projection=&pagesize=&page=
//   GET  /ws/schema/table/<table>/count?q=
// and records every request, and the most it ever had in flight at once.
//
// Options, each a way PowerSchool could misbehave:
//   leExclusive        `le` behaves like `<`, so month-end rows fall out
//   ignoreDateFilter   table reads ignore att_date clauses (counts honour them)
//   shuffle            rows come back in a different (seeded) order
//   insertDuringRead   { row, afterPage, match(q), times: "once" | "always" }
//                      a teacher entering attendance while a piece is read
//   failCountWith500   number of /count requests to answer HTTP 500
//   failWindowWith500  { match(q), times } table reads answering HTTP 500
//   slowMs             delay before every answer
//   swapFieldInWindows { id, field, value } a dated read sees a different value
//   nullDateRow        add a this-year row whose att_date is blank
//   dropFromSingleRead id: an undated read of the year skips this row (the
//                      old single read coming back short)
//   insertAfterYearCount { row, after: [k, ...] } a teacher's entry landing
//                      just after PowerSchool answers the k-th count of the
//                      whole year (the undated count), never during a read
//   hang               { match(q), page } that table read never answers; it
//                      ends only when the request's own signal aborts it
//   swapDuringRead     { row, afterPage, match(q), times: "once" | "always" }
//                      one teacher save mid-read: the first row that page
//                      served is DELETED and `row` is inserted, so both counts
//                      stay the same and the next page shifts by one. With no
//                      `row`, the delete alone: matched to the old single read,
//                      a delete while it pages (or, after its last page, just
//                      after it)
//   insertBeforeSingleRead row: entered just before the first page of an
//                      undated read of the year (between the pieces and the
//                      comparison's old single read)
//   editBeforeSingleRead { id, field, value } the same moment: an office
//                      correction, e.g. an absence excused or re-dated
//   deleteBeforeSingleRead id, or a list of ids: the same moment, deleted
//   unstablePaging     { match(q) } every page of a matching table read comes
//                      from a different order of the rows
//   hideFromDated      id, or a list of ids: every read AND count carrying an
//                      att_date clause leaves this dated row out, so the
//                      pieces' dated count agrees with them and they take it
//                      for a row with no date (undatedRows); an undated read
//                      or count still has it
//   editBeforeRecheck  { id, field, value } an office correction landing
//                      after the comparison's old single read, just before
//                      its first by-id re-read (a table read with id==)
//
// And three ways an office or a teacher changes a mark BETWEEN reads, for the
// Reflection Room reader (2026-10-08), each a method on the fake:
//   changeCode(id, codeId)  a mark's code changes in place (T to D, say)
//   reenter(id)             a mark deleted and entered again: same student,
//                           date and period, a NEW row id (returned)
//   movePeriod(id, periodid) the same row id, now under another period
// plus reflectionDay(), a school day built from slots and sections (below).

const NULL = (x) => x === null || x === undefined || x === "";

function parseQuery(q) {
  if (!q) return [];
  return q.split(";").filter(Boolean).map((c) => {
    const m = /^(\w+)(==|=ge=|=le=)(.*)$/.exec(c);
    if (!m) throw new Error(`the fake PowerSchool cannot parse the clause "${c}"`);
    return { field: m[1].toLowerCase(), op: m[2], value: m[3] };
  });
}

function compare(field, a, b) {
  if (field === "att_date") {
    const x = String(a).slice(0, 10), y = String(b).slice(0, 10);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  const na = Number(a), nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

function seeded(seed) {
  let s = seed >>> 0 || 1;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

export function fakePowerSchool(tablesIn, opts = {}) {
  const tables = {};
  for (const [k, rows] of Object.entries(tablesIn)) tables[k] = rows.map((r) => ({ ...r }));
  if (opts.nullDateRow) {
    tables.attendance.push({ ...tables.attendance[0], id: 990001, att_date: "" });
  }
  const log = [];
  let inFlight = 0, maxInFlight = 0, nextId = 900000;
  let countFails = Number(opts.failCountWith500) || 0;
  let windowFails = opts.failWindowWith500 ? Number(opts.failWindowWith500.times ?? Infinity) : 0;
  let inserted = 0;
  let yearCounts = 0;
  let swaps = 0;
  let requests = 0;
  let singleInserted = false;
  let recheckEdited = false;
  const deleted = [];
  const hidden = opts.hideFromDated === undefined ? null : new Set([].concat(opts.hideFromDated).map(String));

  const matches = (row, clauses, table, forCount) => !(hidden && table === "attendance" && hidden.has(String(row.id))
    && clauses.some((c) => c.field === "att_date")) && clauses.every(({ field, op, value }) => {
    if (!(field in row)) {
      throw new Error(`the fake PowerSchool was asked to filter ${table} on "${field}", which the fixture row lacks`);
    }
    if (field === "att_date" && opts.ignoreDateFilter && !forCount) return true;
    const x = row[field];
    if (NULL(x)) return false;
    if (op === "==") return String(x) === value;
    const c = compare(field, x, value);
    if (op === "=ge=") return c >= 0;
    if (field === "att_date" && opts.leExclusive) return c < 0;
    return c <= 0;
  });

  const resp = (status, body, headers) => ({
    ok: status >= 200 && status < 300, status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: { get: (k) => (headers && headers[String(k).toLowerCase()]) ?? null },
  });

  const fetch = async (url, init) => {
    const u = new URL(url);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const entry = { path: u.pathname, q: u.searchParams.get("q"), page: Number(u.searchParams.get("page")) || null,
      started: Date.now(), at: log.length };
    log.push(entry);
    try {
      if (opts.slowMs) await new Promise((r) => setTimeout(r, opts.slowMs));
      else await new Promise((r) => setImmediate(r));
      if (u.pathname === "/oauth/access_token") { entry.kind = "token"; return resp(200, { access_token: "tok" }); }
      const count = /^\/ws\/schema\/table\/(\w+)\/count$/.exec(u.pathname);
      const read = /^\/ws\/schema\/table\/(\w+)$/.exec(u.pathname);
      const table = (count || read || [])[1];
      if (!table || !tables[table]) throw new Error("the fake PowerSchool has no " + u.pathname);
      entry.table = table;
      const clauses = parseQuery(entry.q);
      if (count) {
        entry.kind = "count";
        if (countFails > 0) { countFails--; return resp(500, { message: "count failed" }); }
        const n = tables[table].filter((r) => matches(r, clauses, table, true)).length;
        const iy = opts.insertAfterYearCount;
        if (iy && table === "attendance" && !/att_date=/.test(entry.q || "")) {
          yearCounts++;
          if (iy.after.includes(yearCounts)) { inserted++; tables.attendance.push({ ...iy.row, id: nextId++ }); }
        }
        return resp(200, { count: n });
      }
      entry.kind = "table";
      const hang = opts.hang;
      if (hang && table === "attendance" && hang.match(entry.q || "")
          && (hang.page === undefined || Number(u.searchParams.get("page")) === hang.page)) {
        entry.hung = true;
        await new Promise((_, reject) => {
          const sig = init && init.signal;
          if (!sig) return;   // no signal: it never settles, as a dead connection would not
          if (sig.aborted) { reject(sig.reason); return; }
          sig.addEventListener("abort", () => reject(sig.reason), { once: true });
        });
      }
      if (windowFails > 0 && opts.failWindowWith500.match(entry.q || "")) {
        windowFails--;
        return resp(500, { message: "read failed" });
      }
      const size = Number(u.searchParams.get("pagesize")), page = Number(u.searchParams.get("page"));
      requests++;
      const beforeSingle = opts.insertBeforeSingleRead || opts.editBeforeSingleRead || opts.deleteBeforeSingleRead !== undefined;
      if (beforeSingle && table === "attendance" && page === 1 && !/att_date=/.test(entry.q || "") && !singleInserted) {
        singleInserted = true;
        if (opts.insertBeforeSingleRead) {
          inserted++;
          tables.attendance.push({ ...opts.insertBeforeSingleRead, id: nextId++ });
        }
        const ed = opts.editBeforeSingleRead;
        if (ed) {
          const at = tables.attendance.findIndex((r) => String(r.id) === String(ed.id));
          if (at >= 0) tables.attendance[at] = { ...tables.attendance[at], [ed.field]: ed.value };
        }
        for (const id of opts.deleteBeforeSingleRead === undefined ? [] : [].concat(opts.deleteBeforeSingleRead)) {
          const at = tables.attendance.findIndex((r) => String(r.id) === String(id));
          if (at >= 0) deleted.push(tables.attendance.splice(at, 1)[0]);
        }
      }
      const er = opts.editBeforeRecheck;
      if (er && table === "attendance" && /(^|;)id==/.test(entry.q || "") && !recheckEdited) {
        recheckEdited = true;
        const at = tables.attendance.findIndex((r) => String(r.id) === String(er.id));
        if (at >= 0) tables.attendance[at] = { ...tables.attendance[at], [er.field]: er.value };
      }
      let rows = tables[table].filter((r) => matches(r, clauses, table, false));
      if (opts.dropFromSingleRead !== undefined && table === "attendance" && !/att_date=/.test(entry.q || "")) {
        rows = rows.filter((r) => String(r.id) !== String(opts.dropFromSingleRead));
      }
      if (opts.shuffle) {
        const rnd = seeded(typeof opts.shuffle === "number" ? opts.shuffle : 7);
        rows = rows.map((r) => [rnd(), r]).sort((a, b) => a[0] - b[0]).map((p) => p[1]);
      }
      if (opts.unstablePaging && table === "attendance" && opts.unstablePaging.match(entry.q || "")) {
        const rnd = seeded(1000 + requests);
        rows = rows.map((r) => [rnd(), r]).sort((a, b) => a[0] - b[0]).map((p) => p[1]);
      }
      const projection = (u.searchParams.get("projection") || "").split(",").map((f) => f.trim().toLowerCase()).filter(Boolean);
      const swap = opts.swapFieldInWindows;
      const served = rows.slice((page - 1) * size, page * size).map((r) => {
        let row = r;
        if (swap && table === "attendance" && /att_date=/.test(entry.q || "") && String(r.id) === String(swap.id)) {
          row = { ...r, [swap.field]: swap.value };
        }
        const out = {};
        for (const f of projection.length ? projection : Object.keys(row)) if (f in row) out[f] = row[f];
        return { tables: { [table]: out } };
      });
      entry.served = served.length;
      entry.ids = served.map((r) => r.tables[table].id).filter((x) => x !== undefined).map(String);
      const ins = opts.insertDuringRead;
      if (ins && table === "attendance" && page === (ins.afterPage || 1) && ins.match(entry.q || "")
          && (ins.times === "always" || inserted === 0)) {
        inserted++;
        tables.attendance.push({ ...ins.row, id: nextId++ });
      }
      const sw = opts.swapDuringRead;
      if (sw && table === "attendance" && page === (sw.afterPage || 1) && sw.match(entry.q || "") && served.length
          && (sw.times === "always" || swaps === 0)) {
        swaps++;
        const gone = String(served[0].tables[table].id);
        const at = tables.attendance.findIndex((r) => String(r.id) === gone);
        if (at >= 0) deleted.push(tables.attendance.splice(at, 1)[0]);
        if (sw.row) tables.attendance.push({ ...sw.row, id: nextId++ });
      }
      return resp(200, { record: served });
    } finally {
      entry.finished = Date.now();
      inFlight--;
    }
  };
  const rowOf = (id) => {
    const r = tables.attendance.find((x) => String(x.id) === String(id));
    if (!r) throw new Error(`the fake PowerSchool has no attendance row ${id}`);
    return r;
  };
  return {
    fetch, log, tables,
    get maxInFlight() { return maxInFlight; },
    get inserted() { return inserted; },
    get swaps() { return swaps; },
    deleted,
    changeCode(id, codeId) { rowOf(id).attendance_codeid = codeId; },
    reenter(id) {
      const at = tables.attendance.indexOf(rowOf(id));
      const old = tables.attendance.splice(at, 1)[0];
      deleted.push(old);
      const fresh = { ...old, id: nextId++ };
      tables.attendance.push(fresh);
      return fresh.id;
    },
    movePeriod(id, periodid) { rowOf(id).periodid = periodid; },
  };
}

// ---------------------------------------------------------------------------
// A SCHOOL DAY FOR THE REFLECTION ROOM TESTS (2026-10-08).
//
// The list's rules turn on two counts PowerSchool does not hand over
// directly: whether a SLOT MET today (at least 10 rows of any code in it)
// and whether a student's own SECTION has any marks yet (a teacher who has
// not taken attendance leaves every student in the section with "no row").
// This builds a day where both are chosen on purpose:
//   meet          slots given 10 filler rows (code A, filler students in
//                 section FILL-<slot>), so the slot meets school-wide
//   sectionMarks  section ids given one classmate row (code A), so the
//                 section has marks; a section not listed has none unless a
//                 student under test has a row in it
//   marks         [{ sn, slot, code, date? }] the rows under test
//   futureRows    rows per slot (1, 2, 4, 6, 9, 10) dated the next day, code
//                 X: PowerSchool's absences entered ahead of time
// Students: [{ sn, grade, sections: { slot: sectionId }, teachers?, courses? }].
// Returns PowerSchool's tables (attendance, attendance_code, students), the
// matching psRoster rows (period "8(A-E)" etc.), the code ids by letter,
// and PowerSchool's internal student id for each student number.
// ---------------------------------------------------------------------------
export const REFLECTION_CODES = [
  { id: 1, att_code: "A", description: "Absent", presence_status_cd: "Absent" },
  { id: 2, att_code: "T", description: "Tardy", presence_status_cd: "Present" },
  { id: 3, att_code: "D", description: "Excused Tardy", presence_status_cd: "Present" },
  { id: 4, att_code: "K", description: "Ditching", presence_status_cd: "Present" },
  { id: 5, att_code: "", description: "Present", presence_status_cd: "Present" },
  { id: 6, att_code: "S", description: "Suspended", presence_status_cd: "Absent" },
  { id: 7, att_code: "X", description: "Excused Absence", presence_status_cd: "Absent" },
];

export function reflectionDay({
  date, schoolid = "1817", yearid = "36", students = [], marks = [], meet = [], sectionMarks = [], futureRows = 0,
} = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw new Error("reflectionDay needs a YYYY-MM-DD date");
  const codeId = Object.fromEntries(REFLECTION_CODES.map((c) => [c.att_code || "P", c.id]));
  const attendance = [], studentsTable = [], psRoster = [];
  const psIdOf = {};
  let rowId = 5000, psId = 70000;
  const addStudent = ({ sn, grade = 7, sections = {}, teachers = {}, courses = {} }) => {
    if (psIdOf[sn]) return;
    psIdOf[sn] = ++psId;
    studentsTable.push({ id: psIdOf[sn], student_number: sn, schoolid });
    for (const [slot, sectionId] of Object.entries(sections)) {
      const [first, last] = String(teachers[slot] ?? `Teacher ${sectionId}`).split(" ");
      psRoster.push({
        studentNumber: sn, gradeLevel: String(grade), period: `${slot}(A-E)`, sectionId,
        courseName: courses[slot] ?? `Course ${sectionId}`, teacherFirstName: first, teacherLastName: last ?? "",
        teacherEmail: `${String(sectionId).toLowerCase()}@school.test`, syncedAt: "2026-10-08T13:00:00Z",
      });
    }
  };
  const addRow = (sn, slot, code, onDate = date) => {
    const id = ++rowId;
    attendance.push({
      id, schoolid, yearid, studentid: psIdOf[sn], att_date: onDate, periodid: 850 + Number(slot),
      attendance_codeid: codeId[code], ccid: 0,
    });
    return id;
  };
  for (const s of students) addStudent(s);
  for (const slot of meet) {
    for (let i = 0; i < 10; i++) {
      const sn = `F${slot}-${i}`;
      addStudent({ sn, sections: { [slot]: `FILL-${slot}` } });
      addRow(sn, slot, "A");
    }
  }
  for (const sectionId of sectionMarks) {
    const owner = psRoster.find((r) => r.sectionId === sectionId);
    if (!owner) throw new Error(`reflectionDay: no student is enrolled in section ${sectionId}`);
    const slot = Number(owner.period.split("(")[0]);
    const sn = `C-${sectionId}`;
    addStudent({ sn, sections: { [slot]: sectionId } });
    addRow(sn, slot, "A");
  }
  const ids = marks.map((m) => addRow(m.sn, m.slot, m.code, m.date ?? date));
  const next = new Date(Date.parse(date + "T00:00:00Z") + 86400000).toISOString().slice(0, 10);
  for (const slot of futureRows ? [1, 2, 4, 6, 9, 10] : []) {
    for (let i = 0; i < futureRows; i++) {
      const sn = `X${slot}-${i}`;
      addStudent({ sn, sections: { [slot]: `FUT-${slot}` } });
      addRow(sn, slot, "X", next);
    }
  }
  const codes = REFLECTION_CODES.map((c) => ({ ...c, schoolid, yearid }));
  const rowCountBySlot = {};
  for (const r of attendance) if (r.att_date === date) rowCountBySlot[r.periodid - 850] = (rowCountBySlot[r.periodid - 850] ?? 0) + 1;
  return {
    tables: { attendance, attendance_code: codes, students: studentsTable },
    psRoster, codeId, psIdOf, markIds: ids, rowCountBySlot,
  };
}
