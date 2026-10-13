/**
 * ROOM NUMBERS (owner, 2026-10-13: "Can we add room numbers to the
 * Reflection Room list? or is that not in PowerSchool").
 *
 * IT IS IN POWERSCHOOL, BUT NOT OURS TO READ YET. Sections.Room exists and
 * answered HTTP 403 on 2026-10-13: the column is there, the plugin (1.4.2)
 * does not ask for it. 1.4.3 asks (docs/admin-ask-1.4.3.md), and until an
 * administrator installs it the owner chose to do BOTH:
 *
 *   NOW    an administrator types each teacher's room on the Teachers tab
 *          (most teachers keep one room all day). `teachers.room`.
 *   LATER  the moment PowerSchool grants Sections.Room, the sync stores each
 *          section's own room (psRoster.sectionRoom) and the list prefers it,
 *          falling back to the teacher's room. No switch: the data being
 *          there is the switch, and a 403 leaves it absent.
 *
 * PURE, AND IT IMPORTS NOTHING (the sync's own harness loads it on its own).
 * Every decision about a room is here, so a test reaches it without an auth
 * gate or a network in the way: what a room may look like, who may set one,
 * which address a teacher's room is filed under, and what PowerSchool's
 * answer to the room read means. The list's own rule -- which class a
 * student is pulled from, and so whose room -- is reflectionRules.pullRoomOf.
 *
 * NEVER A GUESS. A room that cannot be named is null and the list shows
 * "—". A wrong room sends a runner to the wrong door with a child's name on
 * a slip.
 */

/** The longest room an administrator may type: "Room 214", "B-12", "Library", "MPR Stage". */
export const ROOM_MAX = 24;
/** The longest room taken from PowerSchool (its own column decides; this only stops a runaway value). */
export const PS_ROOM_MAX = 40;

const norm = (s: unknown) => String(s ?? "").trim().toLowerCase();

/**
 * A room as it is shown and stored: spaces collapsed, ends trimmed, null
 * when blank. `max` cuts a runaway value (PowerSchool's), it never decides
 * whether a typed one is acceptable -- staffRoomVerdict does that.
 */
export function cleanRoom(raw: unknown, max = PS_ROOM_MAX): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const s = String(raw).replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
}

/** What a typed room may contain: letters, digits, spaces and - . / # ( ) & ' -- nothing that could be markup. */
const TYPED_ROOM = /^[A-Za-z0-9][A-Za-z0-9 .\/#()&'-]*$/;

/** What anyone but an administrator is told. */
export const ROOM_REFUSED = "Only administrators can set a staff member's room.";

/** Admin and superadmin, by the role stored on the caller's own record. Nobody else, under any grant. */
export function canSetRooms(role: unknown): boolean {
  const r = norm(role);
  return r === "admin" || r === "superadmin";
}

export type StaffRoomVerdict =
  | { ok: true; room: string | null; changed: boolean }
  | { ok: false; reason: string };

/**
 * WHO MAY SET A STAFF MEMBER'S ROOM, AND TO WHAT.
 *
 * ADMIN AND SUPERADMIN ONLY, by their role, read straight off their own
 * record (staffInvites.setStaffRoom passes the caller's stored role). Not
 * PBIS, not a grant holder, not a teacher -- not even for their own room:
 * the room decides which door a runner knocks on with a child's name, and a
 * teacher who could type any room could send every slip somewhere else.
 *
 * Their own record IS allowed for an administrator (an admin who teaches has
 * a room too); unlike a role or an access grant, a room opens nothing.
 *
 * Blank, null or spaces clear it. The same room again is not an error (the
 * Classrooms list saves as the admin moves along it): ok, changed false, and
 * the caller writes nothing.
 */
export function staffRoomVerdict(req: { actorRole: unknown; current: unknown; requested: unknown }): StaffRoomVerdict {
  if (!canSetRooms(req.actorRole)) return { ok: false, reason: ROOM_REFUSED };
  if (req.requested !== null && req.requested !== undefined && typeof req.requested !== "string") {
    return { ok: false, reason: "A room is typed as text, such as 214 or B-12." };
  }
  const raw = String(req.requested ?? "").replace(/\s+/g, " ").trim();
  if (raw.length > ROOM_MAX) {
    return { ok: false, reason: `A room is at most ${ROOM_MAX} characters, such as 214, B-12 or Library.` };
  }
  if (raw && !TYPED_ROOM.test(raw)) {
    return { ok: false, reason: "A room may use letters, numbers, spaces and - . / # ( ) & ' only." };
  }
  const room = raw || null;
  const current = cleanRoom(req.current, ROOM_MAX);
  return { ok: true, room, changed: room !== current };
}

/**
 * THE ROOM ON FILE FOR EACH TEACHER ADDRESS, from staff records: normalized
 * email -> room. A record's own `email` wins over another record's `psEmail`
 * (the address PowerSchool files a renamed teacher's sections under,
 * teachers.psEmail): the roster names a teacher by the PowerSchool address,
 * so without it a renamed teacher's classes would show no room at all. A
 * psEmail that is another staff member's email is refused where it is set
 * (views_app), so the two never compete for real.
 */
export function roomByTeacherEmail(rows: Array<{ email?: unknown; psEmail?: unknown; room?: unknown } | null | undefined>):
  Record<string, string> {
  const own: Record<string, string> = {};
  const alt: Record<string, string> = {};
  for (const r of rows || []) {
    const room = cleanRoom(r?.room, ROOM_MAX);
    if (!room) continue;
    const e = norm(r?.email);
    const p = norm(r?.psEmail);
    if (e && !(e in own)) own[e] = room;
    if (p && p !== e && !(p in alt)) alt[p] = room;
  }
  return { ...alt, ...own };
}

// ---------------------------------------------------------------------------
// POWERSCHOOL'S ROOM READ (the sync, sisAction.readSectionRooms)
// ---------------------------------------------------------------------------

/** What the sync asks the sections table for: this term's sections, their id and room. Nothing else. */
export function sectionRoomsQuery(input: { schoolid: string; termid: string }): { q: string; projection: string } {
  return { q: `schoolid==${input.schoolid};termid==${input.termid}`, projection: "id,room" };
}

export type SectionRoomStatus = "granted" | "not-granted" | "error";

/**
 * WHAT POWERSCHOOL'S ANSWER TO THE ROOM READ MEANS.
 *
 *   403   the column exists and the plugin does not ask for it (1.4.2, today):
 *         "not-granted". Expected, and quiet: the list uses teachers' rooms.
 *   2xx   "granted": the rooms are read.
 *   else  "error": a 404 (the endpoint), a 5xx, a timeout. Reported in the
 *         sync's summary, and the roster is written without rooms -- the
 *         list falls back to the teachers' rooms for that day.
 *
 * NEVER FATAL. The roster matters more than a room column; a sync that
 * stopped here would take every class list in the school down over it.
 */
export function sectionRoomStatus(httpStatus: number): SectionRoomStatus {
  if (httpStatus === 403) return "not-granted";
  if (httpStatus >= 200 && httpStatus < 300) return "granted";
  return "error";
}

/**
 * The rooms out of the table endpoint's records: section id -> room. A
 * record with no id, or a blank room, is left out (blank is "no room in
 * PowerSchool", and the teacher's room still applies).
 */
export function sectionRoomsFromRecords(records: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rec of Array.isArray(records) ? records : []) {
    const r = (rec as any)?.tables?.sections ?? rec;
    const id = r?.id ?? r?.ID;
    if (id === null || id === undefined || String(id).trim() === "") continue;
    const room = cleanRoom(r?.room ?? r?.ROOM);
    if (room) out[String(id).trim()] = room;
  }
  return out;
}
