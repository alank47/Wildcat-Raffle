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
    pbisTickets: v.number(),
    attendanceTickets: v.number(),
    academicTickets: v.number(),
    bigRaffleQualified: v.array(v.string()),
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

  schedules: defineTable({
    label: v.string(),
    payload: v.any(), // shape not yet pinned down; tighten before it carries logic
  }),

  referrals: defineTable({
    studentId: v.optional(v.id("students")),
    payload: v.any(), // same caveat
  }),
});
