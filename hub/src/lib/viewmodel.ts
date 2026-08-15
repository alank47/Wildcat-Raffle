import { useMemo } from "react";
import { useSession, type Async } from "./session";
import {
  count,
  money,
  str,
  toPanel,
  toSlot,
  type ClassRow,
  type GradeCell,
  type Panel,
} from "./shapes";

/**
 * THE SEAM.
 *
 * Everything in this file is plain data derived from what the four Convex
 * queries returned. Nothing here imports React Bits, renders anything, or knows
 * what a card looks like. Every route is then two pieces:
 *
 *     useXModel()      reads the session, normalises the wire shapes,
 *                      decides what is missing and what the words for that are
 *     <XView model />  draws it
 *
 * That split exists for one concrete reason. React Bits Pro has been bought and
 * the licence key is not here yet, so the Pro blocks that would replace the
 * wallet, the two lists and the stepper cannot be installed. When the key
 * arrives, a swap has to be replacing ONE presentational component that takes a
 * model — not re-deriving `hallPass.available` inside somebody else's block and
 * getting it subtly wrong. See PRO-SWAP.md.
 *
 * The models carry `null` for absence and a `reason` sentence beside it. They
 * never carry 0 for "we do not know", so a block that renders a model
 * faithfully cannot invent a value; the worst it can do is fail to render one,
 * which is visible. That property is the whole point and it is the thing to
 * check after any swap.
 */

/* ------------------------------------------------------------------
   Shared
   ------------------------------------------------------------------ */

/** A figure and the words to print when the school has not sent one. */
export type StatModel = {
  /** Arrival key. Unique app-wide; see lib/arrive.ts. */
  id: string;
  label: string;
  value: number | null;
  missing: string;
  suffix?: string;
};

export type Provenance = {
  dataAsOf: string | null;
  panel?: Panel<unknown>;
  extra?: string;
};

/* ------------------------------------------------------------------
   Cards
   ------------------------------------------------------------------ */

export type CardBody =
  | { kind: "barcode"; value: string; glare: boolean }
  | {
      kind: "cash";
      balance: number;
      earned: number | null;
      spent: number | null;
    }
  | { kind: "pass"; open: boolean; overdue: boolean; elapsed: number | null }
  | { kind: "missing"; reason: string | null };

export type WalletCard = {
  key: string;
  /** Label on the selector chip under the stack. */
  chip: string;
  /** Label printed on the card face. */
  label: string;
  /** Face colour. School palette only. */
  tint: string;
  body: CardBody;
  /** The ID card's printed block: name, school, grade. */
  identity?: { name: string; school: string; grade: string } | null;
};

export type WalletModel = {
  cards: WalletCard[];
  /** Which card starts frontmost. */
  initialTop: string;
};

export type LivePassSummary = {
  overdue: boolean;
  elapsed: number | null;
  limit: number | null;
};

export type CardsModel = {
  greeting: string;
  meta: string;
  livePass: LivePassSummary | null;
  wallet: Async<WalletModel>;
  totals: Async<{
    tickets: StatModel[];
    ticketsNote: string;
    attendance:
      | { available: false; reason: string | null }
      | { available: true; stats: StatModel[] };
    provenance: Provenance;
  }>;
  /** When the card data was last confirmed with the server. */
  checkedAt: string | null;
};

export function useCardsModel(): CardsModel {
  const { me, passCard, studentView } = useSession();

  return useMemo(() => {
    const firstName = (me.state === "ok" ? str(me.data.firstName) : null) ?? "Wildcat";
    const grade = me.state === "ok" ? str(me.data.gradeLevel) : null;

    const pass = passCard.state === "ok" ? passCard.data : null;
    const student = (pass?.student ?? {}) as Record<string, unknown>;
    const hp = (pass?.hallPass ?? {}) as Record<string, unknown>;

    const number = str(student.studentNumber);
    const metaBits = [
      grade ? `Grade ${grade}` : null,
      number ? `Student ${number}` : null,
    ].filter(Boolean) as string[];

    const livePass: LivePassSummary | null =
      hp.available === true
        ? {
            overdue: hp.overdue === true,
            elapsed: count(hp.elapsedMinutes),
            limit: count(hp.expiresAfterMinutes),
          }
        : null;

    const cash =
      studentView.state === "ok"
        ? (studentView.data.wildcatCash as Record<string, unknown> | undefined)
        : undefined;

    const wallet: Async<WalletModel> =
      passCard.state === "ok"
        ? { state: "ok", data: buildWallet(pass!, student, hp, cash) }
        : passCard;

    const totals: CardsModel["totals"] =
      studentView.state === "ok"
        ? { state: "ok", data: buildTotals(studentView.data) }
        : studentView;

    return {
      greeting: `Hi, ${firstName}`,
      meta: metaBits.length ? metaBits.join("  ·  ") : "Westbrook Academy",
      livePass,
      wallet,
      totals,
      checkedAt: pass ? str(pass.serverTime) : null,
    };
  }, [me, passCard, studentView]);
}

function buildWallet(
  pass: Record<string, unknown>,
  student: Record<string, unknown>,
  hp: Record<string, unknown>,
  cash: Record<string, unknown> | undefined,
): WalletModel {
  const studentId = toSlot(pass.studentId, "student number");
  const lunchId = toSlot(pass.lunchId, "lunch number");
  const clever = toSlot(pass.cleverBadge, "Clever badge");
  const balance = money(cash?.balance);

  const name = [str(student.firstName), str(student.lastName)]
    .filter(Boolean)
    .join(" ");

  // `students.grade` is a number on some records and a string on others,
  // depending on which sync wrote it. Both are accepted; neither is coerced
  // into a made-up value.
  const gradeNumber = count(student.grade);
  const gradeText =
    gradeNumber !== null ? String(gradeNumber) : (str(student.grade) ?? "—");

  const cards: WalletCard[] = [
    {
      key: "clever",
      chip: "Clever",
      label: "Clever badge",
      tint: "#1B1D24",
      body: { kind: "missing", reason: clever.reason },
    },
    {
      key: "lunch",
      chip: "Lunch",
      label: "Lunch number",
      tint: "#1B1D24",
      body:
        lunchId.available && lunchId.value
          ? { kind: "barcode", value: lunchId.value, glare: false }
          : { kind: "missing", reason: lunchId.reason },
    },
    {
      key: "pass",
      chip: "Hall pass",
      label: "Hall pass",
      tint: "#24517F",
      body: {
        kind: "pass",
        open: hp.available === true,
        overdue: hp.overdue === true,
        elapsed: count(hp.elapsedMinutes),
      },
    },
    {
      key: "cash",
      chip: "Cash",
      label: "Wildcat Cash",
      tint: "#1A2E1F",
      body:
        balance === null
          ? {
              kind: "missing",
              reason:
                "Your Wildcat Cash balance is not on your record yet. It is " +
                "not zero — nobody has told the app what it is. The front " +
                "office can check.",
            }
          : {
              kind: "cash",
              balance: Math.max(0, Math.round(balance)),
              earned: money(cash?.earned),
              spent: money(cash?.spent),
            },
    },
    {
      key: "id",
      chip: "Student ID",
      label: "Student ID",
      tint: "#0C447C",
      identity: {
        name,
        school: "Westbrook Academy",
        grade: gradeText,
      },
      body:
        studentId.available && studentId.value
          ? { kind: "barcode", value: studentId.value, glare: true }
          : { kind: "missing", reason: studentId.reason },
    },
  ];

  // The ID starts on top: it is the card with a queue behind it.
  return { cards, initialTop: "id" };
}

function buildTotals(view: Record<string, unknown>) {
  const points = (view.points ?? {}) as Record<string, unknown>;
  const attendance = (view.attendance ?? {}) as Record<string, unknown>;

  const weeks = count(points.weeksQualified);
  const entries = count(points.bigRaffleEntries);

  const note =
    (weeks === null
      ? "Weeks qualified is not on your record yet — that is not the same as zero."
      : `Qualified ${weeks} week${weeks === 1 ? "" : "s"} so far.`) +
    (entries !== null
      ? ` ${entries} big raffle ${entries === 1 ? "entry" : "entries"}.`
      : "");

  return {
    tickets: [
      { id: "tickets.total", label: "Total", value: count(points.total), missing: "No record" },
      { id: "tickets.pbis", label: "PBIS", value: count(points.pbis), missing: "No record" },
      {
        id: "tickets.attendance",
        label: "Attendance",
        value: count(points.attendance),
        missing: "No record",
      },
      {
        id: "tickets.academic",
        label: "Academic",
        value: count(points.academic),
        missing: "No record",
      },
    ] as StatModel[],
    ticketsNote: note,
    attendance:
      attendance.available === false
        ? ({ available: false, reason: str(attendance.reason) } as const)
        : ({
            available: true,
            stats: [
              {
                id: "cards.absentTerm",
                label: "Absent, term",
                value: count(attendance.daysAbsentTerm),
                missing: "Not on file",
              },
              {
                id: "cards.tardyTerm",
                label: "Tardy, term",
                value: count(attendance.daysTardyTerm),
                missing: "Not on file",
              },
            ] as StatModel[],
          } as const),
    provenance: { dataAsOf: str(view.dataAsOf) } as Provenance,
  };
}

/* ------------------------------------------------------------------
   Schedule
   ------------------------------------------------------------------ */

export type ClassRowModel = {
  course: string;
  /** The digits only: "1(A-E)" is a period label, "1" is what fits a chip. */
  periodShort: string;
  detail: string;
};

export type ScheduleModel = {
  rows: ClassRowModel[];
  /** Present when there is nothing to list, and says why in words. */
  emptyReason: string | null;
  /** true when the panel itself refused, which is a louder kind of empty. */
  refused: boolean;
  provenance: Provenance;
};

export function useScheduleModel(): Async<ScheduleModel> {
  const { studentView, me } = useSession();

  return useMemo(() => {
    if (studentView.state !== "ok") return studentView;

    const view = studentView.data;
    const panel = toPanel<ClassRow>(view.schedule, "classes", "schedule");

    // me:get joins the SAME roster table on the SAME email key, so it is a
    // second door to the same fact rather than a different fact.
    const fallback: ClassRow[] =
      me.state === "ok" && Array.isArray(me.data.schedule)
        ? (me.data.schedule as ClassRow[])
        : [];

    const raw = panel.available ? panel.items : fallback;
    const usedFallback = !panel.available && fallback.length > 0;

    let emptyReason: string | null = null;
    if (raw.length === 0) {
      if (!panel.available) emptyReason = panel.reason;
      else if (panel.unknownWhy)
        emptyReason =
          "The server sent an empty timetable and, in this older response " +
          "shape, no reason with it. That could mean no sections are on your " +
          "roster or that the lookup could not run. It should not be read as " +
          "'you have no classes'.";
      else
        emptyReason =
          "No sections are on your PowerSchool roster for this term yet.";
    }

    return {
      state: "ok",
      data: {
        rows: raw.map(toClassRowModel),
        emptyReason,
        refused: !panel.available && !usedFallback,
        provenance: {
          dataAsOf: str(view.dataAsOf),
          panel,
          extra: usedFallback ? "shown from me:get instead" : undefined,
        },
      },
    };
  }, [studentView, me]);
}

function toClassRowModel(row: ClassRow): ClassRowModel {
  const period = str(row.period);
  const teacher = str(row.teacher);
  const term = str(row.term);

  return {
    course: str(row.courseName) ?? str(row.courseNumber) ?? "Unnamed course",
    periodShort: period ? period.replace(/\(.*\)$/, "") : "—",
    detail: [
      teacher ?? "Teacher not listed",
      period ? `Period ${period}` : null,
      term,
    ]
      .filter(Boolean)
      .join(" · "),
  };
}

/* ------------------------------------------------------------------
   Grades
   ------------------------------------------------------------------ */

export type GradeRowModel = {
  id: string;
  course: string;
  courseNumber: string;
  /** false renders the words "Not graded yet". Never a dash, never a colour. */
  graded: boolean;
  letter: string | null;
  percent: number | null;
};

export type GradesModel = {
  summary: StatModel[];
  summaryNote: string;
  rows: GradeRowModel[];
  emptyReason: string | null;
  refused: boolean;
  provenance: Provenance;
  attendance:
    | { available: false; reason: string | null }
    | { available: true; stats: StatModel[]; note: string };
};

export function useGradesModel(): Async<GradesModel> {
  const { studentView } = useSession();

  return useMemo(() => {
    if (studentView.state !== "ok") return studentView;

    const view = studentView.data;
    const panel = toPanel<GradeCell>(view.grades, "courses", "grades");
    const graded = panel.items.filter((row) => row.available);

    const percents = graded
      .map((row) => count(row.currentPercent))
      .filter((n): n is number => n !== null);
    const average =
      percents.length > 0
        ? Math.round((percents.reduce((a, b) => a + b, 0) / percents.length) * 10) / 10
        : null;

    let emptyReason: string | null = null;
    if (panel.items.length === 0) {
      if (!panel.available) emptyReason = panel.reason;
      else if (panel.unknownWhy)
        emptyReason =
          "The server sent an empty grade list and, in this older response " +
          "shape, no reason with it. That could mean nothing has been graded " +
          "or that the lookup could not run. It must not be read as a set of " +
          "zeros.";
      else emptyReason = "No gradebook rows have been synced for you yet.";
    }

    const attendance = (view.attendance ?? {}) as Record<string, unknown>;

    return {
      state: "ok",
      data: {
        summary: [
          {
            id: "grades.average",
            label: "Average of graded",
            value: average,
            missing: "Nothing graded",
            suffix: "%",
          },
          {
            id: "grades.graded",
            label: "Graded",
            value: panel.available ? graded.length : null,
            missing: "Unknown",
          },
          {
            id: "grades.ungraded",
            label: "Not graded yet",
            value: panel.available ? panel.items.length - graded.length : null,
            missing: "Unknown",
          },
        ],
        summaryNote:
          "The average is across sections that actually have a mark. A section " +
          "with no mark is not counted as a zero.",
        rows: panel.items.map((row, i) => ({
          id: `grades.row.${str(row.courseNumber) ?? str(row.courseName) ?? i}`,
          course: str(row.courseName) ?? str(row.courseNumber) ?? "Unnamed course",
          courseNumber: str(row.courseNumber) ?? "No course number",
          graded: row.available,
          letter: str(row.currentGrade),
          percent: row.available ? count(row.currentPercent) : null,
        })),
        emptyReason,
        refused: !panel.available,
        provenance: { dataAsOf: str(view.dataAsOf), panel },
        attendance:
          attendance.available === false
            ? ({ available: false, reason: str(attendance.reason) } as const)
            : ({
                available: true,
                note:
                  '"Not on file" means the school has not sent this figure. It ' +
                  "is not a count of zero.",
                stats: [
                  {
                    id: "grades.absentTerm",
                    label: "Absent, term",
                    value: count(attendance.daysAbsentTerm),
                    missing: "Not on file",
                  },
                  {
                    id: "grades.absentYtd",
                    label: "Absent, year",
                    value: count(attendance.daysAbsentYtd),
                    missing: "Not on file",
                  },
                  {
                    id: "grades.tardyTerm",
                    label: "Tardy, term",
                    value: count(attendance.daysTardyTerm),
                    missing: "Not on file",
                  },
                ] as StatModel[],
              } as const),
      },
    };
  }, [studentView]);
}

/* ------------------------------------------------------------------
   Hall pass
   ------------------------------------------------------------------ */

export type LivePassModel = {
  id: string | null;
  state: string;
  overdue: boolean;
  elapsed: number | null;
  limit: number | null;
  /** The server allows a cancel only while the pass is still `requested`. */
  cancellable: boolean;
  waiting: boolean;
};

export type PassLocation = { slug: string | null; name: string; kind: string };

export type RequestModel = {
  locations: PassLocation[];
  /** Why the timetable could not supply classrooms, in the server's words. */
  scheduleNote: string | null;
  truncated: boolean;
};

export function useHallPassModel(): {
  live: LivePassModel | null;
  request: Async<RequestModel>;
} {
  const { passCard, tapLocations } = useSession();

  return useMemo(() => {
    const hp =
      passCard.state === "ok"
        ? (passCard.data.hallPass as Record<string, unknown> | undefined)
        : undefined;

    const live: LivePassModel | null =
      hp && hp.available === true
        ? (() => {
            const state = str(hp.state) ?? "open";
            const id = str(hp.id);
            return {
              id,
              state,
              overdue: hp.overdue === true,
              elapsed: count(hp.elapsedMinutes),
              limit: count(hp.expiresAfterMinutes),
              cancellable: state === "requested" && id !== null,
              waiting: state === "requested",
            };
          })()
        : null;

    const request: Async<RequestModel> =
      tapLocations.state === "ok"
        ? {
            state: "ok",
            data: {
              locations: (Array.isArray(tapLocations.data.locations)
                ? (tapLocations.data.locations as Array<Record<string, unknown>>)
                : []
              ).map((loc) => ({
                slug: str(loc.slug),
                name: str(loc.name) ?? str(loc.slug) ?? "Unnamed",
                kind: str(loc.kind) ?? "location",
              })),
              scheduleNote: str(
                (
                  (tapLocations.data.classroomsFromSchedule ?? {}) as Record<
                    string,
                    unknown
                  >
                ).reason,
              ),
              truncated: tapLocations.data.truncated === true,
            },
          }
        : tapLocations;

    return { live, request };
  }, [passCard, tapLocations]);
}
