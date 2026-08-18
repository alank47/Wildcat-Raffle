import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

/**
 * A TEST hall-pass roster: put one student in one teacher's class every period,
 * so hall-pass requests can be exercised end to end without a live PowerSchool
 * schedule.
 *
 * HOW THE PIECES LINE UP. A pass request resolves the origin teacher by:
 *   now -> bell schedule -> current period label ("1".."6")
 *   -> psRoster rows for the student's email at that period
 *   -> that row's teacherEmail is who approves.
 * So the student needs a psRoster row whose sectionExpression matches the
 * current period. A bare "1".."6" is DEFINITE at that period on ANY cycle day
 * (scheduleRules.classifySection: an unconstrained meeting needs no letter), and
 * one row per period keeps the answer singular. Result: whatever time it is, the
 * student has exactly one class and it is this teacher's.
 *
 * TWO CAVEATS.
 *  1. A TEST account (every roster row carries the TESTROSTER marker) bypasses
 *     the "no current bell period" cutoff in resolveScheduledOrigin: it falls
 *     back to the lowest seeded period so the student can request a pass at any
 *     time, off-hours included. Real students still need a live bell period
 *     (seedBellSchedules:seedWestbrook). This seed also ensures the test teacher
 *     has one classroom tag, without which a request fails at "no classroom tag".
 *  2. psRoster is replaced WHOLESALE by a PowerSchool roster sync, so a sync will
 *     delete these rows. They carry schoolId "TESTROSTER" so this seed only ever
 *     removes its OWN rows (never a real schedule) and can be re-run to restore.
 *
 * Run (prod):
 *   CONVEX_DEPLOY_KEY=... npx convex run seedTestRoster:seedLawrencebTest
 *   CONVEX_DEPLOY_KEY=... npx convex run seedTestRoster:seedLawrencebTest '{"teacherEmail":"exact@address"}'
 * Idempotent: re-running corrects rather than duplicates.
 */

const norm = (s: string) => s.trim().toLowerCase();
const MARKER = "TESTROSTER"; // schoolId tag so we only ever touch our own rows

export const seedLawrencebTest = internalMutation({
  args: {
    studentEmail: v.optional(v.string()),
    teacherEmail: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const studentEmail = norm(args.studentEmail ?? "lb12345@westbrookacademy.org");
    const teacherEmail = norm(args.teacherEmail ?? "lawrenceb@lapromisefund.org");

    // Fail loudly if the teacher address is wrong. A test roster pointed at a
    // teacher the app cannot match to a real sign-in routes every pass into a
    // void , the student would get "waiting for approval" that no one can see.
    const teacher = await ctx.db
      .query("teachers")
      .withIndex("by_email", (q) => q.eq("email", teacherEmail))
      .unique();
    if (!teacher) {
      throw new Error(
        `No teacher record has email "${teacherEmail}". Sign in once as that ` +
        `teacher (which creates/normalises the record), or pass the exact ` +
        `address as teacherEmail. Aborting rather than seeding a roster that ` +
        `points nowhere.`,
      );
    }
    const tParts = String(teacher.name || "").trim().split(/\s+/).filter(Boolean);
    const teacherFirstName = tParts[0] || "Test";
    const teacherLastName = tParts.slice(1).join(" ") || "Teacher";

    // Copy the student's real number/name/grade if the record exists; the join
    // key is the EMAIL, so a placeholder number is harmless when it does not.
    const student = await ctx.db
      .query("students")
      .withIndex("by_email", (q) => q.eq("email", studentEmail))
      .unique();
    const studentNumber = student?.studentNumber || "TEST-LB12345";
    const firstName = student?.firstName || "Test";
    const lastName = student?.lastName || "Student";
    const gradeLevel = student?.grade || "9";

    // Give the student a test meal PIN so the meal card has a barcode to show.
    // Only writes when the record exists (it must, or the student could not load
    // their portal) and only when empty, so a real synced number is never
    // clobbered by the test.
    let mealPin: string | null = student?.mealPin ?? null;
    if (student && !student.mealPin) {
      mealPin = "4821";
      await ctx.db.patch(student._id, { mealPin });
    }

    const now = new Date().toISOString();

    // Idempotent: drop only OUR prior test rows for this student, never a real
    // synced schedule.
    const existing = await ctx.db
      .query("psRoster")
      .withIndex("by_studentEmail", (q) => q.eq("studentEmail", studentEmail))
      .collect();
    let removed = 0;
    for (const r of existing) {
      if (r.schoolId === MARKER) {
        await ctx.db.delete(r._id);
        removed++;
      }
    }

    const periods = ["1", "2", "3", "4", "5", "6"];
    let created = 0;
    for (const p of periods) {
      await ctx.db.insert("psRoster", {
        studentNumber,
        studentEmail,
        firstName,
        lastName,
        gradeLevel,
        sectionId: `TEST-SEC-${p}`,
        sectionNumber: `T${p}`,
        sectionExpression: p, // bare period -> DEFINITE at period p, any cycle day
        courseNumber: `TEST${p}`,
        courseName: `Test Class · Period ${p}`,
        period: p,
        teacherEmail,
        teacherFirstName,
        teacherLastName,
        teacherNumber: teacher.legacyId || "TESTTEACH",
        termId: "TEST",
        termAbbreviation: "TEST",
        schoolId: MARKER,
        syncedAt: now,
      });
      created++;
    }

    // The origin ROOM. A request resolves the teacher from the roster, then the
    // room from a classroom tag tied to that teacher (pickClassroomTag). Without
    // one, every test request fails at "no classroom tag" even with a perfect
    // roster. Ensure exactly one active classroom tag for the test teacher:
    // reuse an existing one so we never create the ambiguity pickClassroomTag
    // refuses, and create the test tag only when the teacher has none.
    const teacherTags = await ctx.db
      .query("tapLocations")
      .withIndex("by_teacherEmail", (q) => q.eq("teacherEmail", teacherEmail))
      .take(8);
    let classroomTag = teacherTags.find((t) => t.active) ?? null;
    let tagCreated = false;
    if (!classroomTag) {
      const slug =
        "test-classroom-" +
        (teacherEmail.split("@")[0] || "teacher").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const bySlug = await ctx.db
        .query("tapLocations")
        .withIndex("by_slug", (q) => q.eq("slug", slug))
        .unique();
      if (bySlug) {
        await ctx.db.patch(bySlug._id, {
          active: true,
          kind: "classroom",
          teacherEmail,
          name: `Test Classroom (${teacher.name})`,
        });
        classroomTag = await ctx.db.get(bySlug._id);
      } else {
        const id = await ctx.db.insert("tapLocations", {
          slug,
          name: `Test Classroom (${teacher.name})`,
          kind: "classroom" as const,
          active: true,
          createdAt: now,
          teacherEmail,
        });
        classroomTag = await ctx.db.get(id);
        tagCreated = true;
      }
    }

    return {
      ok: true,
      studentEmail,
      teacherEmail,
      teacherName: teacher.name,
      studentName: `${firstName} ${lastName}`,
      classroomTag: classroomTag ? { slug: classroomTag.slug, name: classroomTag.name } : null,
      classroomTagCreated: tagCreated,
      mealPin: mealPin,
      mealPinNote: student ? undefined : "No students record matched this email, so no meal PIN was set. The student must sign in once first.",
      removed,
      created,
      note:
        "A PowerSchool roster sync replaces psRoster wholesale and will clear " +
        "these TESTROSTER rows; re-run this to restore. This account bypasses the " +
        "'no current bell period' cutoff, so it can request a pass at any time.",
    };
  },
});

/** Remove the test roster when you are done, so it cannot linger in prod. */
export const clearLawrencebTest = internalMutation({
  args: { studentEmail: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const studentEmail = norm(args.studentEmail ?? "lb12345@westbrookacademy.org");
    const rows = await ctx.db
      .query("psRoster")
      .withIndex("by_studentEmail", (q) => q.eq("studentEmail", studentEmail))
      .collect();
    let removed = 0;
    for (const r of rows) {
      if (r.schoolId === MARKER) {
        await ctx.db.delete(r._id);
        removed++;
      }
    }
    return { studentEmail, removed };
  },
});
