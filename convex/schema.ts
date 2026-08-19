import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Wildcat Hub schema.
 *
 * Replaces 11 documents inside a single Firestore `raffle_data` collection,
 * where each document held an array. That shape is why "students read only
 * their own row" could not be expressed: there were no rows, only blobs. Here
 * each entity is a real row, so access can be decided per record.
 *
 * `email` is the identity key on both people tables and is ALWAYS stored
 * normalized (trimmed, lowercased) so the index lookup in identity.ts matches
 * the token claim. Writing a non-normalized address breaks sign-in silently.
 */
export default defineSchema({
  // Staff. Joined to Entra by email, sourced from PowerSchool users.email_addr.
  teachers: defineTable({
    legacyId: v.optional(v.string()), // "T001" from the Firestore era
    name: v.string(),
    email: v.string(), // normalized. The Entra join key.
    role: v.union(
      v.literal("teacher"),
      v.literal("admin"),
      v.literal("superadmin"),
      v.literal("campusaide"),
    ),
    ticketsAwarded: v.number(),
    sections: v.optional(v.array(v.string())),
    createdDate: v.string(),
    // NOTE: no `password` field, deliberately. The cleartext password column is
    // what this whole migration exists to delete. Do not carry it across.
  }).index("by_email", ["email"]),

  // Students. Joined to Google by email once PowerSchool manifest field 19
  // (Student Email) is approved and syncing. Optional until then: records exist
  // today with no address, and they simply cannot sign in yet.
  students: defineTable({
    legacyId: v.optional(v.string()),
    studentNumber: v.optional(v.string()),
    // Cafeteria / meal-account number, the payload behind the meal card's
    // barcode. A DIFFERENT number from studentNumber (nutrition services keep
    // their own). Optional: it syncs from PowerSchool STUDENTS.LUNCH_ID once
    // that field is granted, and is null until then. Never an earned value, so
    // a roster sync may write it freely.
    mealPin: v.optional(v.string()),
    firstName: v.string(),
    lastName: v.string(),
    grade: v.optional(v.string()),
    school: v.optional(
      v.union(v.literal("middleschool"), v.literal("highschool")),
    ),
    email: v.optional(v.string()), // normalized. The Google join key.

    // ------------------------------------------------------------------
    // EARNED VALUE. Everything below was earned by a child and must never
    // be recomputed, defaulted, or dropped by a roster sync. PowerSchool
    // knows nothing about any of it, so a sync has no business writing it.
    //
    // An earlier version of this schema carried only the first four and
    // would have silently discarded the nine below on migration, including
    // wildcatCashBalance, which is spendable. If a new earned field appears
    // in the app, it belongs here AND in EARNED_FIELDS in sisSync.ts.
    // ------------------------------------------------------------------
    pbisTickets: v.number(),
    attendanceTickets: v.number(),
    academicTickets: v.number(),
    // Real data holds week NUMBERS here, not strings. The union keeps the
    // source faithful rather than coercing, because coercing a key silently
    // changes what "qualified for week 3" compares equal to.
    bigRaffleQualified: v.array(v.union(v.string(), v.number())),
    weeksQualified: v.optional(v.number()),

    wildcatCashBalance: v.optional(v.number()),
    wildcatCashEarned: v.optional(v.number()),
    wildcatCashSpent: v.optional(v.number()),
    wildcatCashDeducted: v.optional(v.number()),
    // A LIST of redeemed rewards, not a count. Assumed to be a number
    // first; the import refused it, which is the validator doing its job.
    wildcatCashRewardsRedeemed: v.optional(v.array(v.any())),
    wildcatCashTransactions: v.optional(v.array(v.any())),
    cashBalance: v.optional(v.number()),
    cashTransactions: v.optional(v.array(v.any())),

    // Set when a student stops appearing in the SIS roster. They are never
    // deleted: a transferred student still has a balance, and a roster gap
    // is not proof a person ceased to exist.
    archivedAt: v.optional(v.string()),
  })
    .index("by_email", ["email"])
    .index("by_studentNumber", ["studentNumber"]),

  // Was five separate ticket_history* documents split by school and grade band
  // (ms, hs, hs_910, hs_1112). Splitting existed to keep blobs under Firestore's
  // document size limit, not because the data differed. One table with indexes
  // replaces all five.
  ticketHistory: defineTable({
    studentId: v.id("students"),
    teacherId: v.optional(v.id("teachers")),
    amount: v.number(),
    category: v.string(),
    reason: v.optional(v.string()),
    school: v.optional(v.string()),
    timestamp: v.string(),
  })
    .index("by_student", ["studentId"])
    .index("by_teacher", ["teacherId"]),

  auditLog: defineTable({
    action: v.string(),
    actorEmail: v.optional(v.string()), // normalized
    studentId: v.optional(v.id("students")),
    teacherId: v.optional(v.id("teachers")),
    detail: v.optional(v.string()),
    timestamp: v.string(),
  }).index("by_timestamp", ["timestamp"]),

  // Deletions are recorded, not erased, so a restored backup cannot silently
  // resurrect a removed entry. Carried across from the Firestore design.
  tombstones: defineTable({
    entryId: v.string(),
    type: v.string(),
    deletedBy: v.optional(v.string()),
    reason: v.optional(v.string()),
    deletedAt: v.string(),
  }).index("by_entryId", ["entryId"]),

  /**
   * PowerSchool roster, one row per student per section, exactly as the
   * `wildcathub.roster` PowerQuery returns it.
   *
   * The denormalized shape is what makes "match this account to its PowerSchool
   * data" work in both directions from ONE table: a row carries both the
   * teacher's email and the student's email, so
   *   - a teacher's roster  = rows where teacherEmail = their email
   *   - a student's schedule = rows where studentEmail = their email
   * and each direction is a single indexed lookup.
   *
   * Both email columns are stored NORMALIZED (trimmed, lowercased) so they
   * match the token claim. Writing a raw address here breaks the join silently.
   *
   * RESTRICTED FIELDS ARE NOT IN THIS TABLE, deliberately. Federal ethnicity
   * (7), federal race (8), IEP (12), 504 (13) and English Learner (14) are
   * behind their own go/no-go gate per Grilled.md constraint 3, and get a
   * separate table with separate access tests if that gate is ever cleared.
   * Keeping them out means no query over this table can leak them by accident.
   */
  psRoster: defineTable({
    // student side
    studentNumber: v.string(),
    studentEmail: v.optional(v.string()), // normalized. Manifest field 19.
    firstName: v.string(),
    lastName: v.string(),
    gradeLevel: v.optional(v.string()),

    // section / course
    sectionId: v.optional(v.string()),
    sectionNumber: v.optional(v.string()),
    sectionExpression: v.optional(v.string()),
    courseNumber: v.optional(v.string()),
    courseName: v.optional(v.string()),
    period: v.optional(v.string()),

    // staff side
    teacherEmail: v.optional(v.string()), // normalized. Manifest field 17.
    teacherFirstName: v.optional(v.string()),
    teacherLastName: v.optional(v.string()),
    teacherNumber: v.optional(v.string()),

    termId: v.optional(v.string()),
    termAbbreviation: v.optional(v.string()),
    schoolId: v.optional(v.string()),

    syncedAt: v.string(),
  })
    .index("by_teacherEmail", ["teacherEmail"])
    .index("by_studentEmail", ["studentEmail"])
    .index("by_studentNumber", ["studentNumber"]),

  /**
   * Web Push subscriptions, one row per browser/device a staff member enabled
   * notifications on. A hall-pass request schedules a push to every row whose
   * teacherEmail is the pass's origin teacher, so the alert reaches them even
   * when the app is closed. Nothing here is a secret: the endpoint is a URL the
   * push service issued and the keys encrypt payloads TO this device, they do
   * not authenticate anything. Keyed by endpoint (unique per device) so the same
   * device re-subscribing updates rather than duplicates.
   */
  pushSubscriptions: defineTable({
    endpoint: v.string(),
    p256dh: v.string(),
    auth: v.string(),
    teacherEmail: v.string(), // normalized, joins to teachers.email
    userAgent: v.optional(v.string()),
    createdAt: v.string(),
  })
    .index("by_endpoint", ["endpoint"])
    .index("by_teacherEmail", ["teacherEmail"]),

  /**
   * Attendance statistics per student per term, aggregated in SQL on the
   * PowerSchool side (brief Phase 2: days_absent respects
   * Attendance_Code.Presence_Status_CD rather than counting rows).
   *
   * Absent means "not synced yet", NOT zero. A student with no row here has
   * unknown attendance; rendering that as 0 days absent would invent a fact
   * about a child. See the brief, Phase 6 point 3.
   */
  psAttendance: defineTable({
    studentNumber: v.string(),
    daysAbsentTerm: v.optional(v.number()),
    daysAbsentYtd: v.optional(v.number()),
    daysTardyTerm: v.optional(v.number()),
    attendanceRowsYtd: v.optional(v.number()),
    termFirstDay: v.optional(v.string()),
    termLastDay: v.optional(v.string()),
    termId: v.optional(v.string()),
    syncedAt: v.string(),
  }).index("by_studentNumber", ["studentNumber"]),

  /**
   * Current grade per student per section.
   *
   * currentPercent is OPTIONAL on purpose. A student with no PGFinalGrades row
   * is a known gap, not a zero, and the brief is explicit that they must not
   * appear to have 0%.
   */
  psGrades: defineTable({
    studentNumber: v.string(),
    sectionId: v.optional(v.string()),
    courseNumber: v.optional(v.string()),
    courseName: v.optional(v.string()),
    currentGrade: v.optional(v.string()),
    currentPercent: v.optional(v.number()),
    gradeSource: v.optional(v.string()),
    lastGradeUpdate: v.optional(v.string()),
    syncedAt: v.string(),
  })
    .index("by_studentNumber", ["studentNumber"])
    .index("by_section", ["sectionId"]),

  /**
   * RESTRICTED demographics: federal ethnicity, federal race, English Learner.
   *
   * A SEPARATE TABLE, never blended into a student view, per Grilled.md
   * constraint 3 and the brief's Phase 3 point 1. Deliberately NOT LOADED yet:
   * the brief's closing question asks what decision federal race and ethnicity
   * inform in a teacher-facing dashboard, and says to descope them if nobody
   * can name one. The table exists so the shape is decided; loading it is a
   * separate, deliberate act with its own go/no-go line.
   */
  psRestricted: defineTable({
    studentNumber: v.string(),
    fedEthnicity: v.optional(v.string()),
    elaStatus: v.optional(v.string()),
    raceCodes: v.optional(v.array(v.string())),  // one-to-many, never collapsed
    syncedAt: v.string(),
  }).index("by_studentNumber", ["studentNumber"]),

  schedules: defineTable({
    label: v.string(),
    payload: v.any(), // shape not yet pinned down; tighten before it carries logic
  }),

  /**
   * Faithful mirror of the remaining Firestore documents, one row per array
   * element, payload stored verbatim.
   *
   * Deliberately NOT modelled into bespoke tables yet. The purpose of the
   * mirror is to prove the data can be carried across and reconciled to the
   * unit; committing to a shape for hall passes, detentions and referrals
   * before the write paths are ported would be guessing at structures the app
   * may still change, and a wrong guess here is silent (it imports, it
   * reconciles by count, and the meaning quietly shifts). Modelling happens
   * when writes move, one collection at a time.
   *
   * `doc` is the Firestore document, `collection` the array within it, `key`
   * the map key where the source was a map rather than a list.
   */
  legacyMirror: defineTable({
    doc: v.string(),
    collection: v.string(),
    key: v.optional(v.string()),
    payload: v.any(),
    mirroredAt: v.string(),
  })
    .index("by_doc", ["doc"])
    .index("by_doc_collection", ["doc", "collection"]),

  /**
   * Proof that federated sign-in actually works, recorded by the app itself.
   *
   * This exists so the cutover gate is mechanical rather than a line in a
   * runbook. Deleting the cleartext passwords removes the only other way into
   * the system, so it must not happen on someone's recollection that "Entra
   * seemed fine". Rows here can only be written by a caller Convex has already
   * authenticated, so they cannot be faked from a browser console.
   */
  authEvents: defineTable({
    email: v.string(),      // normalized
    provider: v.string(),   // microsoft.com | google.com
    kind: v.string(),       // staff | student
    at: v.string(),
  }).index("by_email", ["email"]),

  /** One row per sync run: rows in, rows changed, duration, errors. */
  syncRuns: defineTable({
    at: v.string(),
    summary: v.any(),
  }).index("by_at", ["at"]),

  /** App settings and cycle state: the scalar and map fields of raffle_data/main. */
  // A searchable mirror of the Entra directory, staff domain only.
  //
  // The app cannot query Microsoft Graph: that needs application permissions
  // and a client secret, and the Wildcat Hub registration is a SPA that holds
  // neither. So the directory is mirrored in by `npm run staff:mirror`, which
  // runs as a signed-in human through `az`, and the app searches this table.
  //
  // MINIMAL BY DESIGN. Name, email and job title are what a person needs to
  // pick the right colleague out of 543. No phone numbers, no manager chain, no
  // object ids beyond the key. A mirror is a copy of somebody else's personal
  // data and every extra column is a copy that has to be justified.
  //
  // Guests and disabled accounts are never written here, so they cannot be
  // invited by accident.
  entraDirectory: defineTable({
    email: v.string(), // normalized, the join key to teachers
    name: v.string(),
    jobTitle: v.optional(v.string()),
    department: v.optional(v.string()),
    // Lowercased "name email jobtitle", so a search is one substring test
    // rather than three, and matches how a person actually types a query.
    searchText: v.string(),
    mirroredAt: v.string(),
  }).index("by_email", ["email"]),

  // Physical places with an NFC tag on the wall. A tag encodes a URL ending in
  // the slug, so tapping it opens the app at /tap/<slug> on iOS and Android
  // alike, with no app installed.
  //
  // `slug` is what is printed on the tag and cannot change without re-encoding
  // it, so it is deliberately human-chosen and stable rather than a generated id.
  tapLocations: defineTable({
    slug: v.string(), // "restroom-2", "room-12"
    name: v.string(), // "Restroom, 2nd floor"
    kind: v.union(
      v.literal("classroom"),
      v.literal("restroom"),
      v.literal("office"),
      v.literal("nurse"),
      v.literal("other"),
    ),
    active: v.boolean(), // a peeled-off or retired tag stops working without deletion
    createdAt: v.string(),

    // WAS A PHYSICAL CARD EVER ACTUALLY WRITTEN FOR THIS SLUG.
    //
    // Registering a tag and programming a tag are two different acts, and the
    // programmer deliberately does the first even when the second fails, so an
    // admin who has no reader to hand still keeps the record and the URL. The
    // cost of that kindness was a list that could not tell the difference: a row
    // that had never touched a sticker looked exactly like a row on a wall, and
    // the first anybody learned otherwise was a child holding a phone to a blank
    // card. Optional, because every tag registered before this existed predates
    // the answer and absent means "nobody knows", not "no".
    writtenAt: v.optional(v.string()),

    // Denormalized "when did anybody last tap this", updated by hallPasses.tap.
    //
    // Replaces deriving it by scanning the newest 2,000 tapEvents. That window
    // was a correctness bug with a flood attached: any student could write 2,000
    // events at one slug and push every other tag out of it, at which point the
    // tag-health screen reported every sticker in the building as never tapped,
    // which reads as the app being broken and gets the feature switched off. A
    // column on the row cannot be crowded out by another row.
    lastTapAt: v.optional(v.string()),

    // WHICH CLASSROOM THIS TAG IS, when it is one. Both OPTIONAL, and an
    // unassigned tag behaves exactly as it did before they existed.
    //
    // WHY THEY ARE HERE. A hall pass now originates from the section a student
    // is scheduled into, not from a room they picked off a list, so the return
    // tap has to land at that section's own room. Nothing in PowerSchool can
    // supply it: Sections.Room is not in the plugin manifest and psRoster has no
    // location column at all, which is the gap tapLocations.listForStudents has
    // been stating in `classroomsFromSchedule` since it was written. So the join
    // is app-owned, typed in on the tag screen, exactly like the slug is.
    //
    // sectionId is the precise answer and teacherEmail the useful one: most
    // teachers have one room and every section they teach meets in it. Both are
    // consulted in that order by pickClassroomTag, and two tags claiming the
    // same section or teacher are REFUSED rather than resolved, because
    // "whichever came back first" is not a room.
    sectionId: v.optional(v.string()),
    teacherEmail: v.optional(v.string()), // normalized, joins to teachers.email
  })
    .index("by_slug", ["slug"])
    // Both exist so resolving "the classroom tag for this section" is two
    // bounded indexed reads rather than a scan of every tag in the building on
    // every pass request.
    .index("by_sectionId", ["sectionId"])
    .index("by_teacherEmail", ["teacherEmail"])
    // Exists so the student-facing picker (tapLocations.listForStudents) can be
    // an indexed, bounded read. A signed-in child can call that in a loop, and
    // the staff `list` above collects the whole table plus 2,000 tap events,
    // which is fine for a teacher opening a screen and not fine as something
    // anyone with a Chromebook can spin.
    .index("by_active", ["active"]),

  hallPasses: defineTable({
    studentId: v.id("students"),
    studentNumber: v.optional(v.string()),
    originLocationId: v.id("tapLocations"),
    destinationLocationId: v.optional(v.id("tapLocations")),

    state: v.union(
      v.literal("requested"),
      v.literal("active"),
      v.literal("out"),
      v.literal("returned"),
      v.literal("denied"),
      v.literal("cancelled"),
      v.literal("expired"),
    ),

    reason: v.optional(v.string()),
    requestedAt: v.string(),
    approvedAt: v.optional(v.string()),
    approvedByEmail: v.optional(v.string()),
    outAt: v.optional(v.string()),
    returnedAt: v.optional(v.string()),

    // Closed WITHOUT a return tap, by a staff member or by the expiry sweep.
    //
    // A separate field from returnedAt, deliberately. returnedAt means a tag was
    // tapped in the room of origin, and that tap is the only thing this record
    // is evidence of. Writing it on a human's say-so would mix a measurement
    // with an assertion in one column, permanently and undetectably.
    //
    // closedByEmail is absent when the nightly sweep did it, present when a
    // person did, so "who ended this" is always answerable.
    closedAt: v.optional(v.string()),
    closedByEmail: v.optional(v.string()),
    closedReason: v.optional(v.string()),

    // WHERE THE REQUEST WAS ROUTED, and how that was decided.
    //
    // A pass used to know only a room. It now knows the SECTION the student was
    // scheduled into at the moment they asked, which is what makes "that
    // teacher receives the request" expressible at all. Every one of these is
    // optional because passes written before this existed do not have them, and
    // because a staff-opened pass legitimately has no section.
    //
    // originTeacherEmail is the routing key: hallPasses.myClassBoard reads it.
    // It is stored on the pass rather than re-derived on every read, because the
    // timetable changes and the record has to keep saying who was asked at the
    // time. Re-deriving would silently rewrite history every time a schedule was
    // edited.
    originSectionId: v.optional(v.string()),
    originTeacherEmail: v.optional(v.string()), // normalized
    originPeriod: v.optional(v.string()),
    originCourseName: v.optional(v.string()),

    // How this pass came to exist. Kept because the three paths carry different
    // weight as evidence: a pass the app routed from a timetable, a pass a
    // teacher opened for a named student, and a pass a staff member opened by
    // naming a room are not the same claim about what happened.
    requestedVia: v.optional(
      v.union(
        v.literal("student-schedule"),
        v.literal("teacher"),
        v.literal("staff-manual"),
      ),
    ),

    // WHERE THE TEACHER SAID TO GO, which is NOT where the student tapped.
    //
    // A separate field from destinationLocationId for the same reason closedAt
    // is separate from returnedAt: one is somebody's instruction and the other
    // is a measurement. Folding them together would make "went where they were
    // sent" and "went somewhere else" indistinguishable after the fact, and the
    // second one is the interesting one.
    //
    // When set, applyTap requires the first tap to be at THIS tag: that is what
    // "tap the destination tag to validate the pass" means. Unset, any tag other
    // than the origin is accepted, exactly as before.
    assignedDestinationLocationId: v.optional(v.id("tapLocations")),

    // The RETURN-leg window: minutes from the destination tap before an
    // un-returned pass is overdue. See hallPassRules.ts.
    expiresAfterMinutes: v.number(),
    // The REACH-leg window: minutes from approval to tap the destination.
    // Optional so rows written before the two-phase timer keep their original
    // single-window timing (they fall back to expiresAfterMinutes).
    reachMinutes: v.optional(v.number()),
    // Staff cleared the time limit: the pass stays live and closeable but is
    // never overdue and never swept. Set by clearTimer, unset by resetTimer.
    timerCleared: v.optional(v.boolean()),
  })
    .index("by_student", ["studentId"])
    .index("by_state", ["state"])
    // The teacher's own board. Without it, showing one teacher their own
    // requests means reading every live pass in the school and filtering in
    // JavaScript, which is the exact shape liveBoard had to be rescued from.
    .index("by_originTeacherEmail", ["originTeacherEmail"]),

  /**
   * WHEN THE BELLS RING. App-owned configuration, typed in by an admin.
   *
   * NOT SIS DATA, AND IT CANNOT BE. The PowerSchool plugin manifest grants
   * Sections, CC, Courses, Teachers, Terms, Users, Students, Attendance and
   * PGFinalGrades. There is no Period table, no BellSchedule table, and no
   * Sections.Room. `Sections.Expression` carries the period number and the
   * cycle days ("1(A-E)") and never a clock time. So the mapping from a wall
   * clock to a period exists nowhere we can read it, and the only honest source
   * is a person typing it in, exactly as the tap locations are.
   *
   * MORE THAN ONE, because every school has a minimum day and an assembly day,
   * and running an assembly on the regular bells routes every request one period
   * out with nothing on screen to show it.
   *
   * Times are minutes after LOCAL midnight, integers. Not "08:15" strings:
   * every question asked of this table is arithmetic, and doing arithmetic on
   * strings is how a schedule ends up an hour out. The string form exists only
   * at the edges, in scheduleRules.parseClock and formatClock.
   */
  bellSchedules: defineTable({
    name: v.string(), // "Regular", "Minimum day", "Assembly"
    periods: v.array(
      v.object({
        label: v.string(), // matched against Sections.Expression, so "1" not "Period 1"
        startMinute: v.number(),
        endMinute: v.number(),
      }),
    ),
    // 0 Sunday .. 6 Saturday. Empty means every day, which is only ever what
    // somebody means for a schedule that is chosen explicitly per date.
    weekdays: v.array(v.number()),
    active: v.boolean(), // retired rather than deleted, like a tag
    createdAt: v.string(),
    updatedAt: v.string(),
    updatedByEmail: v.optional(v.string()),
  }).index("by_name", ["name"]),

  /**
   * WHICH SCHEDULE A PARTICULAR DAY RUNS ON. One row per marked date.
   *
   * AN EXPLICIT CHOICE, NEVER AN INFERENCE. Nothing in any table says today is
   * an assembly day. Guessing produces a guessed period, a guessed teacher, and
   * a hall pass in a child's record signed by somebody who never saw them.
   *
   * `noSchool` is a first class answer rather than the absence of a row: a
   * holiday and a day nobody has got round to marking are different facts, and
   * only one of them should stop a student asking.
   *
   * `cycleDay` lives here because it is the same kind of fact: `1(A-E)` is only
   * ambiguous when a section does NOT meet on every day of the cycle, and then
   * the only thing that resolves it is somebody saying which letter today is.
   * Absent, resolveCurrentSection refuses rather than picking.
   */
  bellScheduleDays: defineTable({
    date: v.string(), // YYYY-MM-DD in the school's own time zone
    scheduleId: v.optional(v.id("bellSchedules")),
    noSchool: v.boolean(),
    cycleDay: v.optional(v.string()), // "A".."E", uppercased
    note: v.optional(v.string()),
    setByEmail: v.optional(v.string()),
    setAt: v.string(),
  }).index("by_date", ["date"]),

  /**
   * The one row of bell settings that is not a schedule: the school's time zone,
   * which schedule is the usual one, and the school's own day cycle.
   *
   * THE TIME ZONE IS A SETTING AND HAS NO DEFAULT HERE. Timestamps are stored as
   * UTC and the school is not in UTC, so without it every period boundary is out
   * by seven or eight hours; with a hard-coded offset instead of a zone name it
   * is out by an hour for half the year, which is the version that survives
   * testing in September and starts routing to the wrong teacher in November.
   * With no row at all the app says it cannot tell the time here, which is true.
   *
   * A singleton, keyed like appState so there is exactly one and it is fetched
   * by index rather than by taking the first row of a table that could grow a
   * second one.
   */
  bellSettings: defineTable({
    key: v.string(), // always "bell"
    timeZone: v.string(), // an IANA name, e.g. America/Los_Angeles
    defaultScheduleId: v.optional(v.id("bellSchedules")),
    // The school's full day cycle, e.g. ["A","B","C","D","E"]. Empty means the
    // school has no cycle. This is what turns "(A-E)" from a constraint into no
    // constraint: a section meeting every day of the cycle meets every day.
    cycleDays: v.optional(v.array(v.string())),
    updatedAt: v.string(),
    updatedByEmail: v.optional(v.string()),
  }).index("by_key", ["key"]),

  /**
   * A student's declared intent to tap ONE tag, minted on a user gesture and
   * redeemable once, within two minutes, by that student, at that slug.
   *
   * WHY IT EXISTS. The page fires a tap straight from `?tap=<slug>` in the URL,
   * so a slug on its own was being treated as proof that a body was in a room.
   * That let any student send a classmate a link, or hand them an NFC sticker
   * they encoded themselves, and cause a tap ATTRIBUTED TO THE VICTIM: closing
   * a trip the victim was still on by writing returnedAt, forging their
   * destination, or filing a refused-tap row under their name at a location of
   * the attacker's choosing.
   *
   * The server cannot see a user gesture, so this does not prove one happened.
   * What it proves is that the tap came from a separate authenticated call made
   * by that student's own session moments earlier, for that specific tag. That
   * is what a forwarded link, a replayed link and a reused token cannot supply.
   *
   * Rows are kept after use rather than deleted on redemption: `usedAt` is what
   * makes a second attempt with the same token detectable rather than merely
   * ineffective, and a redeemed intent records which check-in produced which
   * tap. They are purged after a week by hallPasses.expireAbandoned, because one
   * row is minted per press and nothing else would ever remove them; the
   * tapEvents row is the durable record and is untouched.
   */
  tapIntents: defineTable({
    studentId: v.id("students"),
    locationSlug: v.string(),
    // Unguessable, minted server-side. Never derived from anything the client
    // sends, or the client could mint its own.
    token: v.string(),
    createdAt: v.string(),
    expiresAt: v.string(),
    usedAt: v.optional(v.string()),
  })
    .index("by_token", ["token"])
    .index("by_student", ["studentId"]),

  // Every tap, including the ones that were REFUSED.
  //
  // A refused tap is the interesting one: a student tapping the classroom tag
  // on the way out, or tapping a tag with no approved pass, is exactly what a
  // teacher wants to see. Recording only successful taps would erase it.
  tapEvents: defineTable({
    passId: v.optional(v.id("hallPasses")),
    studentId: v.optional(v.id("students")),
    locationSlug: v.string(),
    at: v.string(),
    accepted: v.boolean(),
    outcome: v.string(), // the rule's own reason, verbatim
  })
    .index("by_pass", ["passId"])
    .index("by_student", ["studentId"]),

  appState: defineTable({
    key: v.string(),
    value: v.any(),
    mirroredAt: v.string(),
  }).index("by_key", ["key"]),

  referrals: defineTable({
    studentId: v.optional(v.id("students")),
    payload: v.any(), // same caveat
  }),
});
