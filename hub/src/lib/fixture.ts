/**
 * A fixture, used for ONE thing: rendering the screens when a real sign-in
 * cannot be completed (Google's chooser needs a human, and Vite's dev origin is
 * not an authorized one).
 *
 * It is never a silent fallback. It is reached only by ?demo=panel or
 * ?demo=legacy in the URL, and every screen carries a banner saying the data is
 * not real, because the one thing worse than an empty panel is a convincing
 * wrong one.
 *
 *   ?demo=panel   the shape THIS BRANCH returns  ({available, reason, courses})
 *   ?demo=legacy  the shape PRODUCTION returns   (bare arrays)
 *
 * Both exist so the two-shape handling in shapes.ts is something you can look at
 * on screen rather than something a comment claims.
 *
 *   ?pass=<code>  which hall-pass situation to draw, on top of either mode.
 *                 `waiting`, `active`, `overdue` and `teacher` are live passes;
 *                 `redacted` is a failed read rather than a returned refusal;
 *                 every other name is one of the server's refusal codes, listed
 *                 in NO_CLASS below. Unknown names draw the ordinary case.
 */

export type DemoMode = "panel" | "legacy" | null;

export function demoMode(search: string): DemoMode {
  const value = new URLSearchParams(search).get("demo");
  if (value === "panel" || value === "1" || value === "true") return "panel";
  if (value === "legacy") return "legacy";
  return null;
}

/**
 * `?pass=<name>` — which sample hall-pass situation to render.
 *
 * Everything the hall pass screen can show is decided by the server, and most
 * of it cannot be reached on demand: `no-school-today` needs a holiday,
 * `day-not-covered` needs a Saturday, `bad-timezone` needs a broken setting,
 * and the ones that matter most are the ones nobody sees until a child is stuck
 * in a corridor with a phone. Naming the state is the only way to review it.
 *
 * Returns the raw string. It is looked up in the tables below and an unknown
 * one falls through to the ordinary "you are in Biology" case, so a typo can
 * never invent a state the app does not have.
 */
export function passScenario(search: string): string | null {
  return new URLSearchParams(search).get("pass");
}

const CLASSES = [
  {
    courseName: "Algebra I",
    courseNumber: "MAT101",
    period: "1(A-E)",
    teacher: "R. Alvarez",
    term: "S1",
  },
  {
    courseName: "English 9",
    courseNumber: "ENG901",
    period: "2(A-E)",
    teacher: "D. Okafor",
    term: "S1",
  },
  {
    courseName: "Biology",
    courseNumber: "SCI210",
    period: "3(A-E)",
    teacher: "M. Whitfield",
    term: "S1",
  },
  {
    courseName: "World History",
    courseNumber: "SOC120",
    period: "4(A-E)",
    teacher: "J. Prieto",
    term: "S1",
  },
  {
    courseName: "Studio Art",
    courseNumber: "ART140",
    period: "6(A-E)",
    teacher: "L. Nakamura",
    term: "S1",
  },
  {
    courseName: "Physical Education",
    courseNumber: "PE100",
    period: "7(A-E)",
    teacher: "C. Boone",
    term: "S1",
  },
];

const GRADES = [
  {
    courseName: "Algebra I",
    courseNumber: "MAT101",
    currentGrade: "B+",
    currentPercent: 88.4,
    available: true,
  },
  {
    courseName: "English 9",
    courseNumber: "ENG901",
    currentGrade: "A-",
    currentPercent: 91,
    available: true,
  },
  {
    courseName: "Biology",
    courseNumber: "SCI210",
    currentGrade: "B",
    currentPercent: 84.2,
    available: true,
  },
  {
    courseName: "World History",
    courseNumber: "SOC120",
    currentGrade: "A",
    currentPercent: 95.6,
    available: true,
  },
  {
    // The row that matters: a section created but never graded. It must NOT
    // render as an F, a 0, or an empty box.
    courseName: "Studio Art",
    courseNumber: "ART140",
    currentGrade: null,
    currentPercent: null,
    available: false,
  },
  {
    courseName: "Physical Education",
    courseNumber: "PE100",
    currentGrade: "A",
    currentPercent: 99,
    available: true,
  },
];

export function fixtureMe() {
  return {
    kind: "student",
    email: "sample.student@westbrookacademy.org",
    firstName: "Jordan",
    lastName: "Reyes",
    gradeLevel: "9",
    hasAppRecord: true,
    schedule: CLASSES,
    tickets: { pbis: 34, attendance: 18, academic: 22, total: 74 },
  };
}

/**
 * The sample live passes, keyed by `?pass=`.
 *
 * Same allowlist of fields `passCard:mine` sends, in the same shapes, including
 * the ones that are null. `elapsedMinutes: null` on a request nobody has
 * answered is not an oversight: the server returns null until the pass is
 * approved, because a request sitting in a queue is not time out of class, and
 * the screen has to be looked at with that null in place.
 */
const LIVE_PASSES: Record<string, Record<string, unknown>> = {
  waiting: {
    available: true,
    id: "sample-pass-requested",
    state: "requested",
    elapsedMinutes: null,
    overdue: false,
    expiresAfterMinutes: 10,
    origin: "Room 114",
    teacherName: "M. Whitfield",
    period: "3",
    courseName: "Biology",
    sentTo: null,
    requestedVia: "student-schedule",
  },
  active: {
    available: true,
    id: "sample-pass-active",
    state: "active",
    elapsedMinutes: 4,
    overdue: false,
    expiresAfterMinutes: 10,
    origin: "Room 114",
    teacherName: "M. Whitfield",
    period: "3",
    courseName: "Biology",
    sentTo: null,
    requestedVia: "student-schedule",
  },
  overdue: {
    available: true,
    id: "sample-pass-overdue",
    state: "out",
    elapsedMinutes: 17,
    overdue: true,
    expiresAfterMinutes: 10,
    origin: "Room 114",
    teacherName: "M. Whitfield",
    period: "3",
    courseName: "Biology",
    sentTo: null,
    requestedVia: "student-schedule",
  },
  // A pass a TEACHER opened. It is already active — the teacher's action was
  // the approval — and it names where the student was sent, which is the tag
  // they have to reach first before the classroom tag will close it.
  teacher: {
    available: true,
    id: "sample-pass-teacher",
    state: "active",
    elapsedMinutes: 2,
    overdue: false,
    expiresAfterMinutes: 15,
    origin: "Room 114",
    teacherName: "M. Whitfield",
    period: "3",
    courseName: "Biology",
    sentTo: "Front Office",
    requestedVia: "teacher",
  },
};

export function fixturePassCard(scenario: string | null = null) {
  const live = scenario ? LIVE_PASSES[scenario] : undefined;
  return {
    student: {
      firstName: "Jordan",
      lastName: "Reyes",
      grade: 9,
      studentNumber: "12217",
      email: "sample.student@westbrookacademy.org",
    },
    studentId: { available: true, value: "12217", format: "code128" },
    lunchId: {
      available: false,
      value: null,
      format: "code128",
      reason:
        "Lunch numbers are not synced yet. The field exists in PowerSchool and " +
        "needs one line added to the plugin's access request.",
    },
    cleverBadge: {
      available: false,
      value: null,
      format: "qr",
      reason:
        "Clever badge sign in is not connected yet. Whether the badge is static " +
        "or rotating decides how it can be shown.",
    },
    hallPass: live ?? { available: false, state: "none" },
    serverTime: new Date().toISOString(),
  };
}

export function fixtureStudentView(mode: Exclude<DemoMode, null>) {
  const base = {
    name: "Jordan Reyes",
    grade: 9,
    points: {
      pbis: 34,
      attendance: 18,
      academic: 22,
      total: 74,
      weeksQualified: 6,
      bigRaffleEntries: 3,
    },
    wildcatCash: { balance: 1265, earned: 2140, spent: 875 },
    attendance: {
      available: true,
      reason: null,
      daysAbsentTerm: 2,
      daysAbsentYtd: 5,
      daysTardyTerm: 1,
    },
    dataAsOf: new Date(Date.now() - 3 * 3600 * 1000).toISOString(),
  };

  if (mode === "legacy") {
    // EXACTLY what the deployed backend sends: bare arrays, no availability
    // flag, no reason.
    return { ...base, grades: GRADES, schedule: CLASSES };
  }

  return {
    ...base,
    grades: { available: true, reason: null, courses: GRADES },
    schedule: { available: true, reason: null, classes: CLASSES },
  };
}

/**
 * EVERY WAY `hallPasses:myCurrentClass` CAN SAY NO, with the server's own words.
 *
 * These sentences are copied verbatim from convex/scheduleRules.ts,
 * convex/bellSchedules.ts, convex/studentPortalRules.ts and
 * convex/hallPasses.ts. That is a duplication, and it is deliberate and
 * contained: this file is sample data, the screen it feeds carries a banner
 * saying so, and nothing in the real path reads a word of it — the live screen
 * prints whatever the server sent, whether or not it appears here. It exists so
 * that "the refusal is rendered as the server's sentence" is something you can
 * put on screen at any width instead of something a comment claims.
 *
 * The three placeholders the server fills from real settings — a schedule name,
 * a period number, a clock time — are filled here with the fixture's own
 * timetable, so the sample reads like one school rather than three.
 *
 * If a code is added server-side and not added here, the only consequence is
 * that it cannot be previewed. The live screen renders an unknown code by
 * printing its reason, which is the whole contract.
 */
const NO_CLASS: Record<string, string> = {
  // bellSchedules.bellContext — the app has not been set up
  "not-configured":
    "The bell schedule has not been set up yet, so the app cannot tell which " +
    "class you are in. An admin sets it in Settings > Bell Schedule.",
  "no-timezone":
    "No school time zone is set, so the app cannot tell what time it is here. " +
    "An admin sets it in Settings > Bell Schedule.",
  "bad-timezone":
    '"America/Los_Angles" is not a time zone this app can read. Use a name ' +
    "like America/Los_Angeles, in Settings > Bell Schedule.",
  "unreadable-clock":
    "The server could not read the current time, so no period can be worked out.",

  // scheduleRules.scheduleForDay — which schedule today runs on
  "no-school-today":
    "Today is marked as a day with no classes, so there is no teacher to send " +
    "a pass request to.",
  "missing-schedule":
    "Today is set to a bell schedule that no longer exists. An admin fixes it " +
    "in Settings > Bell Schedule.",
  "no-schedule-today":
    "No bell schedule has been chosen for today, so the app cannot tell which " +
    "class you are in. An admin sets the usual schedule in Settings > Bell " +
    "Schedule.",

  // scheduleRules.periodAt — where the clock is standing
  "no-schedule":
    "No bell schedule is set up, so the app cannot tell which class you are " +
    "in. An admin adds one in Settings > Bell Schedule.",
  "day-not-covered":
    "Today is not a day the Regular Day schedule covers, so there is no class " +
    "period to send this to.",
  "before-school":
    "The school day has not started yet. The first period begins at 08:15.",
  "after-school": "The school day is over. The last period ended at 15:10.",
  "between-periods":
    "You are between periods right now, so there is no class to send this to. " +
    "Ask a teacher to start the pass for you.",

  // hallPasses.resolveScheduledOrigin — the student's own record
  "no-student-email":
    "Your school email is not on your student record yet, so your class " +
    "schedule cannot be looked up. The office can add it in PowerSchool under " +
    "Student Profile > Email.",
  "no-timetable":
    "There is no class timetable on your account yet, so the app cannot tell " +
    "whose room you are in. Ask a teacher to start the pass for you.",

  // scheduleRules.resolveCurrentSection — which section, out of the timetable
  "no-period": "No period was worked out, so there is no class to send this to.",
  "no-class-this-period":
    "Your timetable does not show a class in period 5 right now. Ask a teacher " +
    "to start the pass for you.",
  "unknown-cycle-day":
    "Your period 3 class only meets on certain days of the cycle, and today's " +
    "cycle day has not been set in the app. Ask a teacher to start the pass " +
    "for you.",
  "ambiguous-section":
    "Your timetable shows more than one class in period 3 right now, so the " +
    "app cannot tell whose room you are in. Ask a teacher to start the pass " +
    "for you.",
  "no-teacher-for-section":
    "Your period 3 class has no teacher email on file, so there is nobody to " +
    "send this to. Ask a teacher to start the pass for you.",

  // scheduleRules.pickClassroomTag — the wall tag the pass closes at
  "ambiguous-classroom-tag":
    "More than one wall tag is registered to this class, so the app cannot " +
    "tell which one ends the pass. An admin fixes it in Settings > NFC Tags.",
  "no-classroom-tag":
    "There is no wall tag registered for this classroom yet, and the pass has " +
    "to be tapped back in somewhere. Ask your teacher to start the pass, and " +
    "ask an admin to register the room's tag.",
};

/**
 * `?pass=redacted` — the failure the deployed backend actually produces today.
 *
 * Probed while writing this: `hallPasses:myCurrentClass`, `requestMine` and
 * `tapLocations:listForStudents` all answer on quick-cassowary-644 with
 * `{"status":"error","errorMessage":"[Request ID: ...] Server Error"}` and NO
 * errorData, which is what Convex sends for a function that threw a plain Error
 * AND for a function that is not deployed at all — indistinguishable from a
 * browser. `passCard:mine` answers "Not authenticated." on the same call, so
 * the student half of the hall pass path is simply not on production yet.
 *
 * A signed-in student would therefore land on this branch, and it is the one
 * where the app has nothing to tell them: no sentence, no field to fix, just an
 * id. So it is also the branch most worth being able to look at.
 */
export const FIXTURE_REDACTED = {
  message:
    "The school server could not answer this, and the reason was hidden " +
    "before it reached your screen. Nothing here means your record is empty. " +
    "Show the office this reference: bf166b1264b7be84.",
  requestId: "bf166b1264b7be84",
};

/**
 * The class this sample student is sitting in, or the sample refusal.
 *
 * The available case matches the fixture timetable: period 3 is Biology with
 * M. Whitfield, and Room 114 is the wall tag registered to that section.
 * A `?pass=` naming a live pass falls through to the available class, because
 * the two are independent — the server keeps answering "you are in Biology"
 * while a pass is open, and the screen just has something more urgent to show.
 */
export function fixtureCurrentClass(scenario: string | null = null) {
  const reason = scenario ? NO_CLASS[scenario] : undefined;
  const serverTime = new Date().toISOString();

  if (reason) {
    return {
      available: false,
      code: scenario,
      reason,
      teacherName: null,
      courseName: null,
      period: null,
      room: null,
      serverTime,
    };
  }

  return {
    available: true,
    code: "ok",
    reason: "",
    teacherName: "M. Whitfield",
    courseName: "Biology",
    period: "3",
    room: "Room 114",
    serverTime,
  };
}
