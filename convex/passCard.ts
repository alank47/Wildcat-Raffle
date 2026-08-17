import { query } from "./_generated/server";
import { requireStudentSelf } from "./identity";
import { elapsedMinutes, isOverdue, isTerminal } from "./hallPassRules";
import { bellContext } from "./bellSchedules";
import { mealFromPeriodLabel, mealLabel, formatClock } from "./scheduleRules";

/**
 * Everything the student pass cards need, for the signed-in student only.
 *
 * NO ARGUMENTS. The student is whoever the verified Google token says they are.
 * A function that takes a student id and trusts it is a function that reads any
 * child's record, and a pass card is exactly the screen somebody would try that
 * on.
 *
 * WHAT IS MISSING IS RETURNED AS MISSING, with the reason. A card that renders
 * a blank barcode looks broken; a card that says "your lunch number is not
 * available yet" is a fact a student can act on, and it tells the office what
 * to fix.
 */
/**
 * How many of the student's most recent passes this card reads. Only the live
 * one is wanted, and a live pass blocks every later request, so it is always the
 * newest row; this window is slack, not a requirement.
 */
const PASS_LOOKBACK = 20;

export const mine = query({
  args: {},
  handler: async (ctx) => {
    const student = await requireStudentSelf(ctx);
    const now = new Date().toISOString();

    // The current meal, read off the running bell schedule so it always agrees
    // with the day the office actually set. A period whose label names a meal
    // (Breakfast / Nutrition / Lunch) IS that meal; a class or a between-periods
    // gap is no meal, and the card then simply shows the barcode with no "now".
    const bells = await bellContext(ctx, now);
    const currentPeriodLabel = bells.ok && bells.period ? bells.period.label : null;
    const mealKind = mealFromPeriodLabel(currentPeriodLabel);
    const currentMeal =
      mealKind && bells.ok && bells.period
        ? {
            kind: mealKind,
            label: mealLabel(mealKind),
            startsAt: formatClock(bells.period.startMinute),
            endsAt: formatClock(bells.period.endMinute),
          }
        : null;

    // The newest few, never the whole history. This card is polled by every
    // signed-in student's browser, and an unbounded collect() here reads a
    // student's entire record on every poll, growing for as long as they attend
    // the school, until it crosses Convex's 4,096-read ceiling and the card stops
    // rendering. Only the live pass is wanted, and a live pass blocks every later
    // request, so it is always among the newest rows.
    const passes = await ctx.db
      .query("hallPasses")
      .withIndex("by_student", (q) => q.eq("studentId", student._id))
      .order("desc")
      .take(PASS_LOOKBACK);

    // isTerminal owns the list of states a pass stops at. Inlining it here made
    // this the third copy, and a copy is a state the machine knows about and
    // this screen does not.
    const live = passes.find((p) => !isTerminal(p.state));

    // The two rooms this pass names, resolved to names a person can read. A
    // slug is a database key, and printing one at a student is the same mistake
    // as printing a row id. Two gets at most, only when there is a live pass, so
    // the polling cost of this card is unchanged for the students who have none.
    const originRoom = live ? await ctx.db.get(live.originLocationId) : null;
    const sentTo = live?.assignedDestinationLocationId
      ? await ctx.db.get(live.assignedDestinationLocationId)
      : null;

    // The teacher the request was ROUTED TO, resolved from the address stored on
    // the pass rather than from the student's timetable. The timetable says who
    // they are with now; the pass has to keep saying who was actually asked,
    // which is a different question the moment the bell goes.
    //
    // .first() rather than .unique(): a duplicate staff row is a data fault, and
    // .unique() answers a data fault by throwing a plain Error, which Convex
    // redacts to "Server Error". That would take the student's whole card down,
    // every panel, over two rows in the teachers table.
    const routedTo = live?.originTeacherEmail
      ? await ctx.db
          .query("teachers")
          .withIndex("by_email", (q) => q.eq("email", live.originTeacherEmail!))
          .first()
      : null;

    return {
      student: {
        firstName: student.firstName,
        lastName: student.lastName,
        grade: student.grade,
        studentNumber: student.studentNumber ?? null,
        email: student.email ?? null,
      },

      // Card 1. The student number is the barcode payload. It exists for every
      // enrolled student and is what most scanners here already expect.
      studentId: {
        available: Boolean(student.studentNumber),
        value: student.studentNumber ?? null,
        format: "code128",
      },

      // Card 2. The MEAL card: the cafeteria barcode (a DIFFERENT number from
      // the student number, used by nutrition services) plus which meal is
      // happening right now, read from the bell schedule. `meal` supersedes the
      // old static `lunchId`; `lunchId` stays as a mirror for one release so an
      // un-refreshed client does not render a blank card.
      meal: {
        available: Boolean(student.mealPin),
        value: student.mealPin ?? null,
        format: "code128",
        currentMeal,
        reason: student.mealPin
          ? null
          : "Meal numbers are not synced yet. The field exists in PowerSchool " +
            "(STUDENTS.LUNCH_ID) and needs one line added to the plugin's access request.",
      },
      lunchId: {
        available: Boolean(student.mealPin),
        value: student.mealPin ?? null,
        format: "code128",
        reason: student.mealPin
          ? null
          : "Lunch numbers are not synced yet. The field exists in PowerSchool " +
            "and needs one line added to the plugin's access request.",
      },

      // Card 3. Clever badges are QR codes, but whether this district issues a
      // static per-student badge or a rotating one decides whether a payload may
      // be stored at all. Unanswered, so nothing is invented.
      cleverBadge: {
        available: false,
        value: null,
        format: "qr",
        reason:
          "Clever badge sign in is not connected yet. Whether the badge is " +
          "static or rotating decides how it can be shown.",
      },

      // Card 4. The live one.
      hallPass: live
        ? {
            available: true,
            id: live._id,
            state: live.state,
            elapsedMinutes: elapsedMinutes(live as any, now),
            overdue: isOverdue(live as any, now),
            expiresAfterMinutes: live.expiresAfterMinutes,

            // WHERE IT STARTED AND WHO IT WENT TO, in words. The pass now
            // originates from the class the student was timetabled into, so the
            // card has to be able to say "waiting on Ms Vega, period 3" rather
            // than "waiting". A student who cannot see who was asked cannot tell
            // a request that went to the right teacher from one that did not.
            //
            // Read off the pass, never re-derived from the timetable: the class
            // they are in changes every hour, and the card must keep naming the
            // teacher who was actually asked.
            origin: originRoom?.name ?? null,
            // Null, never the raw address. A student does not need their
            // teacher's email and should not be handed one by a card.
            teacherName: routedTo?.name ?? null,
            period: live.originPeriod ?? null,
            courseName: live.originCourseName ?? null,

            // Where a TEACHER sent them, when a teacher opened this pass. This
            // is the tag that validates it, so the card has to name it: "tap the
            // tag at the office" is actionable and "tap the tag" is not.
            sentTo: sentTo?.name ?? null,
            requestedVia: live.requestedVia ?? null,
          }
        : { available: false, state: "none" },

      serverTime: now,
    };
  },
});
