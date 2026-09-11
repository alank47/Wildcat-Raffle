/**
 * Who is told a referral was filed, and what the email says.
 *
 * Pure and dependency-free so a plain-node test reaches it, same as
 * academicsRules.ts, courseSubject.ts and seniorEligibility.ts.
 *
 * THE THING THIS FILE EXISTS TO PREVENT. The obvious way to build a
 * "send an email" feature is an endpoint the browser calls with a recipient
 * list and some HTML. That would hand every one of the fifty-eight signed-in
 * staff the ability to send arbitrary mail, as westbrook@lapromisefund.org, to
 * the Chief of Schools. A phishing tool with the school's letterhead.
 *
 * So nothing here is caller-supplied. The recipients are a constant in this
 * file. The body is built here from a whitelist of referral fields. The one
 * thing the server takes from outside is WHICH referral was just inserted, and
 * that is not an argument either -- it is what the transaction happened to
 * write. See convex/referralMail.ts.
 */

/**
 * THE SIX, given by the owner on 2026-09-11.
 *
 * A CONSTANT AND NOT A ROLE QUERY, and the reason is concrete. Mailing
 * "everyone with an admin role" would have been eleven people, including this
 * app's own developer and a counselor who had been made an admin an hour
 * earlier for an unrelated screen. Who receives a stream of discipline records
 * about named children is a decision somebody makes, not a side effect of a
 * role granted for another purpose.
 *
 * Changing this list takes a commit and a deploy, on purpose, and git records
 * who did it. No env override, no settings screen.
 */
export const REFERRAL_RECIPIENTS: ReadonlyArray<{ email: string; name: string; why: string }> = [
  // Chief of Schools. Has a Microsoft account and NO Wildcat Hub account: he
  // can receive this and cannot click through, which is why the body carries
  // the whole referral rather than a link.
  { email: "jasonm@lapromisefund.org", name: "Jason Marin", why: "Chief of Schools" },
  { email: "leahr@lapromisefund.org", name: "Leah Ruiz", why: "admin" },
  { email: "ashargm@lapromisefund.org", name: "Asharg Molla", why: "admin" },
  // Also files referrals herself, so she is deduped against the filer below.
  { email: "laurab@lapromisefund.org", name: "Laura Baltazar", why: "pbis" },
  { email: "sammyg@lapromisefund.org", name: "Sammy Gonzalez", why: "pbis" },
  { email: "alank@lapromisefund.org", name: "Alan Kent", why: "superadmin, app owner" },
];

/** Free text a teacher typed is clamped before it reaches six inboxes. */
export const MAX_DESCRIPTION = 4000;
export const MAX_FIELD = 300;

/** Westbrook is in Los Angeles, and so is everyone who reads this email. */
export const SCHOOL_TZ = "America/Los_Angeles";

const norm = (s: unknown) => String(s ?? "").trim().toLowerCase();

/**
 * Every address that should receive this referral, the filer included, once.
 *
 * THE FILER COMES FROM THE VERIFIED TOKEN, never from the referral payload.
 * mergeSlice accepts `payload: v.any()` behind requireStaff, so every field on
 * a referral -- filedByEmail included -- is chosen by whoever called it. If the
 * recipient were read from there, a teacher could edit one value in devtools
 * and post any colleague a named child's discipline record. Deriving it from
 * requireStaff's return value means the capability does not exist rather than
 * being checked.
 */
export function recipientsFor(filerEmail: unknown): string[] {
  const seen = new Map<string, string>();
  for (const r of REFERRAL_RECIPIENTS) seen.set(norm(r.email), r.email);
  const filer = norm(filerEmail);
  // Laura is on the standing list and also files referrals. Without this she
  // would get her own referral twice.
  if (filer.includes("@") && !seen.has(filer)) seen.set(filer, String(filerEmail).trim());
  return [...seen.values()];
}

/**
 * HTML-escape. Every interpolated value goes through this, no exceptions.
 *
 * IT ALSO MAKES THE OUTPUT PURE ASCII, and that is not fussiness. The first
 * render of this email showed "Jordan&#226;&#8364;&#8482;s grandmother" and
 * "Open &#226;&#8364;&#8221; waiting" -- an apostrophe and an em dash arriving
 * as mojibake because nothing had told the renderer the bytes were UTF-8.
 *
 * A mail client's charset guess is not something this app controls, and the
 * text it is guessing about includes students' names. "Jos&#233;" rendering as
 * "JosÃ©" in six inboxes is a small disrespect the school would be sending
 * under its own name. Numeric entities render identically whatever the client
 * assumes, so the guess stops mattering.
 */
export function esc(raw: unknown): string {
  return String(raw ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    // Everything above ASCII becomes a numeric entity: accented names, curly
    // quotes, em dashes, emoji a teacher pasted in.
    .replace(/[\u0080-\uFFFF]/g, (c) => `&#${c.charCodeAt(0)};`);
}

function clamp(raw: unknown, max: number): string {
  const s = String(raw ?? "").trim();
  return s.length <= max ? s : s.slice(0, max) + "... [truncated]";
}

/**
 * First name and last initial, for the subject line only.
 *
 * Everyone on this list may know exactly which child it is, and the body says
 * so one line down. But a subject shows on a lock screen, in a notification
 * banner, and in an Outlook list over a shoulder in a meeting. Outlook searches
 * the body, so searching a surname still finds every one of that child's
 * referrals.
 */
export function shortName(full: unknown): string {
  const parts = String(full ?? "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "a student";
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1].charAt(0)}.`;
}

/** A date the way a person reads one, or the raw value if it cannot be parsed. */
export function whenText(raw: unknown): string {
  const s = String(raw ?? "").trim();
  if (!s) return "not recorded";
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  // PINNED TO THE SCHOOL'S CLOCK. Convex runs in UTC, and submittedAt is an
  // ISO instant, so without a timeZone a referral filed at 10:47 in the
  // morning arrived in six inboxes reading "5:47 PM". Every reader of this
  // email is in one time zone; hard-coding it is honest where guessing the
  // server's is wrong.
  return d.toLocaleString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    hour: "numeric", minute: "2-digit", timeZone: SCHOOL_TZ,
  });
}

export type MailPlan = {
  to: string[];
  subject: string;
  html: string;
  /** True when the payload's own filedByEmail disagrees with the token. */
  filerMismatch: boolean;
};

/**
 * The email, built from the stored referral and the verified filer.
 *
 * IT HAS TO STAND ALONE. One recipient, the Chief of Schools, has no account in
 * this app and cannot open anything. So the mail carries the whole record and
 * never says "log in to view".
 */
export function mailPlan(referral: any, filer: { email: string; name?: string }): MailPlan {
  const r = referral ?? {};
  const student = clamp(r.studentName, MAX_FIELD) || "a student";
  const grade = clamp(r.studentGrade, 20);
  const severe = r.severeBypass === true;
  const filerEmail = String(filer?.email ?? "").trim();
  const filerName = clamp(filer?.name, MAX_FIELD) || filerEmail;
  const filerMismatch =
    Boolean(r.filedByEmail) && norm(r.filedByEmail) !== norm(filerEmail);

  // THE SUBJECT IS NOT ENTITY-ENCODED, AND MUST NOT BE. It is a plain-text
  // header, not HTML: "&#233;" in a subject line renders as those six
  // characters, not as an e-acute. Graph takes the subject as a JSON string in
  // a UTF-8 body and the mail transport encodes the header properly (RFC
  // 2047), so raw text is the correct thing here and entities would be the
  // bug. The opposite rule applies to the body, where the client's charset
  // guess is not ours to control -- see esc().
  const subject = [
    severe ? "Immediate removal" : null,
    "Behavior referral",
    shortName(student),
    grade ? `Grade ${grade}` : null,
    clamp(r.behavior || r.behaviorType, 80) || null,
  ].filter(Boolean).join(" - ").replace(/\s+/g, " ").slice(0, 150);

  const row = (label: string, value: unknown) =>
    `<tr><td style="padding:3px 14px 3px 0;color:#667085;vertical-align:top;white-space:nowrap">${esc(label)}</td>` +
    `<td style="padding:3px 0;color:#14171C">${esc(value) || "<span style=\"color:#98a2b3\">not recorded</span>"}</td></tr>`;

  const section = (title: string, inner: string) =>
    `<h3 style="margin:22px 0 6px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#667085">${esc(title)}</h3>${inner}`;

  const interventions: string[] = Array.isArray(r.interventions) ? r.interventions : [];
  const description = clamp(r.description, MAX_DESCRIPTION);

  // Escape FIRST, then turn newlines into breaks. The other order would let a
  // typed "<br>" through as markup.
  const descHtml = esc(description).replace(/\n/g, "<br>");

  const parts: string[] = [];
  parts.push(
    `<p style="margin:0 0 14px">A behavior referral was filed at Westbrook Academy. Everything recorded on it is below. ` +
    `You do not need to open Wildcat Hub to read it.</p>`);

  if (severe) {
    parts.push(
      `<p style="margin:0 0 14px;padding:10px 12px;border-left:4px solid #f59e0b;background:#fffbeb;color:#78350f">` +
      `<strong>Immediate removal recorded.</strong> The teacher marked this incident too severe for classroom ` +
      `interventions &mdash; violence, a threat to safety, or similar. That is why no interventions are listed below.</p>`);
  }

  parts.push(section("The student",
    `<table style="border-collapse:collapse;font-size:14px">` +
    row("Student", student) + row("Student ID", r.studentId) +
    row("Grade", grade) + row("School", r.school) + `</table>`));

  parts.push(section("The incident",
    `<table style="border-collapse:collapse;font-size:14px">` +
    row("When", whenText(r.dateTime || r.date)) +
    row("Where", clamp(r.location, MAX_FIELD)) +
    row("Behavior", clamp(r.behavior || r.behaviorType, MAX_FIELD)) + `</table>`));

  if (description) {
    parts.push(section("What the teacher wrote",
      `<div style="padding:10px 14px;border-left:3px solid #E7ECF2;color:#14171C;font-size:14px;line-height:1.6">${descHtml}</div>` +
      `<p style="margin:6px 0 0;font-size:12px;color:#667085">&mdash; ${esc(filerName)} (${esc(filerEmail)})</p>`));
  }

  if (interventions.length) {
    parts.push(section("What was tried before this referral",
      `<ul style="margin:0;padding-left:20px;font-size:14px;line-height:1.7">` +
      interventions.map((i) => `<li>${esc(clamp(i, MAX_FIELD))}</li>`).join("") + `</ul>`));
  } else if (!severe) {
    parts.push(section("What was tried before this referral",
      `<p style="margin:0;font-size:14px;color:#667085">None were recorded on the form.</p>`));
  }

  const extra = clamp(r.additionalActions, MAX_DESCRIPTION);
  if (extra) {
    parts.push(section("Anything else the teacher did",
      `<p style="margin:0;font-size:14px;line-height:1.6">${esc(extra).replace(/\n/g, "<br>")}</p>`));
  }

  parts.push(section("The filing",
    `<table style="border-collapse:collapse;font-size:14px">` +
    row("Filed by", `${filerName} (${filerEmail})`) +
    row("Filed at", whenText(r.submittedAt)) +
    // A LITERAL DASH, NOT "&mdash;". This value goes through esc(), which turns
      // an ampersand into &amp; -- so a hand-written entity here rendered as the
      // visible text "&mdash;". esc() already converts the real character to
      // &#8212;, which is the whole point of it.
      row("Status", "Open — waiting for an administrator to review and close it") +
    row("Referral ID", r.id) + `</table>` +
    (filerMismatch
      ? `<p style="margin:8px 0 0;font-size:12px;color:#92400e">The referral record names a different filer ` +
        `(${esc(r.filedByEmail)}). The name above is the account that actually saved it.</p>`
      : "")));

  parts.push(
    `<p style="margin:22px 0 0;padding-top:14px;border-top:1px solid #E7ECF2;font-size:12px;line-height:1.6;color:#667085">` +
    `If this is your referral, this is your copy &mdash; check it matches what you entered. ` +
    `<strong>If anything is wrong, do not file a second referral</strong>, because that creates a duplicate record ` +
    `for the same incident. Tell an administrator so the original can be corrected.<br><br>` +
    `Sent by Wildcat Hub because a referral was saved. It is not a receipt: if a referral never reached the ` +
    `server, no email is sent and its absence proves nothing.</p>`);

  return {
    to: recipientsFor(filerEmail),
    subject,
    html:
      `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;` +
      `font-size:14px;line-height:1.6;color:#14171C;max-width:640px">${parts.join("")}</div>`,
    filerMismatch,
  };
}
