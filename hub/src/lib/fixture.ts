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
 */

export type DemoMode = "panel" | "legacy" | null;

export function demoMode(search: string): DemoMode {
  const value = new URLSearchParams(search).get("demo");
  if (value === "panel" || value === "1" || value === "true") return "panel";
  if (value === "legacy") return "legacy";
  return null;
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

export function fixturePassCard() {
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
    hallPass: { available: false, state: "none" },
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

export function fixtureTapLocations() {
  return {
    locations: [
      { slug: "front-office", name: "Front Office", kind: "office" },
      { slug: "library", name: "Library", kind: "other" },
      { slug: "nurse", name: "Nurse", kind: "nurse" },
      { slug: "restroom-2", name: "Restroom 2 (B Hall)", kind: "restroom" },
      { slug: "room-114", name: "Room 114", kind: "classroom" },
    ],
    classroomsFromSchedule: {
      available: false,
      reason:
        "Classrooms are not listed from your timetable yet. The PowerSchool " +
        "roster does not include a room for each section, so there is nothing " +
        "to match a tag against. Ask your teacher to start the pass if the room " +
        "you are in is not here.",
    },
    truncated: false,
  };
}
