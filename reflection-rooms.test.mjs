// ROOM NUMBERS ON THE REFLECTION ROOM LIST (owner, 2026-10-13). Run: npm test
//
// "Can we add room numbers to the reflection room list? or is that not in
// PowerSchool". It is in PowerSchool (Sections.Room), but plugin 1.4.2 does
// not ask for it and PowerSchool answers 403. The owner chose both:
//
//   NOW    an administrator types each teacher's room (teachers.room), on Edit
//          Teacher or the Classrooms list on the Teachers tab;
//   LATER  once an administrator installs plugin 1.4.3, the sync stores each
//          section's own room (psRoster.sectionRoom) and the list prefers it.
//
// WHAT COULD GO QUIETLY WRONG, each a list that still looks fine:
//
//   1. SOMEONE BUT AN ADMIN SETS A ROOM. A room decides which door a runner
//      knocks on with a child's name. Only admin and superadmin, on the role
//      stored on their own record -- a teacher, PBIS, an aide holding the
//      list grant are refused, their own room included.
//   2. THE WRONG CLASS'S ROOM. MS is pulled from the class before lunch, which
//      is P3 on Mon/Thu and P4 on Tue/Fri, Wednesday, Minimum and Stack days;
//      HS from Power-Up. The Power-Up room on an MS row, or Monday's period
//      on a Tuesday, sends the runner to the wrong room.
//   3. THE TEACHER'S ROOM WHERE POWERSCHOOL KNOWS BETTER, or a room where the
//      list itself says "check PowerSchool" (two classes in the period, two
//      Power-Up classes): never a guess, a dash.
//   4. THE SYNC FAILS ON THE 403. Today's answer to the room read is a 403.
//      The sync must finish exactly as it did, roster and all.
//   5. A ROOM CHANGED AFTER THE LIST IS MADE CHANGES IT. The list on paper
//      and the list on screen must agree: a made list shows the room copied
//      when it was made.
//   6. AN OPEN TAB FROM BEFORE BREAKS. The rooms are additive fields; the
//      screen open tabs run today (492e557) must draw and print the list as
//      it always did.
//   7. ANOTHER RECORD'S ROOM. A renamed teacher's PowerSchool address can be
//      another staff member's own; when that owner has no room, the class is
//      a dash -- on the real list and the TEST list alike -- never the
//      renamed teacher's room.
//
// IT RUNS THE SHIPPED CODE: roomRules, the sync (sisAction), the staff
// mutation (staffInvites), the reader, tick and freeze, listForDay, the TEST
// list builder, and the Reflection Room screen out of script.js.
//
// TEETH: scripts/reflection-teeth.mjs breaks the admin check, the class-
// before-lunch choice, PowerSchool's preference, the sync's tolerance of a
// 403, the copy made at the freeze, the slips' room order and the screen's
// column, one at a time, and requires the check named for each to FAIL.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { clock, loadConvex, makeDb, runtime } from "./fake-convex.mjs";
import { fakePowerSchool, reflectionDay } from "./fake-powerschool.mjs";
import { lift, makeWorld } from "./fake-reflection-screen.mjs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const schemaSrc = read("./convex/schema.ts");
const scriptSrc = read("./script.js");

let pass = 0, fail = 0;
const check = (n, c, why) => {
  c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${why ? "  (" + why + ")" : ""}`));
};
const J = (x) => JSON.stringify(x);

// The reader, the build and the sync log a line of counts each; keep the output readable.
const realLog = console.log;
console.log = (...a) => { if (!(typeof a[0] === "string" && /^\[(reflection|staffRoom)/.test(a[0]))) realLog(...a); };

const loaded = await loadConvex(new URL("./", import.meta.url), [
  "roomRules", "reflectionRules", "reflection", "reflectionRead", "reflectionList", "reflectionDemo", "reflectionDemoStore",
  "reflectionDemoRules", "staffInvites", "sisAction", "psSync", "syncLog", "appDataShape",
], {
  transform: (name, src) => (name === "attendanceDays" ? src.replace("const RETRY_PAUSE_MS = 1000;", "const RETRY_PAUSE_MS = 1;") : src),
});
const { mods } = loaded;
const RM = mods.roomRules;
const R = mods.reflectionRules;

const TZ = "America/Los_Angeles";
const SCHOOL = "1817", YEAR = "36";
const MON = "2026-10-12", TUE = "2026-10-13", WED = "2026-10-14", THU = "2026-10-15", FRI = "2026-10-16";
const FIVE = 5 * 60 * 1000;
Object.assign(process.env, {
  PS_HOST: "ps.test", PS_CLIENT_ID: "id", PS_CLIENT_SECRET: "secret", PS_SCHOOL_ID: SCHOOL, PS_YEAR_ID: YEAR, PS_TERM_ID: "3601",
  PS_YEAR_TERM_ID: "3600", PS_FINAL_GRADE_NAME: "S1", PS_STORE_CODE: "S1",
  STAFF_DOMAIN: "school.test", ENTRA_TENANT_ID: "tenant-1",
});
const ISSUER = "https://login.microsoftonline.com/tenant-1/v2.0";
const la = (date, hhmm) => { const [h, m] = hhmm.split(":").map(Number); return R.laWallToUtc(date, h * 60 + m, TZ); };

try {
  // ==========================================================================
  console.log("\n1. WHAT A ROOM MAY BE, AND WHOSE IT IS\n");
  // ==========================================================================
  {
    check("a room is shown as typed, spaces tidied; blank is no room",
      RM.cleanRoom("  Room   214 ") === "Room 214" && RM.cleanRoom("") === null && RM.cleanRoom("   ") === null
        && RM.cleanRoom(null) === null && RM.cleanRoom(214) === "214" && RM.cleanRoom({ room: 1 }) === null);
    const v = (actorRole, requested, current = null) => RM.staffRoomVerdict({ actorRole, current, requested });
    check("an admin or a superadmin may set a room",
      J(v("admin", "214")) === J({ ok: true, room: "214", changed: true }) && v("superadmin", "B-12").ok === true
        && v(" Admin ", "Library").ok === true, J(v("admin", "214")));
    check("nobody else: a teacher, PBIS, a campus aide, an unknown or missing role are refused",
      ["teacher", "pbis", "campusaide", "", null, undefined, "administrator"].every((r) => v(r, "214").ok === false
        && v(r, "214").reason === RM.ROOM_REFUSED));
    check("blank clears it; the same room again is no change, and not an error",
      J(v("admin", "  ", "214")) === J({ ok: true, room: null, changed: true })
        && J(v("admin", " 214 ", "214")) === J({ ok: true, room: "214", changed: false }));
    check("a typed room is short and plain: too long, markup, or not text is refused",
      v("admin", "x".repeat(RM.ROOM_MAX + 1)).ok === false && v("admin", "x".repeat(RM.ROOM_MAX)).ok === true
        && v("admin", "<b>214</b>").ok === false && v("admin", "214\"").ok === false && v("admin", 214).ok === false
        && v("admin", "Room 214 (A)").ok === true && v("admin", "B-12/13").ok === true);
    const map = RM.roomByTeacherEmail([
      { email: "Ortiz@School.test", room: "104" },
      { email: "new.name@school.test", psEmail: "old.name@school.test", room: "777" },
      { email: "nobody@school.test", room: "  " },
      { email: "clash@school.test", room: "1" }, { email: "other@school.test", psEmail: "clash@school.test", room: "2" },
    ]);
    check("a teacher's room is found by their email, and by the address PowerSchool files a renamed teacher's classes under",
      map["ortiz@school.test"] === "104" && map["new.name@school.test"] === "777" && map["old.name@school.test"] === "777"
        && !("nobody@school.test" in map), J(map));
    check("...a record's own email wins over another record's PowerSchool address", map["clash@school.test"] === "1", J(map));
    const roomless = RM.roomByTeacherEmail([
      { email: "owner@school.test", room: null }, { email: "renamed@school.test", psEmail: "owner@school.test", room: "214" },
    ]);
    check("...even when that record has no room: its owner shows a dash, never the other record's room",
      !("owner@school.test" in roomless) && roomless["renamed@school.test"] === "214", J(roomless));
    check("PowerSchool's answer to the room read: 403 is not granted (today), 2xx granted, anything else an error",
      RM.sectionRoomStatus(403) === "not-granted" && RM.sectionRoomStatus(200) === "granted"
        && [400, 404, 500, 503, 0].every((s) => RM.sectionRoomStatus(s) === "error"));
    check("rooms are taken by section id, a blank room left out",
      J(RM.sectionRoomsFromRecords([{ tables: { sections: { id: 11, room: " 214 " } } }, { tables: { sections: { id: 12, room: "" } } },
        { id: "13", room: "B-12" }, { tables: { sections: { room: "9" } } }, null])) === J({ 11: "214", 13: "B-12" }));
    check("the read asks for this term's sections, their id and room, and nothing else",
      J(RM.sectionRoomsQuery({ schoolid: SCHOOL, termid: "3601" })) === J({ q: "schoolid==1817;termid==3601", projection: "id,room" }));
    check("roomRules imports nothing, so the sync's own harness can load it as it is",
      !/^import /m.test(read("./convex/roomRules.ts")));
  }

  // ==========================================================================
  console.log("\n1b. THE TEST LIST'S ROOMS ARE THE REAL LIST'S\n");
  // ==========================================================================
  // The real list reads one staff record per address it names
  // (reflection.teacherRoomsFor: the address's owner by email, else the
  // oldest record with it as psEmail). The TEST list runs roomByTeacherEmail
  // over the whole staff table. An address's room must be that one record's,
  // room or no room, however many other addresses are looked up beside it --
  // or a TEST list, or a list that happens to name both teachers, shows a
  // room the address's own record does not have.
  {
    const store = makeDb(schemaSrc);
    const staff = [
      { email: "owner@school.test", name: "Owner, no room" },
      { email: "renamed@school.test", psEmail: "owner@school.test", room: "214" },
      { email: "has@school.test", room: "105" }, { email: "renamed2@school.test", psEmail: "has@school.test", room: "215" },
      { email: "first@school.test", psEmail: "old@school.test" }, { email: "second@school.test", psEmail: "old@school.test", room: "216" },
      { email: "plain@school.test", room: "B-12" }, { email: "self@school.test", psEmail: "self@school.test", room: "9" },
    ];
    for (const t of staff) await store.db.insert("teachers", { name: "Staff", ticketsAwarded: 0, ...t });
    const addresses = [...new Set(staff.flatMap((t) => [t.email, t.psEmail]).filter(Boolean)), "nobody@school.test"];
    const ctx = { db: store.db };
    const alone = {};
    for (const a of addresses) alone[a] = (await mods.reflection.teacherRoomsFor(ctx, [a]))[a] ?? null;
    const together = await mods.reflection.teacherRoomsFor(ctx, addresses);
    const whole = RM.roomByTeacherEmail(store.rows("teachers"));
    check("every address gets its own record's room, looked up alone, beside every other address, or from the whole staff table (the TEST list): owner with no room, two records sharing a PowerSchool address, and the rest",
      addresses.every((a) => (whole[a] ?? null) === alone[a] && (together[a] ?? null) === alone[a])
        && alone["owner@school.test"] === null && alone["renamed@school.test"] === "214" && alone["has@school.test"] === "105"
        && alone["old@school.test"] === null && alone["plain@school.test"] === "B-12" && alone["self@school.test"] === "9",
      J({ alone, together, whole }));
  }

  // ==========================================================================
  console.log("\n2. WHICH CLASS'S ROOM, ON EVERY KIND OF DAY\n");
  // ==========================================================================
  {
    // One MS student, one HS student, as the sync writes psRoster: P3 (slot 4)
    // Ms Ortiz, P4 (slot 5) Ms Park whose section PowerSchool rooms in PS-205,
    // Power-Up (slot 9) Ms Ruiz. HS Power-Up (slot 8) Ms Cruz, PowerSchool
    // room PS-310.
    const row = (sn, grade, slot, sectionId, email, sectionRoom) => ({
      studentNumber: sn, gradeLevel: String(grade), period: `${slot}(A-E)`, sectionId, courseName: slot >= 8 ? "Power Up" : "Class",
      teacherFirstName: "Ms", teacherLastName: email.split("@")[0], teacherEmail: email, ...(sectionRoom ? { sectionRoom } : {}),
    });
    const psRoster = [
      row("M", 7, 1, "PT-A", "adams@school.test"), row("M", 7, 4, "P3-A", "ortiz@school.test"),
      row("M", 7, 5, "P4-A", "park@school.test", "PS-205"), row("M", 7, 9, "PU-7", "ruiz@school.test"),
      row("H", 10, 4, "P3-H", "ng@school.test"), row("H", 10, 5, "P4-H", "kim@school.test"), row("H", 10, 8, "PU-10", "cruz@school.test", "PS-310"),
      row("H2", 11, 8, "PU-11", "lee@school.test"),
      // Two classes in P3 for M2: the list says check PowerSchool, so no room.
      row("M2", 7, 4, "P3-A", "ortiz@school.test"), row("M2", 7, 4, "P3-B", "bell@school.test"), row("M2", 7, 5, "P4-A", "park@school.test", "PS-205"),
      // Two Power-Up classes for H3.
      row("H3", 9, 8, "PU-10", "cruz@school.test", "PS-310"), row("H3", 9, 8, "PU-12", "diaz@school.test"),
      // A renamed teacher: PowerSchool still files P3-R under the old address.
      row("M3", 6, 4, "P3-R", "old.name@school.test"),
    ];
    const snaps = Object.fromEntries(R.rosterSnapshotRows(psRoster).map((s) => [s.studentNumber, s]));
    const rooms = RM.roomByTeacherEmail([
      { email: "ortiz@school.test", room: "104" }, { email: "park@school.test", room: "105" }, { email: "ruiz@school.test", room: "109" },
      { email: "cruz@school.test", room: "110" }, { email: "lee@school.test", room: "111" }, { email: "bell@school.test", room: "106" },
      { email: "diaz@school.test", room: "112" }, { email: "ng@school.test", room: "120" }, { email: "kim@school.test", room: "121" },
      { email: "new.name@school.test", psEmail: "old.name@school.test", room: "777" },
    ]);
    check("the snapshot keeps each slot's teacher address and PowerSchool's room, and Power-Up's room",
      snaps.M.classBySlot["5"].teacherEmail === "park@school.test" && snaps.M.classBySlot["5"].room === "PS-205"
        && snaps.M.classBySlot["4"].room === null && snaps.H.puRoom === "PS-310" && snaps.M.puRoom === null, J(snaps.M.classBySlot["5"]));
    const MIN = { scheduleId: "s-min", scheduleName: "Minimum Day", noSchool: false };
    const STACK = { scheduleId: "s-stack", scheduleName: "Stack Day / Return from Holiday", noSchool: false };
    const days = [
      ["Mon", MON, "regular", null, "104", "teacher"], ["Tue", TUE, "regular", null, "PS-205", "powerschool"],
      ["Wed", WED, "wed", null, "PS-205", "powerschool"], ["Thu", THU, "regular", null, "104", "teacher"],
      ["Fri", FRI, "regular", null, "PS-205", "powerschool"], ["Minimum (a Monday)", MON, "minimum", MIN, "PS-205", "powerschool"],
      ["Stack (a Thursday)", THU, "stack", STACK, "PS-205", "powerschool"],
    ];
    const got = days.map(([label, date, kind, marked]) => {
      const at = R.beforeLunchSlot({ date, kind, marked });
      return [label, R.pullRoomOf("ms", snaps.M, at, rooms)];
    });
    check("MS: the class before lunch's room on every kind of day -- P3 Mon/Thu, P4 Tue/Fri, Wednesday, Minimum and Stack -- never Power-Up's",
      got.every(([label, p], i) => p.room === days[i][4] && p.source === days[i][5]) && got.every(([, p]) => p.room !== "109"),
      J(got));
    const at = R.beforeLunchSlot({ date: TUE, kind: "regular" });
    const hs = R.pullRoomOf("hs", snaps.H, at, rooms);
    check("HS: Power-Up's room, whatever the day -- never the class before lunch",
      J(hs) === J({ room: "PS-310", source: "powerschool" }) && J(R.pullRoomOf("hs", snaps.H, R.beforeLunchSlot({ date: MON, kind: "regular" }), rooms)) === J(hs)
        && J(R.pullRoomOf("hs", snaps.H2, at, rooms)) === J({ room: "111", source: "teacher" }), J(hs));
    check("PowerSchool's room for the section is preferred to the teacher's room; the teacher's when PowerSchool has none",
      R.pullRoomOf("ms", snaps.M, at, rooms).room === "PS-205" && rooms["park@school.test"] === "105"
        && R.pullRoomOf("ms", snaps.M, R.beforeLunchSlot({ date: MON, kind: "regular" }), rooms).room === "104");
    check("never a guess: two classes in the period, two Power-Up classes, no roster row, or no room anywhere is a dash",
      J(R.pullRoomOf("ms", snaps.M2, R.beforeLunchSlot({ date: MON, kind: "regular" }), rooms)) === J(R.NO_ROOM)
        && J(R.pullRoomOf("hs", snaps.H3, at, rooms)) === J(R.NO_ROOM)
        && J(R.pullRoomOf("ms", null, at, rooms)) === J(R.NO_ROOM)
        && J(R.pullRoomOf("ms", snaps.M, R.beforeLunchSlot({ date: MON, kind: "regular" }), {})) === J(R.NO_ROOM)
        && J(R.pullRoomOf("ms", snaps.M, null, rooms)) === J(R.NO_ROOM));
    check("a renamed teacher's room is found through the address PowerSchool still uses",
      J(R.pullRoomOf("ms", snaps.M3, R.beforeLunchSlot({ date: MON, kind: "regular" }), rooms)) === J({ room: "777", source: "teacher" }));
    // A snapshot taken before 10/13 knows each class but not whose room it meets in.
    const old = structuredClone(snaps.M);
    for (const c of Object.values(old.classBySlot)) { delete c.teacherEmail; delete c.room; }
    delete old.puRoom;
    check("a snapshot taken before rooms: an MS row has a dash until the next snapshot, never another class's room",
      J(R.pullRoomOf("ms", old, R.beforeLunchSlot({ date: MON, kind: "regular" }), rooms)) === J(R.NO_ROOM)
        && J(R.pullRoomOf("hs", { ...snaps.H, puRoom: undefined }, at, rooms)) === J({ room: "110", source: "teacher" }));
  }

  // ==========================================================================
  console.log("\n3. ONLY AN ADMINISTRATOR SETS A ROOM\n");
  // ==========================================================================
  {
    const STAFF = {
      admin: { email: "admin@school.test", role: "admin", name: "Ada Admin" },
      superadmin: { email: "super@school.test", role: "superadmin", name: "Sol Super" },
      pbis: { email: "pbis@school.test", role: "pbis", name: "Pat Pbis" },
      teacher: { email: "teacher@school.test", role: "teacher", name: "Tom Teacher", room: "201" },
      aide: { email: "aide@school.test", role: "campusaide", name: "Ana Aide", reflectionList: true, reflectionListUntil: "2026-12-18" },
      ortiz: { email: "ortiz@school.test", role: "teacher", name: "Olga Ortiz" },
    };
    const store = makeDb(schemaSrc);
    for (const t of Object.values(STAFF)) await store.db.insert("teachers", { ticketsAwarded: 0, ...t });
    const rt = runtime(store, mods);
    const as = (who) => { rt.signIn(who ? { issuer: ISSUER, email: STAFF[who].email } : null); return rt; };
    const tryRun = (who, path, args) => as(who).run(path, args).then((x) => x, (e) => ({ threw: String(e.message || e) }));
    const roomOf = (who) => store.rows("teachers").find((t) => t.email === STAFF[who].email)?.room;
    const audits = () => store.rows("appAuditLog").filter((a) => a.payload?.action === "Changed room");
    clock.set("2026-10-13T20:00:00.000Z");

    const own = await tryRun("teacher", "staffInvites.setStaffRoom", { email: STAFF.teacher.email, room: "999" });
    const other = await tryRun("teacher", "staffInvites.setStaffRoom", { email: STAFF.ortiz.email, room: "999" });
    check("a teacher cannot set a room, not even their own: refused, nothing written",
      own.threw?.includes(RM.ROOM_REFUSED) && other.threw?.includes(RM.ROOM_REFUSED) && roomOf("teacher") === "201"
        && roomOf("ortiz") === undefined && audits().length === 0, J([own, other]));
    const byPbis = await tryRun("pbis", "staffInvites.setStaffRoom", { email: STAFF.ortiz.email, room: "104" });
    const byAide = await tryRun("aide", "staffInvites.setStaffRoom", { email: STAFF.ortiz.email, room: "104" });
    const byNobody = await tryRun(null, "staffInvites.setStaffRoom", { email: STAFF.ortiz.email, room: "104" });
    check("...nor PBIS, nor an aide holding the Reflection Room list grant, nor anyone signed out",
      byPbis.threw?.includes(RM.ROOM_REFUSED) && byAide.threw?.includes(RM.ROOM_REFUSED) && !!byNobody.threw
        && roomOf("ortiz") === undefined && audits().length === 0, J([byPbis, byAide, byNobody]));

    const set = await tryRun("admin", "staffInvites.setStaffRoom", { email: STAFF.ortiz.email, room: " 104 " });
    const row = store.rows("teachers").find((t) => t.email === STAFF.ortiz.email);
    check("an admin sets it: stored as typed, who set it and when, and one audit line naming staff only",
      J(set) === J({ email: STAFF.ortiz.email, name: "Olga Ortiz", previous: null, room: "104", changed: true }) && row.room === "104"
        && row.roomSetBy === STAFF.admin.email && row.roomSetAt === clock.iso && audits().length === 1
        && audits()[0].payload.details === "Olga Ortiz: room none → 104", J({ set, row, a: audits() }));
    clock.advance(60_000);
    const again = await tryRun("admin", "staffInvites.setStaffRoom", { email: STAFF.ortiz.email, room: "104" });
    check("the same room again writes nothing (the Classrooms list saves as an admin moves down it)",
      again.changed === false && store.rows("teachers").find((t) => t.email === STAFF.ortiz.email).roomSetAt === row.roomSetAt
        && audits().length === 1, J(again));
    const cleared = await tryRun("superadmin", "staffInvites.setStaffRoom", { email: STAFF.ortiz.email, room: "" });
    const bad = await tryRun("admin", "staffInvites.setStaffRoom", { email: STAFF.teacher.email, room: "<img src=x>" });
    const mine = await tryRun("admin", "staffInvites.setStaffRoom", { email: STAFF.admin.email, room: "Office 2" });
    const nobody = await tryRun("admin", "staffInvites.setStaffRoom", { email: "ghost@school.test", room: "1" });
    check("a superadmin clears one; markup is refused; an admin may set their own; an unknown address is refused",
      cleared.changed === true && cleared.room === null && roomOf("ortiz") === undefined && !!bad.threw && roomOf("teacher") === "201"
        && mine.room === "Office 2" && /No staff record/.test(nobody.threw || ""), J([cleared, bad, mine, nobody]));
    const cli = await rt.run("staffInvites.setStaffRoomFromCli", { email: STAFF.ortiz.email, room: "104" });
    check("the command line sets one too, recorded as the command line", cli.room === "104"
      && store.rows("teachers").find((t) => t.email === STAFF.ortiz.email).roomSetBy === "command line");
    const S = mods.appDataShape;
    check("no browser save can carry a room: it is not in TEACHER_WRITABLE; the app sees it for display only",
      !S.TEACHER_WRITABLE.includes("room") && S.toAppTeacher({ name: "x", room: "104" }).room === "104" && S.toAppTeacher({ name: "x" }).room === null);
    const src = read("./convex/staffInvites.ts");
    const body = src.slice(src.indexOf("async function applyStaffRoom("), src.indexOf("export const setStaffRoom ="));
    check("the check is made on the caller's stored role before any staff record is read",
      body.indexOf("canSetRooms(actor.role)") > 0 && body.indexOf("canSetRooms(actor.role)") < body.indexOf("ctx.db")
        && /setStaffRoom = mutation\(\{\s*args: \{ email: v\.string\(\), room: v\.union\(v\.string\(\), v\.null\(\)\) \}/.test(src));
  }

  // ==========================================================================
  console.log("\n4. THE SYNC ASKS FOR ROOMS, AND A 403 CHANGES NOTHING\n");
  // ==========================================================================
  {
    const SECTIONS = 150;   // more than one page of the room read
    const rosterRow = (i) => ({
      student_number: String(20000 + Math.floor(i / 5)), first_name: "F", last_name: "L", grade_level: "7",
      section_id: String(5000 + (i % 5)), section_expression: `${(i % 5) + 2}(A-E)`, course_name: "Course",
      teacher_email: `t${i % 5}@school.test`, teacher_first_name: "T", teacher_last_name: "Teacher", term_id: "3601",
    });
    /** PowerSchool: the named queries (a roster of `n` rows) and the sections table, answering `rooms` as told. */
    const server = (n, rooms, calls) => async (url, init = {}) => {
      const u = new URL(url);
      calls.push({ method: init.method || "GET", path: u.pathname, q: u.searchParams.get("q"), projection: u.searchParams.get("projection"), page: u.searchParams.get("page") });
      const resp = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
      if (u.pathname === "/oauth/access_token") return resp(200, { access_token: "tok" });
      if (u.pathname === "/ws/schema/table/sections") {
        if (rooms === "403") return resp(403, { message: "Plugin lacks sufficient permission for SECTIONS.ROOM" });
        if (rooms === "500") return resp(500, { message: "down" });
        if (rooms === "throw") throw new Error("socket hang up");
        const page = Number(u.searchParams.get("page")), size = Number(u.searchParams.get("pagesize"));
        const all = Array.from({ length: SECTIONS }, (_, k) => ({ tables: { sections: { id: String(5000 + k), room: k === 4 ? "" : `R-${100 + k}` } } }));
        return resp(200, { record: all.slice((page - 1) * size, page * size) });
      }
      const m = /^\/ws\/schema\/query\/[\w.]+\.(\w+)$/.exec(u.pathname);
      if (!m) throw new Error("unexpected " + u.pathname);
      const page = Number(u.searchParams.get("page")), size = Number(u.searchParams.get("pagesize"));
      const all = m[1] === "roster" ? Array.from({ length: n }, (_, i) => rosterRow(i)) : [];
      return resp(200, { record: all.slice((page - 1) * size, page * size) });
    };
    const stub = (ret) => ({ _kind: "internalMutation", handler: async () => ret });
    const stubs = {
      sisSync: { syncStudents: stub({ created: 0, updated: 0 }) },
      sisStats: {
        putAttendance: stub({}), replaceGrades: stub({ remaining: "none" }), replaceMissingWork: stub({ remaining: "none" }),
        replaceSectionPoints: stub({ moreToClear: false }), replaceAttendanceBySection: stub({ moreToClear: false }),
        replaceRestricted: stub({}),
      },
      studentEmail: { setStudentEmails: stub({ studentsWithEmail: 0, totalStudents: 0 }) },
    };
    async function sync(rooms) {
      const store = makeDb(schemaSrc);
      const rt = runtime(store, { ...mods, ...stubs });
      const calls = [];
      globalThis.fetch = server(100, rooms, calls);
      clock.set("2026-10-13T19:00:00.000Z");
      const summary = await rt.run("sisAction.syncFromPowerSchool", { reason: "test" }).then((x) => x, (e) => ({ threw: String(e.message || e) }));
      return { summary, roster: store.rows("psRoster"), runs: store.rows("syncRuns"), calls };
    }
    const shape = (rows) => rows.map(({ _id, _creationTime, syncedAt, sectionRoom, ...r }) => r);

    const refused = await sync("403");
    check("a 403 on Sections.Room (plugin 1.4.2, today): the sync finishes, the roster is written whole, and the run is recorded",
      !refused.summary.threw && refused.roster.length === 100 && refused.runs.length === 1 && refused.summary.rosterRows === 100
        && refused.summary.rosterKept === false && refused.summary.sectionRooms === "not-granted" && refused.summary.sectionRoomsError === null
        && refused.summary.sectionRoomsFound === 0 && refused.roster.every((r) => !("sectionRoom" in r)), J(refused.summary));
    const granted = await sync("granted");
    const roomOf = (sectionId) => [...new Set(granted.roster.filter((r) => r.sectionId === sectionId).map((r) => r.sectionRoom ?? null))];
    check("granted (plugin 1.4.3): every roster row carries its section's room, read across every page; a blank room is none",
      J(roomOf("5000")) === J(["R-100"]) && J(roomOf("5003")) === J(["R-103"]) && J(roomOf("5004")) === J([null])
        && granted.summary.sectionRooms === "granted" && granted.summary.sectionRoomsFound === SECTIONS - 1
        && granted.summary.rosterRowsWithRoom === 80 && granted.calls.filter((c) => c.path === "/ws/schema/table/sections").length === 2,
      J({ s: granted.summary, rooms: ["5000", "5004"].map(roomOf) }));
    check("...and apart from the rooms the roster is the very roster a refused read writes",
      J(shape(granted.roster)) === J(shape(refused.roster)));
    const down = await sync("500");
    const broken = await sync("throw");
    check("PowerSchool down or the request failing: the sync finishes all the same, the roster whole, the error named",
      [down, broken].every((x) => !x.summary.threw && x.roster.length === 100 && x.runs.length === 1 && x.summary.sectionRooms === "error"
        && x.roster.every((r) => !("sectionRoom" in r)) && J(shape(x.roster)) === J(shape(refused.roster)))
        && /HTTP 500/.test(down.summary.sectionRoomsError) && /socket hang up/.test(broken.summary.sectionRoomsError),
      J([down.summary.sectionRoomsError, broken.summary.sectionRoomsError]));
    const roomCalls = granted.calls.filter((c) => c.path.startsWith("/ws/schema/table/"));
    check("the room read is a GET of the sections table's id and room for this term, and nothing else",
      roomCalls.length === 2 && roomCalls.every((c) => c.method === "GET" && c.path === "/ws/schema/table/sections"
        && c.q === "schoolid==1817;termid==3601" && c.projection === "id,room")
        && granted.calls.every((c) => c.method === "GET" || (c.method === "POST" && (c.path.startsWith("/ws/schema/query/") || c.path === "/oauth/access_token"))),
      J(roomCalls));
  }

  // ==========================================================================
  console.log("\n5. THE LIST: THE ROOM EACH STUDENT IS PULLED FROM, COPIED WHEN IT IS MADE\n");
  // ==========================================================================
  // The shipped reader, tick and freeze, both divisions live from Tuesday,
  // through Tuesday (Tue/Fri: MS from P4), Wednesday (P4) and Thursday
  // (Mon/Thu: MS from P3). Rooms: P3-A Ms Ortiz 104; P4-A Ms Park 105; P4-B
  // Mr Bell 205, which PowerSchool rooms in PS-215; P4-C Ms Cole, no room
  // anywhere (Mr Ng's 299 is filed under her address, and is not hers);
  // Power-Up 7 Ms Ruiz 109 (never an MS row's room); HS Power-Up PU-10 Ms
  // Cruz 110, PowerSchool PS-310; PU-11 Mr Lam 111.
  const TUE_SLOTS = [1, 3, 5, 7, 8, 9, 10], WED_SLOTS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], THU_SLOTS = [1, 2, 4, 6, 8, 9, 10];
  const MS = { 1: "PT-A", 2: "P1-A", 3: "P2-A", 4: "P3-A", 5: "P4-A", 6: "P5-A", 7: "P6-A", 9: "PU-7", 10: "PM-A" };
  const HS = { 1: "PT-H", 2: "P1-H", 3: "P2-H", 4: "P3-H", 5: "P4-H", 6: "P5-H", 7: "P6-H", 8: "PU-10", 10: "PM-H" };
  const NAMED = { "P3-A": "Ms Ortiz", "P4-A": "Ms Park", "P4-B": "Mr Bell", "P4-C": "Ms Cole", "P4-D": "Mr Dunn", "PU-7": "Ms Ruiz",
    "PU-10": "Ms Cruz", "PU-11": "Mr Lam" };
  const student = (sn, grade, base, over = {}) => {
    const sections = { ...base, ...over };
    const teachers = Object.fromEntries(Object.entries(sections).map(([slot, sec]) => [slot, NAMED[sec] ?? `Teacher ${sec}`]));
    return { sn, grade, sections, teachers, courses: { 8: "Power Up 10A", 9: "Power Up 7A" } };
  };
  const students = [
    student("M1", 7, MS), student("M2", 7, MS, { 5: "P4-B" }), student("M3", 8, MS, { 5: "P4-C" }), student("M4", 6, MS),
    student("M5", 7, MS), student("M6", 7, MS), student("M7", 7, MS, { 5: "P4-D" }),
    student("H1", 10, HS), student("H2", 11, HS, { 8: "PU-11" }),
    ...WED_SLOTS.flatMap((slot) => Array.from({ length: 10 }, (_, i) => ({ sn: `W${slot}-${i}`, sections: { [slot]: `WFILL-${slot}` } }))),
    ...THU_SLOTS.flatMap((slot) => Array.from({ length: 10 }, (_, i) => ({ sn: `R${slot}-${i}`, sections: { [slot]: `RFILL-${slot}` } }))),
  ];
  const SECTIONS = [...new Set(students.filter((s) => /^[MH]\d$/.test(s.sn)).flatMap((s) => Object.values(s.sections)))];
  const SLOT_OF = Object.fromEntries(students.filter((s) => /^[MH]\d$/.test(s.sn)).flatMap((s) => Object.entries(s.sections).map(([slot, sec]) => [sec, Number(slot)])));
  const marks = [
    ...["M1", "M2", "M3", "M4", "H1", "H2"].map((sn) => ({ sn, slot: 3, code: "T" })),   // P2 Tuesday: Tuesday's list
    { sn: "M5", slot: 7, code: "T" },                                                     // P6 Tuesday: Wednesday's list
    { sn: "M6", slot: 7, code: "T", date: WED },                                          // P6 Wednesday: Thursday's list
    ...WED_SLOTS.flatMap((slot) => Array.from({ length: 10 }, (_, i) => ({ sn: `W${slot}-${i}`, slot, code: "A", date: WED }))),
    ...THU_SLOTS.flatMap((slot) => Array.from({ length: 10 }, (_, i) => ({ sn: `R${slot}-${i}`, slot, code: "A", date: THU }))),
    ...[WED, THU].flatMap((date) => SECTIONS.map((sec) => ({ sn: `C-${sec}`, slot: SLOT_OF[sec], code: "A", date }))),
  ];
  const day = reflectionDay({
    date: TUE, schoolid: SCHOOL, yearid: YEAR, students, meet: TUE_SLOTS, sectionMarks: SECTIONS, marks,
    rooms: { "P4-B": "PS-215", "PU-10": "PS-310" },
  });
  // M4 is in two classes in P4 (P4-A and P4-D): the list says check PowerSchool.
  day.psRoster.push({ ...day.psRoster.find((r) => r.studentNumber === "M7" && r.sectionId === "P4-D"), studentNumber: "M4", gradeLevel: "6" });
  const gradeOfSn = Object.fromEntries(day.psRoster.map((r) => [r.studentNumber, r.gradeLevel]));
  for (const s of day.tables.students) Object.assign(s, { enroll_status: 0, grade_level: gradeOfSn[s.student_number] ?? "7" });
  day.tables.terms = [{ id: 3601, abbreviation: "S1", lastday: "2026-12-18", schoolid: SCHOOL, yearid: YEAR }];
  const fake = fakePowerSchool(day.tables);
  globalThis.fetch = fake.fetch;

  const STAFF = {
    admin: { email: "admin@school.test", role: "admin", name: "Ada Admin" },
    ortiz: { email: "p3-a@school.test", role: "teacher", name: "Olga Ortiz", room: "104" },
    park: { email: "p4-a@school.test", role: "teacher", name: "Paz Park", room: "105" },
    bell: { email: "p4-b@school.test", role: "teacher", name: "Bo Bell", room: "205" },
    cole: { email: "p4-c@school.test", role: "teacher", name: "Cy Cole" },
    dunn: { email: "p4-d@school.test", role: "teacher", name: "Di Dunn", room: "207" },
    ruiz: { email: "pu-7@school.test", role: "teacher", name: "Ria Ruiz", room: "109" },
    cruz: { email: "pu-10@school.test", role: "teacher", name: "Cam Cruz", room: "110" },
    lam: { email: "pu-11@school.test", role: "teacher", name: "Lu Lam", room: "111" },
    // Renamed, filed in PowerSchool under an address that is now Ms Cole's
    // own (her account came later). The roster refuses that psEmail, and so
    // must the rooms: P4-C is Ms Cole's class, and she has no room.
    ng: { email: "ng@school.test", role: "teacher", name: "Nu Ng", psEmail: "p4-c@school.test", room: "299" },
  };
  const NAMES = { M1: ["Anouk", "Quarles"], M2: ["Bea", "Vasquezz"], M3: ["Cyprian", "Mossberg"], M4: ["Delphine", "Zanetti"],
    M5: ["Edda", "Pruitt"], M6: ["Fen", "Okafor"], H1: ["Xiomara", "Lindqvist"], H2: ["Yusuf", "Brannigan"] };
  const NAME_RE = new RegExp(Object.values(NAMES).flat().join("|"));
  const BROWSER = Object.entries(NAMES).map(([studentNumber, [firstName, lastName]]) => ({ studentNumber, firstName, lastName }));

  async function school(settings, { snapshot = null, staff = STAFF } = {}) {
    const store = makeDb(schemaSrc);
    await store.db.insert("bellSettings", { key: "bell", timeZone: TZ, updatedAt: "2026-08-17T00:00:00Z" });
    await store.db.insert("appState", { key: "reflection:settings", value: settings, mirroredAt: "2026-10-01T00:00:00Z" });
    for (const r of day.psRoster) await store.db.insert("psRoster", { ...r });
    await store.db.insert("syncRuns", { at: day.psRoster[0].syncedAt, summary: { syncedAt: day.psRoster[0].syncedAt, rosterKept: false, rosterRows: 1 } });
    for (const t of Object.values(staff)) await store.db.insert("teachers", { ticketsAwarded: 0, ...t });
    for (const r of snapshot ?? []) { const { _id, _creationTime, ...doc } = r; await store.db.insert("reflectionRoster", doc); }
    const rt = runtime(store, mods);
    const as = (who) => { rt.signIn({ issuer: ISSUER, email: STAFF[who].email }); return rt; };
    const tryRun = (who, path, args) => (who ? as(who) : rt).run(path, args).then((x) => x, (e) => ({ threw: String(e.message || e) }));
    return { store, rt, as, tryRun, log: [] };
  }
  async function runJobs(w, beforeMs) {
    for (;;) {
      const due = w.rt.jobs.filter((j) => j.at < beforeMs).sort((a, b) => a.at - b.at)[0];
      if (!due) return;
      w.rt.jobs.splice(w.rt.jobs.indexOf(due), 1);
      clock.set(Math.max(due.at, Date.parse(clock.iso)));
      w.log.push({ at: clock.iso, path: due.path, key: due.args?.key, out: await w.rt.run(due.path, due.args) });
    }
  }
  async function drive(w, fromIso, toIso) {
    for (let t = Date.parse(fromIso); t <= Date.parse(toIso); t += FIVE) {
      clock.set(t);
      w.rt.signIn(null);
      w.log.push({ at: clock.iso, path: "tick", out: await w.rt.run("reflection.tick", {}) });
      await runJobs(w, t + FIVE);
    }
  }
  const rowsOf = (res) => (res.sections || []).flatMap((s) => s.rows);
  /** Each row's room by student number, in student-number order (the list's own order is by teacher). */
  const roomsOf = (res) => Object.fromEntries(rowsOf(res).map((r) => [r.studentNumber, r.room?.room ?? null]).sort((a, b) => a[0].localeCompare(b[0])));
  const EXPECT = { H1: "PS-310", H2: "111", M1: "105", M2: "PS-215", M3: null, M4: null };
  const ASK = { demoOk: true, lunchOk: true, checkinOk: true };

  const LIVE = { modeByDivision: { ms: "live", hs: "live" }, countFromDateByDivision: { ms: TUE, hs: TUE } };
  const real = await school(LIVE);
  await drive(real, la(TUE, "07:30"), la(TUE, "10:30"));
  clock.set(la(TUE, "10:31"));
  const soFar = await real.tryRun("admin", "reflectionList.listForDay", { day: "today", ...ASK });
  check("before the list is made ('so far'), each row's room is looked up now: MS from P4 on a Tuesday, HS from Power-Up",
    soFar.view === "so-far" && J(roomsOf(soFar)) === J(EXPECT),
    J({ view: soFar.view, rooms: roomsOf(soFar), why: soFar.reason }));

  await drive(real, la(TUE, "10:35"), la(TUE, "11:45"));
  clock.set(la(TUE, "11:46"));
  const made = await real.tryRun("admin", "reflectionList.listForDay", { day: TUE, ...ASK });
  const units = real.store.rows("reflectionUnits").filter((u) => u.serveDay === TUE);
  const snapOf = (sn) => units.find((u) => u.studentNumber === sn)?.roomSnapshot;
  check("the list made at 11:45: MS rooms from the class before lunch (P4 on a Tuesday), HS from Power-Up",
    made.view === "made" && J(roomsOf(made)) === J(EXPECT)
      && !Object.values(roomsOf(made)).some((r) => r === "109" || r === "104"), J({ view: made.view, rooms: roomsOf(made) }));
  check("...PowerSchool's room where it has one, and says so; the teacher's otherwise; a dash where neither is known, or the class could not be named",
    J(rowsOf(made).find((r) => r.studentNumber === "M2").room) === J({ room: "PS-215", source: "powerschool" })
      && J(rowsOf(made).find((r) => r.studentNumber === "M1").room) === J({ room: "105", source: "teacher" })
      && J(rowsOf(made).find((r) => r.studentNumber === "M3").room) === J({ room: null, source: null })
      && /Check PowerSchool: 2 classes in P4/.test(rowsOf(made).find((r) => r.studentNumber === "M4").lunch?.problem ?? ""),
    J(rowsOf(made).map((r) => [r.studentNumber, r.room, r.lunch?.problem])));
  check("...and each detention keeps a copy of its room, made with the list",
    J(snapOf("M1")) === J({ room: "105", source: "teacher" }) && J(snapOf("M2")) === J({ room: "PS-215", source: "powerschool" })
      && J(snapOf("M3")) === J({}) && J(snapOf("H1")) === J({ room: "PS-310", source: "powerschool" }), J(units.map((u) => [u.studentNumber, u.roomSnapshot])));

  // ---- the screen: this build's, then the one open tabs run today
  const server = {
    query: (args, path) => real.as("admin").run(path.replace(":", "."), args),
    mutation: (args, path) => real.as("admin").run(path.replace(":", "."), args),
  };
  clock.set(la(TUE, "11:50"));
  const now = makeWorld(scriptSrc, server, BROWSER);
  await now.app.loadReflectionList();
  const html = now.fixed.rrList.innerHTML;
  const roomCells = [...html.matchAll(/<td><b>([^<]*)<\/b><\/td><td>(\w+)<\/td>[\s\S]*?data-rr-classroom="([^"]*)"/g)].map((m) => [m[2], m[3]]);
  check("this build's screen: a sortable Room column beside the class, the room in each row, a dash where none is known",
    (html.match(/data-sort-col="4"[^>]*>Room</g) || []).length === 2
      && J(Object.fromEntries(roomCells.sort((a, b) => a[0].localeCompare(b[0])))) === J({ H1: "PS-310", H2: "111", M1: "105", M2: "PS-215", M3: "", M4: "" })
      && /title="Room from PowerSchool">PS-215</.test(html) && /title="The teacher&#39;s room, set on the Teachers tab">105</.test(html)
      && /data-rr-classroom="">&mdash;</.test(html) && NAME_RE.test(html), J(roomCells));
  now.app.sortBy("rrMs", 4, "text");
  now.app.renderReflectionRoom();
  const msOrder = [...now.fixed.rrList.innerHTML.split('data-rr-section="hs"')[0].matchAll(/<td><b>([^<]*)<\/b>/g)].map((m) => m[1]);
  check("...sorted by room: room order, the rooms not known last",
    J(msOrder) === J(["Quarles, Anouk", "Vasquezz, Bea", "Mossberg, Cyprian", "Zanetti, Delphine"]), J(msOrder));
  now.app.sortBy("rrMs", 4, "text");
  now.app.sortBy("rrMs", 4, "text");

  await now.app.printReflectionList();
  const sheet = now.prints[0]?.sheet || "";
  check("the printed list has the Room column and each room, MS and HS",
    (sheet.match(/<th>Room<\/th>/g) || []).length === 2 && />105<\/span><\/td>/.test(sheet) && />PS-310<\/span><\/td>/.test(sheet), sheet.slice(0, 400));
  now.fire("afterprint");
  await now.app.printReflectionSlips();
  const slips = now.prints[1]?.sheet || "";
  const outs = [...slips.matchAll(/<div class="rr-slip-out">([^<]*?)\s*(?:<span class="rr-slip-room">([^<]*)<\/span>)?\s*(?:<span class="rr-slip-extra">([^<]*)<\/span>)?<\/div>/g)]
    .map((m) => [m[2] || "", m[1].trim()]);
  check("pull slips run in room order, then teacher, with the room on the outside of each; rooms not known last, never guessed",
    J(outs) === J([["Room 105", "Ms Park"], ["PS-215", "Mr Bell"], ["", "Check PowerSchool: 2 classes in P4"], ["", "Ms Cole"],
      ["Room 111", "Mr Lam"], ["PS-310", "Ms Cruz"]]) && (slips.match(/<tr data-rr-slip-row>/g) || []).length === 6, J(outs));
  now.fire("afterprint");

  let oldSrc = null;
  try {
    oldSrc = execFileSync("git", ["show", "492e557:script.js"],
      { cwd: fileURLToPath(new URL("./", import.meta.url)), stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 << 20 }).toString();
  } catch { /* no git here */ }
  if (oldSrc) {
    const old = makeWorld(oldSrc, server, BROWSER);
    await old.app.loadReflectionList();
    const oldHtml = old.fixed.rrList.innerHTML;
    const oldNames = [...oldHtml.matchAll(/<td><b>([^<]*)<\/b>/g)].map((m) => m[1]).sort();
    check("an open tab on the 492e557 screen, handed rows that carry rooms: it draws the whole list as before, names and classes, no Room column",
      old.app.data?.view === "made" && rowsOf(old.app.data).every((r) => "room" in r) && oldNames.length === 6 && NAME_RE.test(oldHtml)
        && /P4 · Ms Park/.test(oldHtml) && /Ms Cruz/.test(oldHtml) && !/data-rr-classroom|>Room</.test(oldHtml) && old.app.why === "",
      J({ why: old.app.why, names: oldNames }));
    await old.app.printReflectionList();
    await old.app.printReflectionSlips();
    const oldSheet = old.prints[0]?.sheet || "", oldSlips = old.prints[1]?.sheet || "";
    check("...and prints it and its slips as before: every student, no room anywhere",
      old.prints.length === 2 && (oldSheet.match(/<tr><td class="print-check"><\/td>/g) || []).length === 6 && !/<th>Room<\/th>/.test(oldSheet)
        && (oldSlips.match(/<tr data-rr-slip-row>/g) || []).length === 6 && !/rr-slip-room/.test(oldSlips), J(old.prints.length));
  } else {
    console.log("  SKIP  the 492e557 screen against this server (git or that commit not available here)");
  }

  // ---- a room changed after the list was made
  clock.set(la(TUE, "12:00"));
  const changed = await real.tryRun("admin", "staffInvites.setStaffRoom", { email: STAFF.park.email, room: "155" });
  const after = await real.tryRun("admin", "reflectionList.listForDay", { day: TUE, ...ASK });
  const tomorrow = await real.tryRun("admin", "reflectionList.listForDay", { day: "next", ...ASK });
  check("a list already made keeps the room copied when it was made: Ms Park moved to 155 at noon, Tuesday's list still says 105",
    changed.changed === true && J(roomsOf(after)) === J(roomsOf(made)) && roomsOf(after).M1 === "105", J({ changed, rooms: roomsOf(after) }));
  check("...while tomorrow's list so far, not made yet, shows her new room (Wednesday: MS from P4)",
    tomorrow.view === "so-far" && tomorrow.date === WED && J(roomsOf(tomorrow)) === J({ M5: "155" }), J({ view: tomorrow.view, rooms: roomsOf(tomorrow) }));

  await drive(real, la(WED, "07:30"), la(WED, "11:20"));
  clock.set(la(WED, "11:21"));
  const wed = await real.tryRun("admin", "reflectionList.listForDay", { day: WED, ...ASK });
  await drive(real, la(THU, "07:30"), la(THU, "11:45"));
  clock.set(la(THU, "11:46"));
  const thu = await real.tryRun("admin", "reflectionList.listForDay", { day: THU, ...ASK });
  check("Wednesday's list (MS from P4) and Thursday's (Mon/Thu: MS from P3) each name that day's class's room",
    wed.view === "made" && roomsOf(wed).M5 === "155" && thu.view === "made" && roomsOf(thu).M6 === "104"
      && thu.kind === "regular" && wed.kind === "wed", J({ wed: [wed.view, roomsOf(wed)], thu: [thu.view, roomsOf(thu)] }));

  // ---- a list made before rooms existed: no copy, so a dash -- never a room looked up today
  const unit = real.store.rows("reflectionUnits").find((u) => u.serveDay === TUE && u.studentNumber === "H2");
  real.store.tables.reflectionUnits.find((u) => u._id === unit._id).roomSnapshot = undefined;
  delete real.store.tables.reflectionUnits.find((u) => u._id === unit._id).roomSnapshot;
  clock.set(la(THU, "12:00"));
  const before = await real.tryRun("admin", "reflectionList.listForDay", { day: TUE, ...ASK });
  check("a detention on a list made before rooms has no copy, and shows a dash rather than a room looked up today",
    J(rowsOf(before).find((r) => r.studentNumber === "H2")?.room) === J({ room: null, source: null }) && roomsOf(before).H1 === "PS-310",
    J(rowsOf(before).find((r) => r.studentNumber === "H2")?.room));

  // ---- the TEST list builder names the same rooms as the real list
  const demo = await school({ modeByDivision: { ms: "shadow", hs: "shadow" }, countFromDateByDivision: { ms: FRI, hs: FRI } },
    { snapshot: real.store.rows("reflectionRoster").map((r) => ({ ...r, snapAt: la(TUE, "07:30") })) });
  clock.set(la(TUE, "11:46"));
  const built = await demo.tryRun(null, "reflectionDemo.build", { day: TUE });
  const shown = await demo.tryRun("admin", "reflectionList.listForDay", { day: "today", ...ASK });
  const stored = demo.store.rows("reflectionDemoLists")[0];
  check("a TEST list built for the same day names the same rooms as the real list made that day, and stores them on its rows",
    built.ok === true && shown.demo === true && J(roomsOf(shown)) === J(roomsOf(made))
      && J(stored.rows.find((r) => r.studentNumber === "M2")?.room) === J({ room: "PS-215", source: "powerschool" }),
    J({ built: built.reason ?? built.ok, demo: roomsOf(shown), real: roomsOf(made) }));
  await demo.store.db.insert("reflectionDemoLists", { ...stored, _id: undefined, _creationTime: undefined, day: MON,
    rows: stored.rows.map(({ room, ...r }) => r) });
  clock.set(la(MON, "12:00"));
  const legacy = await demo.tryRun("admin", "reflectionList.listForDay", { day: MON, ...ASK });
  check("...and a TEST list built before rooms shows a dash on every row",
    legacy.demo === true && rowsOf(legacy).length === 6 && rowsOf(legacy).every((r) => J(r.room) === J({ room: null, source: null })),
    J(rowsOf(legacy).map((r) => r.room)));
  const testWorld = makeWorld(scriptSrc, {
    query: (args, path) => demo.as("admin").run(path.replace(":", "."), args),
    mutation: (args, path) => demo.as("admin").run(path.replace(":", "."), args),
  }, BROWSER);
  clock.set(la(TUE, "11:47"));
  await testWorld.app.loadReflectionList();
  check("...and the screen draws a TEST list's rooms like a real list's",
    testWorld.app.data?.demo === true && /data-rr-classroom="PS-215"/.test(testWorld.fixed.rrList.innerHTML), testWorld.app.why);

  // ==========================================================================
  console.log("\n6. THE CLASSROOMS LIST ON THE TEACHERS TAB\n");
  // ==========================================================================
  {
    const pick = (re) => { const m = re.exec(scriptSrc); if (!m) throw new Error("missing " + re); return m[0]; };
    const fns = ["staffRoomRequest", "staffRoomAdmin", "staffRoomsRows", "staffRoomsCountText", "renderStaffRooms", "staffRoomStatusShow",
      "saveStaffRoomFromList", "escapeHtml", "wcSortCellText", "wcSortValue", "wcSortColumnType", "wcSortOrder", "wcSortItems", "wcSortTh"];
    const els = {};
    const el = (id) => (els[id] ??= { id, innerHTML: "", textContent: "", value: id === "staffRoomsFilter" ? "teachers" : "", contains: () => false });
    const calls = [];
    let answer = (args) => ({ email: args.email, name: "x", previous: null, room: args.room, changed: true });
    const make = (teachers, currentUser) => new Function("document", "window", "teachers", "currentUser",
      `const _wcSortState = new Map(), _wcSortRedraw = new Map();
      const WC_SORT_ARROWS = { none: '-', asc: '^', desc: 'v' };
      ${pick(/const _staffRoomPending = new Map\(\);/)}
      ${pick(/const _staffRoomStatus = new Map\(\);/)}
      ${pick(/const STAFF_ROOM_ROLE = \{[^}]*\};/)}
      ${fns.map((n) => lift(scriptSrc, n)).join("\n\n")}
      return { renderStaffRooms, saveStaffRoomFromList, staffRoomRequest };`,
    )({ getElementById: el, activeElement: null, querySelectorAll: () => [] },
      { WildcatAuth: { getSession: () => ({ idToken: "tok" }), convexMutation: async (path, args) => { calls.push({ path, args }); return answer(args); } } },
      teachers, currentUser);
    const T = () => [
      { id: "1", name: "Olga Ortiz", email: "ortiz@school.test", role: "teacher", room: "104" },
      { id: "2", name: "Bo Bell", email: "bell@school.test", role: "teacher", room: null },
      { id: "3", name: "Ada Admin", email: "admin@school.test", role: "admin", room: null },
      { id: "4", name: "Cy Cole", email: "cole@school.test", role: "teacher", room: null },
    ];
    const staff = T();
    const app = make(staff, { role: "admin", email: "admin@school.test" });
    app.renderStaffRooms(true);
    const list = els.staffRoomsList.innerHTML;
    const boxes = [...list.matchAll(/data-staff-room-email="([^"]*)"/g)].map((m) => m[1]);
    check("the Classrooms list: every teacher with a box for their room, by name, and how many still have none",
      J(boxes) === J(["bell@school.test", "cole@school.test", "ortiz@school.test"]) && /value="104"/.test(list)
        && els.staffRoomsCount.textContent === "2 of 3 teachers with no room" && (list.match(/class="wc-sort-btn"/g) || []).length === 3
        && !/ disabled/.test(list), J(boxes));
    els.staffRoomsFilter.value = "missing";
    app.renderStaffRooms(true);
    check("...'Teachers with no room' shows only those",
      J([...els.staffRoomsList.innerHTML.matchAll(/data-staff-room-email="([^"]*)"/g)].map((m) => m[1])) === J(["bell@school.test", "cole@school.test"]));
    const input = { value: " 205 ", getAttribute: (k) => (k === "data-staff-room-email" ? "bell@school.test" : null) };
    const first = app.saveStaffRoomFromList(input);
    const second = app.saveStaffRoomFromList(input);
    await first; await second;
    check("typing a room saves it through the server (once, however Enter and the change event race), and shows what the server stored",
      calls.length === 1 && calls[0].path === "staffInvites:setStaffRoom" && J(calls[0].args) === J({ email: "bell@school.test", room: "205" })
        && staff[1].room === "205" && els.staffRoomsCount.textContent === "1 of 3 teachers with no room", J(calls));
    answer = () => { throw new Error("Only administrators can set a staff member's room."); };
    const refusedInput = { value: "300", getAttribute: () => "cole@school.test" };
    await app.saveStaffRoomFromList(refusedInput);
    check("a refusal puts the box back to the room the server holds and says why", refusedInput.value === "" && staff[3].room === null);
    check("an unchanged box sends nothing, and blank means no room",
      app.staffRoomRequest({ room: "104" }, " 104 ") === null && app.staffRoomRequest({ room: "104" }, "  ") === ""
        && app.staffRoomRequest({ room: null }, "") === null);
    const teacherView = make(T(), { role: "teacher", email: "ortiz@school.test" });
    els.staffRoomsFilter.value = "teachers";
    teacherView.renderStaffRooms(true);
    check("for anyone but an admin every box is greyed out (the server refuses them anyway)",
      (els.staffRoomsList.innerHTML.match(/ disabled /g) || []).length === 3);
    const pkg = JSON.parse(read("./package.json"));
    check("this test runs in npm test", /&& node reflection-rooms\.test\.mjs\b/.test(pkg.scripts.test));
  }
} finally {
  clock.real();
  console.log = realLog;
  loaded.cleanup();
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail) process.exit(1);
