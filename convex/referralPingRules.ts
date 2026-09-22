/**
 * WHEN AN OPEN REFERRAL SHOULD BE CHASED, AND BY WHOM.
 *
 * PURE, AND ITS OWN FILE. Every decision here is a policy about mailing named
 * adults about named children, so it is testable without an auth gate, a
 * clock, or a mail server in the way -- the same reason referralMailRules.ts
 * exists beside referralMail.ts.
 *
 * THE PROBLEM, measured on 2026-09-22: of four referrals ever filed, THREE
 * were still open at 4, 5 and 7 days, and the oldest carried `severeBypass` --
 * the flag meaning too serious for the intervention ladder. A fourth had been
 * closed by an administrator on 2026-09-15 and the loop back to the teacher
 * who filed it had never been closed at all. Nothing in the app said any of
 * that out loud.
 *
 * SCHOOL DAYS, NOT CALENDAR DAYS. A referral filed on a Friday afternoon must
 * not escalate over a weekend nobody was working, and Labor Day is not a day
 * an administrator failed to act.
 *
 * EACH STAGE FIRES ONCE. A daily nagging mail is one people learn to filter,
 * and a filtered escalation is worse than none: it looks like the system is
 * working. The mail log is what makes "once" true across restarts.
 */

import {
  REFERRAL_RECIPIENTS, esc, shortName, whenText, MAX_FIELD, MAX_DESCRIPTION,
} from "./referralMailRules";

/** A stage is a distinct piece of mail, logged and sent at most once. */
export const PING_STAGES = ["nudge", "escalation", "severe", "loop"] as const;
export type PingStage = (typeof PING_STAGES)[number];

/**
 * The owner's thresholds, 2026-09-22, in SCHOOL days.
 *
 * Two then five was chosen against the real backlog: every open referral at
 * the time was 4 days or older, so both stages would have fired on all of
 * them, which is the point. Severe at one because a referral too serious for
 * the intervention ladder sitting a week is the case the whole feature exists
 * for.
 */
export const DEFAULT_PING_SETTINGS = {
  nudgeAfterSchoolDays: 2,
  escalateAfterSchoolDays: 5,
  severeAfterSchoolDays: 1,
  loopAfterSchoolDays: 3,
  /** Off until somebody turns it on. Mail to real people is opt-in. */
  enabled: false,
};

export function pingSettingsOrDefault(raw: unknown) {
  const d = DEFAULT_PING_SETTINGS;
  const s = (raw && typeof raw === "object") ? (raw as Record<string, unknown>) : {};
  const n = (v: unknown, fallback: number) => {
    const x = Number(v);
    return Number.isFinite(x) && x >= 0 ? Math.round(x) : fallback;
  };
  const out = {
    nudgeAfterSchoolDays: n(s.nudgeAfterSchoolDays, d.nudgeAfterSchoolDays),
    escalateAfterSchoolDays: n(s.escalateAfterSchoolDays, d.escalateAfterSchoolDays),
    severeAfterSchoolDays: n(s.severeAfterSchoolDays, d.severeAfterSchoolDays),
    loopAfterSchoolDays: n(s.loopAfterSchoolDays, d.loopAfterSchoolDays),
    enabled: s.enabled === true,
  };
  // An escalation that fires before its own nudge is not a ladder. The
  // stricter one wins rather than the two silently swapping.
  if (out.escalateAfterSchoolDays < out.nudgeAfterSchoolDays) {
    out.escalateAfterSchoolDays = out.nudgeAfterSchoolDays;
  }
  return out;
}

/**
 * School days strictly after `from`, up to and including `to`.
 *
 * `schoolDays` is the set of dates the school actually ran, derived from
 * attendance rather than from a transcribed calendar -- so an assembly day, a
 * minimum day and Labor Day all take care of themselves.
 *
 * IT REFUSES RATHER THAN GUESSES. If the caller has no school-day list the
 * answer is null, not a weekday count: a weekday fallback would mail somebody
 * about a referral that had been open for one working day over a long weekend,
 * and the first wrong escalation is the one that gets the whole feature turned
 * off.
 */
export function schoolDaysBetween(
  from: unknown, to: unknown, schoolDays: readonly string[] | null | undefined,
): number | null {
  const a = String(from ?? "").slice(0, 10);
  const b = String(to ?? "").slice(0, 10);
  if (a.length !== 10 || b.length !== 10) return null;
  if (!schoolDays || !schoolDays.length) return null;
  let n = 0;
  for (const d of schoolDays) {
    const x = String(d ?? "").slice(0, 10);
    if (x > a && x <= b) n++;
  }
  return n;
}

/** Named in the diagnostic output so a reader knows where the calendar came from. */
export const SCHOOL_DAY_SOURCE = "psAbsenceDayTotals (dates PowerSchool actually took attendance)";

export type Referral = Record<string, any>;

/** Filed-on, from whichever field the payload actually carries. */
export function filedOn(r: Referral): string | null {
  const raw = String(r?.submittedAt || r?.dateTime || r?.date || "").slice(0, 10);
  return raw.length === 10 ? raw : null;
}

export function isOpen(r: Referral): boolean {
  if (!r) return false;
  // closedAt is the fact; status is a label a client writes. Trust the fact,
  // and treat either as closing so a payload that sets only one is not chased.
  if (r.closedAt) return false;
  return String(r.status ?? "").trim().toLowerCase() !== "closed";
}

export function loopIsOpen(r: Referral): boolean {
  if (!r) return false;
  if (isOpen(r)) return false;           // not closed yet: that is the other stage
  return !(r.loopClosed === true || Boolean(r.loopClosedAt));
}

export type Due = {
  referralId: string;
  stage: PingStage;
  /** School days since `clockFrom`. */
  ageSchoolDays: number;
  filedOn: string;
  /** What the age is measured from: the filing, or the closure for a loop. */
  clockFrom: string;
  severe: boolean;
  /** Set for the loop stage: whoever closed it is who gets asked. */
  closedBy: string | null;
  filedByEmail: string | null;
};

/**
 * Which referrals are due for which stage, given what has already been sent.
 *
 * `alreadySent` is the set of "<referralId>|<stage>" the mail log holds. A
 * stage already sent is never returned, which is what makes "once" survive a
 * restart, a redeploy and a second cron firing in the same minute.
 *
 * ONE STAGE PER REFERRAL PER RUN, the most serious that is due. A referral
 * that crosses both thresholds while the feature was disabled must not produce
 * two mails in one morning.
 */
export function pingsDue(
  referrals: readonly Referral[],
  opts: {
    today: string;
    schoolDays: readonly string[] | null;
    settings?: unknown;
    alreadySent?: ReadonlySet<string>;
  },
): { due: Due[]; skipped: Array<{ referralId: string; why: string }>; settings: ReturnType<typeof pingSettingsOrDefault> } {
  const s = pingSettingsOrDefault(opts?.settings);
  const sent = opts?.alreadySent ?? new Set<string>();
  const due: Due[] = [];
  const skipped: Array<{ referralId: string; why: string }> = [];

  for (const r of referrals || []) {
    const id = String(r?.id ?? "").trim();
    if (!id) { skipped.push({ referralId: "(no id)", why: "no_id" }); continue; }
    const filed = filedOn(r);
    if (!filed) { skipped.push({ referralId: id, why: "undated" }); continue; }

    const severe = r?.severeBypass === true;
    const open = isOpen(r);
    const loopOpen = loopIsOpen(r);
    if (!open && !loopOpen) { skipped.push({ referralId: id, why: "fully_closed" }); continue; }

    // THE LOOP CLOCK STARTS WHEN IT WAS CLOSED, not when it was filed.
    // "The teacher was never told" is a fact about the days since somebody
    // decided something -- a referral that sat open for three weeks and was
    // closed this morning is not overdue for a loop reminder, and dating it
    // from the filing would have sent one the same afternoon.
    const closedOn = String(r?.closedAt ?? "").slice(0, 10);
    const clockFrom = open ? filed : (closedOn.length === 10 ? closedOn : filed);
    const age = schoolDaysBetween(clockFrom, opts.today, opts.schoolDays);
    if (age === null) { skipped.push({ referralId: id, why: "no_school_day_list" }); continue; }

    // Most serious first, and only one per referral per run.
    const candidates: Array<[PingStage, number]> = open
      ? (severe
          ? [["escalation", s.escalateAfterSchoolDays], ["severe", s.severeAfterSchoolDays],
             ["nudge", s.nudgeAfterSchoolDays]]
          : [["escalation", s.escalateAfterSchoolDays], ["nudge", s.nudgeAfterSchoolDays]])
      : [["loop", s.loopAfterSchoolDays]];

    // ONLY THE MOST SERIOUS STAGE IT HAS REACHED, and if that one has already
    // gone out, nothing. The weaker stages below it are moot: a nudge landing
    // the morning after an escalation is a quieter copy of a message the same
    // people already have, and that is exactly how a reminder becomes noise
    // somebody writes a mailbox rule for. So this breaks at the first
    // threshold the referral has crossed rather than walking down to the next.
    let picked: PingStage | null = null;
    for (const [stage, threshold] of candidates) {
      if (age < threshold) continue;
      if (!sent.has(id + "|" + stage)) picked = stage;
      break;
    }
    if (!picked) { skipped.push({ referralId: id, why: "not_due_or_already_sent" }); continue; }

    due.push({
      referralId: id, stage: picked, ageSchoolDays: age, filedOn: filed, clockFrom, severe,
      closedBy: r?.closedBy ? String(r.closedBy) : null,
      filedByEmail: r?.filedByEmail ? String(r.filedByEmail) : null,
    });
  }
  // Oldest first: if a run is ever capped, the longest-ignored goes first.
  due.sort((a, b) => b.ageSchoolDays - a.ageSchoolDays);
  return { due, skipped, settings: s };
}

// ---------------------------------------------------------------------------
// WHO GETS CHASED, AND WHAT THE MAIL SAYS
// ---------------------------------------------------------------------------


const normEmail = (s: unknown) => String(s ?? "").trim().toLowerCase();

/**
 * Leadership, for the escalation stage.
 *
 * Read off the `why` field of the standing list rather than re-typed, so a
 * change to that list cannot leave two copies of an address disagreeing.
 */
export const ESCALATION_ONLY = ["Chief of Schools"];

/**
 * The addresses for one stage.
 *
 * NOT THE SAME SEVEN THE FILING MAIL GOES TO, and the difference is the point.
 * `recipientsFor` in referralMailRules adds the filing teacher, because that
 * mail is partly their receipt -- which is why all four sends on record show
 * seven recipients, not six. A chase is different work:
 *
 *   nudge       the five who can actually close a referral. Not the Chief of
 *               Schools, because two school days is not his problem yet, and
 *               not the filing teacher, who cannot close it and would only be
 *               told that nobody has.
 *   escalation  all six, Chief included. Five school days open is now his.
 *   severe      the same six. A referral flagged too serious for the
 *               intervention ladder gets leadership on day one.
 *   loop        one person -- whoever closed it. See pingRecipients' caller.
 *
 * The filing teacher is told once, when the loop is closed and there is
 * something to tell them. Adding them to a chase would mail a teacher every
 * few days about a decision that is not theirs to make.
 */
export function pingRecipients(stage: PingStage): string[] {
  if (stage === "loop") return [];   // resolved from closedBy by the caller
  const leadershipOnly = stage === "escalation" || stage === "severe";
  return REFERRAL_RECIPIENTS
    .filter((r) => leadershipOnly || ESCALATION_ONLY.indexOf(r.why) === -1)
    .map((r) => r.email);
}

const clampText = (raw: unknown, max: number) => {
  const s = String(raw ?? "").trim();
  return s.length <= max ? s : s.slice(0, max) + "... [truncated]";
};

const days = (n: number) => `${n} school day${n === 1 ? "" : "s"}`;

/**
 * The chase email.
 *
 * SAME RULES AS THE FILING MAIL, for the same reasons: the subject is plain
 * text because it is a header, the body is ASCII entities because a mail
 * client's charset guess is not ours to control, and the whole referral
 * travels with it because the Chief of Schools has no account to click into.
 *
 * IT SAYS WHAT WOULD MAKE IT STOP. A reminder that does not name the action
 * that ends it is just noise, and the fastest way to get a rule like this
 * filtered into a folder nobody opens.
 */
export function pingMailPlan(
  referral: any,
  info: { stage: PingStage; ageSchoolDays: number; to: string[]; settings?: unknown },
): { to: string[]; subject: string; html: string } {
  const r = referral ?? {};
  const s = pingSettingsOrDefault(info.settings);
  const stage = info.stage;
  const age = Math.max(0, Math.round(Number(info.ageSchoolDays) || 0));
  const student = clampText(r.studentName, MAX_FIELD) || "a student";
  const grade = clampText(r.studentGrade, 20);
  const behavior = clampText(r.behavior || r.behaviorType, MAX_FIELD);
  const severe = r.severeBypass === true;

  // THE SEVERITY TRAVELS WITH EVERY STAGE, not just the "severe" one. The
  // severe stage only fires while the referral is one to four school days
  // old; past five it crosses the escalation threshold instead, and the first
  // dry run against real data showed exactly that -- a referral flagged too
  // serious for classroom interventions arriving as an ordinary escalation
  // with no sign of what it was. The flag is a fact about the incident, so it
  // is on the mail whenever the referral is still open.
  const lead =
    stage === "loop"
      ? "Referral closed, teacher not told"
      : severe
        ? (stage === "escalation" ? "Still open - escalated - immediate removal" : "Still open - immediate removal")
        : stage === "escalation"
          ? "Still open - escalated"
          : "Still open";

  const subject = [lead, shortName(student), grade ? `Grade ${grade}` : null, `${age}d`]
    .filter(Boolean).join(" - ").replace(/\s+/g, " ").slice(0, 150);

  const row = (label: string, value: unknown) =>
    `<tr><td style="padding:3px 14px 3px 0;color:#667085;vertical-align:top;white-space:nowrap">${esc(label)}</td>` +
    `<td style="padding:3px 0;color:#14171C">${esc(value) || "<span style=\"color:#98a2b3\">not recorded</span>"}</td></tr>`;

  const parts: string[] = [];

  if (stage === "loop") {
    parts.push(
      `<p style="margin:0 0 14px">This referral was <strong>closed</strong>, but the teacher who filed it has still ` +
      `not been told what happened. Closing the loop is the last step, and it is the only part of this the filing ` +
      `teacher sees.</p>`);
    parts.push(
      `<p style="margin:0 0 14px;padding:10px 12px;border-left:4px solid #E7ECF2;background:#F8FAFC;color:#344054">` +
      `<strong>What ends this reminder:</strong> open Wildcat Hub &rarr; Discipline &rarr; Closed Referrals, find this ` +
      `referral, and use <strong>Close the loop</strong> once you have told ${esc(clampText(r.filedBy, MAX_FIELD) || "the filing teacher")} ` +
      `the outcome. Nothing else needs changing.</p>`);
  } else {
    parts.push(
      `<p style="margin:0 0 14px">This behavior referral has been open for <strong>${esc(days(age))}</strong> and ` +
      `nobody has closed it. The whole referral is below; you do not need to open Wildcat Hub to read it.</p>`);
    if (severe) {
      parts.push(
        `<p style="margin:0 0 14px;padding:10px 12px;border-left:4px solid #dc2626;background:#fef2f2;color:#7f1d1d">` +
        `<strong>Immediate removal was recorded.</strong> The teacher marked this incident too severe for classroom ` +
        `interventions &mdash; violence, a threat to safety, or similar. ` +
        (stage === "severe"
          ? `It is being chased after ${esc(days(s.severeAfterSchoolDays))} rather than ` +
            `${esc(days(s.nudgeAfterSchoolDays))} for that reason.`
          : `That was true when it was filed and it is still open now.`) +
        `</p>`);
    }
    if (stage === "escalation") {
      parts.push(
        `<p style="margin:0 0 14px;padding:10px 12px;border-left:4px solid #f59e0b;background:#fffbeb;color:#78350f">` +
        `<strong>Escalated.</strong> A first reminder went to the administrators and PBIS staff after ` +
        `${esc(days(s.nudgeAfterSchoolDays))}. This one includes the Chief of Schools because the referral is ` +
        `now ${esc(days(age))} old.</p>`);
    }
    parts.push(
      `<p style="margin:0 0 14px;padding:10px 12px;border-left:4px solid #E7ECF2;background:#F8FAFC;color:#344054">` +
      `<strong>What ends this reminder:</strong> open Wildcat Hub &rarr; Discipline &rarr; Referral Review and close ` +
      `this referral, recording either the action taken or "no action required". ` +
      `${stage === "nudge" ? `If it is still open in ${esc(days(Math.max(0, s.escalateAfterSchoolDays - age)))} this goes to the Chief of Schools.` : ""}</p>`);
  }

  parts.push(
    `<h3 style="margin:22px 0 6px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#667085">The referral</h3>` +
    `<table style="border-collapse:collapse;font-size:14px">` +
    row("Student", student) + row("Student ID", r.studentId) + row("Grade", grade) +
    row("Behavior", behavior) +
    row("Incident", whenText(r.dateTime || r.date)) +
    row("Filed", whenText(r.submittedAt)) +
    row("Filed by", clampText(r.filedBy, MAX_FIELD) || clampText(r.filedByEmail, MAX_FIELD)) +
    row("Open for", days(age)) +
    (stage === "loop" ? row("Closed by", clampText(r.closedBy, MAX_FIELD)) +
      row("Closed", whenText(r.closedAt)) +
      row("Resolution", r.resolutionType === "no_action" ? "No action required" : clampText(r.consequence, MAX_DESCRIPTION) || "Action taken")
      : "") +
    row("Referral ID", r.id) + `</table>`);

  const description = clampText(r.description, MAX_DESCRIPTION);
  if (description && stage !== "loop") {
    parts.push(
      `<h3 style="margin:22px 0 6px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#667085">What the teacher wrote</h3>` +
      `<div style="padding:10px 14px;border-left:3px solid #E7ECF2;color:#14171C;font-size:14px;line-height:1.6">` +
      `${esc(description).replace(/\n/g, "<br>")}</div>`);
  }

  parts.push(
    `<p style="margin:22px 0 0;padding-top:14px;border-top:1px solid #E7ECF2;font-size:12px;line-height:1.6;color:#667085">` +
    `Sent by Wildcat Hub because this referral ${stage === "loop"
      ? `was closed ${esc(days(age))} ago and the teacher who filed it has still not been told`
      : `was still open after ${esc(days(age))}`}. ` +
    `<strong>Each stage is sent once.</strong> You will not get this again for this referral unless it crosses the ` +
    `next threshold. Age is counted in school days, so weekends and holidays do not move it.</p>`);

  return {
    to: info.to.map((e) => String(e).trim()).filter((e) => normEmail(e).includes("@")),
    subject,
    html:
      `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;` +
      `font-size:14px;line-height:1.6;color:#14171C;max-width:640px">${parts.join("")}</div>`,
  };
}
