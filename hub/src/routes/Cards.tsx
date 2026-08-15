import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import Stack from "@/components/Stack";
import Counter from "@/components/Counter";
import BlurText from "@/components/BlurText";
import GlareHover from "@/components/GlareHover";
import StarBorder from "@/components/StarBorder";
import { useSession } from "@/lib/session";
import { useFinePointer, useReducedMotion } from "@/lib/motion";
import { count, money, str, toSlot } from "@/lib/shapes";
import { Barcode } from "@/ui/Barcode";
import {
  Loaded,
  Provenance,
  SectionLabel,
  Stat,
  Surface,
  Unavailable,
  friendlyTime,
  formatNumber,
} from "@/ui/primitives";

/**
 * THE CARD HOME.
 *
 * React Bits' `Stack` is the component for this and it is the right one: the
 * existing student portal (styles.css §"STUDENT PORTAL") is already a Wallet-
 * geometry stack, so this is the same idea rendered by a component instead of by
 * 400 lines of hand-written transform maths, and a student who has used one
 * knows how to use the other.
 *
 * TWO THINGS I CHANGED ABOUT HOW IT IS USED, both because a wallet is a tool:
 *
 *   1. The card order is CONTROLLED. Stack fans its deck and only the top card
 *      is properly legible, which is fine for a gallery and not fine when the
 *      top card is the barcode somebody is holding up at a lunch till. The chips
 *      under the stack put any card on top in one tap, so nothing is ever more
 *      than one action away, and the ID starts on top because it is the card
 *      with a queue behind it.
 *   2. `sendToBackOnClick` is off and `mobileClickOnly` is on. On a touch screen
 *      a tap selects; on a mouse you can still drag. A card that reshuffles
 *      because a student touched it to read it is a card that has moved the
 *      thing they were reading.
 */
export default function Cards() {
  const { me, passCard, studentView } = useSession();
  const reduced = useReducedMotion();

  const firstName =
    (me.state === "ok" ? str(me.data.firstName) : null) ?? "Wildcat";

  return (
    <div className="space-y-5">
      <header>
        {/* BlurText, words, once. The greeting is the one place on this screen
            where a slower reveal is right: it is the moment the page stops being
            a loading state and becomes yours. */}
        <BlurText
          text={`Hi, ${firstName}`}
          animateBy="words"
          direction="top"
          delay={reduced ? 0 : 90}
          stepDuration={reduced ? 0.12 : 0.26}
          threshold={0}
          className="text-[30px] font-bold leading-[1.06] tracking-[-0.022em] text-wp-fg"
        />
        <MetaLine />
      </header>

      <LivePassBanner />

      <Loaded from={passCard} rows={1}>
        {(pass) => <Wallet pass={pass} />}
      </Loaded>

      <Loaded from={studentView} rows={2}>
        {(view) => <Totals view={view} />}
      </Loaded>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function MetaLine() {
  const { me, passCard } = useSession();
  const grade =
    me.state === "ok" ? str(me.data.gradeLevel) : null;
  const number =
    passCard.state === "ok"
      ? str((passCard.data.student as Record<string, unknown> | undefined)?.studentNumber)
      : null;

  const bits = [
    grade ? `Grade ${grade}` : null,
    number ? `Student ${number}` : null,
  ].filter(Boolean);

  return (
    <p className="mt-1.5 text-[13.5px] tabular-nums text-wp-dim">
      {bits.length ? bits.join("  ·  ") : "Westbrook Academy"}
    </p>
  );
}

/**
 * A live hall pass is the one thing on this screen that has to interrupt.
 * StarBorder earns its keep exactly here and nowhere else: it is the only
 * continuously animating element in the signed-in app, it appears only while a
 * pass is actually open, and it goes away the moment the pass closes.
 */
function LivePassBanner() {
  const { passCard } = useSession();
  if (passCard.state !== "ok") return null;

  const hp = passCard.data.hallPass as Record<string, unknown> | undefined;
  if (!hp || hp.available !== true) return null;

  const overdue = hp.overdue === true;
  const elapsed = count(hp.elapsedMinutes);
  const limit = count(hp.expiresAfterMinutes);

  return (
    <StarBorder
      as="div"
      className="block w-full"
      color={overdue ? "#D9742F" : "#B5D4F4"}
      speed="7s"
      thickness={1}
      innerClassName={`relative z-1 rounded-[19px] border px-5 py-4 ${
        overdue
          ? "border-wc-orange/50 bg-[#2A1A10]"
          : "border-wc-blue/50 bg-[#0E1B2C]"
      }`}
    >
      <div className="flex items-center justify-between gap-4 text-left">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-[0.09em] text-wc-blue-pale">
            {overdue ? "Hall pass overdue" : "Hall pass open"}
          </p>
          <p className="mt-1 text-[15px] font-bold text-wp-fg">
            {elapsed === null
              ? "Out of class"
              : `Out for ${elapsed} minute${elapsed === 1 ? "" : "s"}`}
            {limit !== null && (
              <span className="font-normal text-wp-dim"> of {limit}</span>
            )}
          </p>
        </div>
        <Link
          to="/pass"
          className="wc-press shrink-0 rounded-full bg-white/10 px-4 py-2 text-[13px] font-bold text-wp-fg"
        >
          Open
        </Link>
      </div>
    </StarBorder>
  );
}

/* ------------------------------------------------------------------ */

type CardDef = { key: string; chip: string; face: ReactNode };

function Wallet({ pass }: { pass: Record<string, unknown> }) {
  const { studentView } = useSession();
  const fine = useFinePointer();

  const student = (pass.student ?? {}) as Record<string, unknown>;
  const studentId = toSlot(pass.studentId, "student number");
  const lunchId = toSlot(pass.lunchId, "lunch number");
  const clever = toSlot(pass.cleverBadge, "Clever badge");
  const hp = (pass.hallPass ?? {}) as Record<string, unknown>;
  const cash =
    studentView.state === "ok"
      ? (studentView.data.wildcatCash as Record<string, unknown> | undefined)
      : undefined;

  const name = [str(student.firstName), str(student.lastName)]
    .filter(Boolean)
    .join(" ");

  // Hoisted out of the dependency array: a JSON.stringify() written inline in
  // deps cannot be checked statically, and these two objects are new references
  // on every render, so comparing them by identity would rebuild every card face
  // each time anything on the page changed.
  const hpKey = JSON.stringify(hp);
  const cashKey = JSON.stringify(cash ?? null);

  const defs: CardDef[] = useMemo(() => {
    const list: CardDef[] = [
      {
        key: "clever",
        chip: "Clever",
        face: (
          <Face tint="#1B1D24" label="Clever badge">
            <Missing reason={clever.reason} />
          </Face>
        ),
      },
      {
        key: "lunch",
        chip: "Lunch",
        face: (
          <Face tint="#1B1D24" label="Lunch number">
            {lunchId.available && lunchId.value ? (
              <Barcode value={lunchId.value} />
            ) : (
              <Missing reason={lunchId.reason} />
            )}
          </Face>
        ),
      },
      {
        key: "pass",
        chip: "Hall pass",
        face: (
          <Face tint="#24517F" label="Hall pass">
            <HallPassFace hp={hp} />
          </Face>
        ),
      },
      {
        key: "cash",
        chip: "Cash",
        face: (
          <Face tint="#1A2E1F" label="Wildcat Cash">
            <CashFace cash={cash} />
          </Face>
        ),
      },
      {
        key: "id",
        chip: "Student ID",
        face: (
          <Face
            tint="#0C447C"
            label="Student ID"
            name={name}
            meta={
              <div className="flex items-end gap-8">
                <div>
                  <p className="text-[10.5px] font-bold uppercase tracking-[0.09em] text-white/55">
                    School
                  </p>
                  <p className="mt-1 text-[14px] font-bold text-white">
                    Westbrook Academy
                  </p>
                </div>
                <div>
                  <p className="text-[10.5px] font-bold uppercase tracking-[0.09em] text-white/55">
                    Grade
                  </p>
                  {/* `students.grade` is a number on some records and a string
                      on others, depending on which sync wrote it. Both are
                      accepted; neither is coerced into a made-up value. */}
                  <p className="mt-1 text-[14px] font-bold text-white">
                    {count(student.grade) !== null
                      ? String(count(student.grade))
                      : (str(student.grade) ?? "—")}
                  </p>
                </div>
              </div>
            }
          >
            {studentId.available && studentId.value ? (
              <GlareHover
                width="100%"
                height="auto"
                background="transparent"
                borderRadius="10px"
                borderColor="transparent"
                glareColor="#ffffff"
                glareOpacity={fine ? 0.28 : 0}
                glareAngle={-38}
                glareSize={200}
                /* 260ms, the app's modal band. React Bits ships 650ms, which on
                   a laminated-card sweep reads as a slow wipe rather than light
                   catching an edge. */
                transitionDuration={260}
                className="!cursor-default !border-0"
                style={{ display: "block" }}
              >
                <Barcode value={studentId.value} />
              </GlareHover>
            ) : (
              <Missing reason={studentId.reason} />
            )}
          </Face>
        ),
      },
    ];
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    name,
    fine,
    student.grade,
    studentId.available,
    studentId.value,
    studentId.reason,
    lunchId.available,
    lunchId.value,
    lunchId.reason,
    clever.reason,
    hpKey,
    cashKey,
  ]);

  // The ID starts on top: Stack draws the LAST entry frontmost.
  const [topKey, setTopKey] = useState("id");

  const ordered = useMemo(() => {
    const rest = defs.filter((d) => d.key !== topKey);
    const top = defs.find((d) => d.key === topKey);
    return top ? [...rest, top] : defs;
  }, [defs, topKey]);

  /* MUST be memoized. Stack re-syncs its internal deck from `cards` in an effect
     keyed on the array's identity, so a fresh array every render is an infinite
     setState loop. */
  const cards = useMemo(() => ordered.map((d) => d.face), [ordered]);

  return (
    <section aria-label="Your cards">
      <div className="h-[292px] w-full sm:h-[318px]">
        <Stack
          cards={cards}
          randomRotation={false}
          sensitivity={140}
          sendToBackOnClick={false}
          mobileClickOnly
          animationConfig={{ stiffness: 300, damping: 26 }}
        />
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        {defs
          .slice()
          .reverse()
          .map((d) => (
            <button
              key={d.key}
              type="button"
              onClick={() => setTopKey(d.key)}
              aria-pressed={topKey === d.key}
              className={`wc-press wc-hover-raise rounded-full border px-3.5 py-1.5 text-[12.5px] font-bold ${
                topKey === d.key
                  ? "border-wc-blue-pale/60 bg-wc-blue-pale/15 text-wc-blue-pale"
                  : "border-[var(--wp-hair)] bg-white/[0.03] text-wp-dim"
              }`}
            >
              {d.chip}
            </button>
          ))}
      </div>
    </section>
  );
}

function Face({
  tint,
  label,
  name,
  meta,
  children,
}: {
  tint: string;
  label: string;
  name?: string;
  meta?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      /* Only the ID card pushes its payload to the bottom, because a barcode
         belongs where a hand holds the phone. A card whose whole content is a
         sentence reads better with the sentence at the top and the space below
         it, not floating at the bottom of an empty rectangle. */
      className={`flex h-full w-full flex-col p-5 ${meta ? "justify-between" : ""}`}
      style={{
        background: tint,
        // The shadow is thrown upward onto the card above, which is what makes a
        // stack read as physical rather than as a list. Same values as
        // styles.css:3495.
        boxShadow:
          "0 -0.5px 0 rgba(255,255,255,0.14) inset, 0 -10px 26px rgba(0,0,0,0.55), 0 2px 3px rgba(0,0,0,0.30)",
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-[11px] font-bold uppercase tracking-[0.09em] text-white/65">
          {label}
        </p>
        {name && (
          <p className="text-right text-[13px] font-bold text-white">{name}</p>
        )}
      </div>
      {meta && <div className="mt-4 flex-1">{meta}</div>}
      <div className={meta ? "mt-3" : "mt-4"}>{children}</div>
    </div>
  );
}

function Missing({ reason }: { reason: string | null }) {
  return (
    <p className="text-[12.5px] leading-[1.5] text-white/70">
      {reason ??
        "Not available yet, and the server did not say why. The front office " +
          "can check your record."}
    </p>
  );
}

function HallPassFace({ hp }: { hp: Record<string, unknown> }) {
  if (hp.available === true) {
    const elapsed = count(hp.elapsedMinutes);
    return (
      <div>
        <p className="text-[26px] font-bold leading-none text-white">
          {hp.overdue === true ? "Overdue" : "Open"}
        </p>
        <p className="mt-2 text-[12.5px] text-white/70">
          {elapsed === null
            ? "Out of class now."
            : `Out for ${elapsed} minute${elapsed === 1 ? "" : "s"}.`}
        </p>
      </div>
    );
  }
  return (
    <div>
      <p className="text-[22px] font-bold leading-none text-white">
        No pass open
      </p>
      <Link
        to="/pass"
        className="wc-press mt-3 inline-block rounded-full bg-white/15 px-4 py-2 text-[13px] font-bold text-white"
      >
        Ask for one
      </Link>
    </div>
  );
}

/**
 * The one hero number in the app, and the only place `Counter` is used.
 *
 * Counter is an odometer: it rolls each digit place on its own spring. That is a
 * lot of motion for a figure you glance at, so it gets exactly one home — the
 * balance, which is money, which is the number a student most wants to watch
 * change. Everything else counts up flatly with CountUp.
 */
function CashFace({ cash }: { cash: Record<string, unknown> | undefined }) {
  const reduced = useReducedMotion();
  const balance = money(cash?.balance);

  if (balance === null) {
    return (
      <p className="text-[12.5px] leading-[1.5] text-white/70">
        Your Wildcat Cash balance is not on your record yet. It is not zero —
        nobody has told the app what it is. The front office can check.
      </p>
    );
  }

  const whole = Math.max(0, Math.round(balance));
  const earned = money(cash?.earned);
  const spent = money(cash?.spent);

  return (
    <div className="flex h-full flex-col justify-between">
      <div>
        <div className="flex items-end gap-1 text-wc-yellow">
          <span className="pb-1 text-[22px] font-bold leading-none">$</span>
          {reduced ? (
            <span className="text-[46px] font-bold leading-none tabular-nums">
              {whole}
            </span>
          ) : (
            <Counter
              value={whole}
              fontSize={46}
              gap={0}
              horizontalPadding={0}
              borderRadius={0}
              fontWeight={700}
              textColor="#E6E280"
              gradientHeight={10}
              gradientFrom="#1A2E1F"
              gradientTo="transparent"
            />
          )}
        </div>
        <p className="mt-2 text-[12.5px] text-white/70">
          Spendable at the school store.
        </p>
      </div>

      <div className="flex gap-8">
        {/* Earned and spent are shown as words when the sync has not sent them.
            A card that prints "$0 spent" at a child who has spent money is the
            same class of lie as a missing grade rendered as an F. */}
        <div>
          <p className="text-[10.5px] font-bold uppercase tracking-[0.09em] text-white/55">
            Earned
          </p>
          <p className="mt-1 text-[15px] font-bold text-white">
            {earned === null ? "Not synced" : `$${formatNumber(earned)}`}
          </p>
        </div>
        <div>
          <p className="text-[10.5px] font-bold uppercase tracking-[0.09em] text-white/55">
            Spent
          </p>
          <p className="mt-1 text-[15px] font-bold text-white">
            {spent === null ? "Not synced" : `$${formatNumber(spent)}`}
          </p>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function Totals({ view }: { view: Record<string, unknown> }) {
  const points = (view.points ?? {}) as Record<string, unknown>;
  const attendance = (view.attendance ?? {}) as Record<string, unknown>;

  const weeks = count(points.weeksQualified);
  const entries = count(points.bigRaffleEntries);

  return (
    <div className="space-y-4">
      <Surface>
        <SectionLabel>Raffle tickets</SectionLabel>
        <div className="mt-4 grid grid-cols-2 gap-y-6 sm:grid-cols-4">
          <Stat
            value={count(points.total)}
            label="Total"
            missing="No record"
            accent="text-wc-blue-pale"
            delay={0.05}
          />
          <Stat
            value={count(points.pbis)}
            label="PBIS"
            missing="No record"
            size="text-[24px]"
            delay={0.12}
          />
          <Stat
            value={count(points.attendance)}
            label="Attendance"
            missing="No record"
            size="text-[24px]"
            delay={0.19}
          />
          <Stat
            value={count(points.academic)}
            label="Academic"
            missing="No record"
            size="text-[24px]"
            delay={0.26}
          />
        </div>

        <p className="mt-5 border-t border-[var(--wp-hair)] pt-4 text-[13px] leading-[1.5] text-wp-dim">
          {weeks === null
            ? "Weeks qualified is not on your record yet — that is not the same as zero."
            : `Qualified ${weeks} week${weeks === 1 ? "" : "s"} so far.`}
          {entries !== null &&
            ` ${entries} big raffle ${entries === 1 ? "entry" : "entries"}.`}
        </p>
        <Provenance dataAsOf={str(view.dataAsOf)} />
      </Surface>

      {/* Wildcat Cash is NOT repeated here. It has a card of its own with the
          balance, earned and spent on it; a second copy on the same screen is
          two places to keep right and one more thing to scroll past. */}
      <div className="grid gap-4">
        <Surface>
          <SectionLabel>Attendance</SectionLabel>
          {attendance.available === false ? (
            <div className="mt-3">
              <Unavailable reason={str(attendance.reason)} />
            </div>
          ) : (
            <div className="mt-4 flex gap-8">
              <Stat
                value={count(attendance.daysAbsentTerm)}
                label="Absent, term"
                missing="Not on file"
                size="text-[24px]"
                delay={0.05}
              />
              <Stat
                value={count(attendance.daysTardyTerm)}
                label="Tardy, term"
                missing="Not on file"
                size="text-[24px]"
                delay={0.12}
              />
            </div>
          )}
        </Surface>
      </div>

      <ServerTime />
    </div>
  );
}

function ServerTime() {
  const { passCard } = useSession();
  if (passCard.state !== "ok") return null;
  const t = str(passCard.data.serverTime);
  if (!t) return null;
  return (
    <p className="px-1 text-[11.5px] text-wp-dim/80">
      Cards checked with the school server at {friendlyTime(t)}.
    </p>
  );
}
