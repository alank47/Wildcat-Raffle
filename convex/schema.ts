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
