import { ConvexError } from "convex/values";

/**
 * Pure identity rules. No database, no I/O, no ctx.
 *
 * Split out from identity.ts on purpose: this is the part that decides whether
 * someone is staff, a student, or refused, and it should be testable directly
 * rather than through a mirror of itself in a test file. A mirror can drift
 * from the real thing and still pass, which is worse than no test.
 *
 * ConvexError, not Error, on every throw. Convex REDACTS a plain Error in
 * production and the caller sees "Server Error" with a request id. These
 * messages are the difference between a teacher reading "no staff record for
 * your address" and an admin guessing for an hour, so they have to survive.
 */

/**
 * Student domains. There is MORE THAN ONE, and assuming otherwise locked real
 * students out.
 *
 * Verified against the PowerSchool New Students list on 2026-08-12. Currently
 * enrolled Westbrook Academy students hold addresses on both:
 *
 *   ms10826@westbrookacademy.org   Sierra, Matthew, 10826, grade 11
 *   magat10856@rwwnms.org          Agaton Colin, Maria, 10856, grade 12
 *
 * Both are at school WA. `rwwnms.org` is Russell Westbrook Why Not? Middle
 * School, which appears in enrollment histories as the school students promote
 * FROM, and they keep the address when they arrive. So a student who came up
 * through the middle school signs in on a different domain from one who did not,
 * and both are equally legitimate.
 *
 * A single domain constant refused every one of the first group with
 * "Not a student account", which reads like a bug in their account rather than
 * in ours.
 *
 * This is a list, and it is still exact equality per entry, never endsWith or a
 * suffix match. Adding a domain here admits every Google account in that
 * workspace, so it takes the same care as adding a staff domain.
 */
/**
 * The ONE domain students sign in on.
 *
 * `rwwnms.org` and `rwwnhs.org` appear on 9 PowerSchool records and are
 * RETIRED domains, confirmed by the user 2026-08-12. They are not accepted.
 * Nine students carrying one is a stale SIS record, not a second valid identity.
 */
export const STUDENT_DOMAINS = ["westbrookacademy.org"] as const;

/**
 * Domains seen in real PowerSchool records that are REFUSED, each with the
 * reason, because the reason is the difference between somebody fixing a
 * student record in thirty seconds and somebody debugging the auth layer.
 *
 * None of these is admitted. Admitting a domain admits every Google account in
 * that workspace, so a retired domain and a misspelled one are equally
 * unacceptable however sympathetic the affected student is. What is negotiable
 * is only whether the refusal explains itself.
 *
 * Counts measured against the live instance on 2026-08-12.
 */
export const REFUSED_DOMAINS: Record<string, string> = {
  // 1 record: student 11895, ep11895@westrbookacademy.org. A transposition of
  // "westbrook", and the local part matches the real convention exactly.
  "westrbookacademy.org":
    'looks like a misspelling of "westbrookacademy.org". The address is almost ' +
    "certainly wrong in PowerSchool rather than wrong here",

  // 8 records. Russell Westbrook Why Not? Middle School, retired.
  "rwwnms.org":
    "is a retired school domain that is no longer used for sign in. The student " +
    "record still carries an old address",

  // 1 record: student 11306. Russell Westbrook Why Not? High School, retired.
  "rwwnhs.org":
    "is a retired school domain that is no longer used for sign in. The student " +
    "record still carries an old address",
};

/**
 * Kept as the primary domain for anything that must name one, such as the
 * Google sign in hint. It is NOT the authorization boundary: STUDENT_DOMAINS is.
 */
export const STUDENT_DOMAIN = STUDENT_DOMAINS[0];

export const GOOGLE_ISSUER = "https://accounts.google.com";
export const ENTRA_ISSUER_PREFIX = "https://login.microsoftonline.com/";

/**
 * Entra issues the email claim with directory casing, frequently
 * First.Last@domain, while records hold first.last@domain. An exact compare then
 * fails and the user is bounced with no error. Both sides of every comparison go
 * through this, at write time and at read time.
 */
export function normalizeEmail(email: string | undefined | null): string {
  return (email ?? "").trim().toLowerCase();
}

export function emailDomain(email: string | undefined | null): string {
  const n = normalizeEmail(email);
  const at = n.lastIndexOf("@");
  return at === -1 ? "" : n.slice(at + 1);
}

export type Identity =
  | { kind: "staff"; email: string }
  | { kind: "student"; email: string };

/**
 * Decides who someone is from provider + domain TOGETHER.
 *
 * Either check alone is a privilege escalation. Domain alone lets a Google
 * account on the staff domain award tickets. Provider alone lets any Google
 * account on earth in, because Google's issuer is shared by every Google user.
 *
 * Domain comparison is exact equality, never endsWith, because endsWith accepts
 * a@b.westbrookacademy.org.evil.com.
 *
 * Tenant isolation for staff comes from the issuer being tenant specific, so
 * `staffIssuer` must be the full expected issuer for THIS organization's tenant.
 * Matching only the microsoftonline.com prefix would accept a token from any
 * Microsoft tenant, and anyone can create a tenant and mint an address in it.
 */
export function classify(
  issuer: string,
  rawEmail: string | undefined | null,
  opts: { staffDomain: string; staffIssuer: string },
): Identity {
  const email = normalizeEmail(rawEmail);
  const domain = emailDomain(email);
  if (!domain) throw new ConvexError("Token carried no email address.");

  if (issuer === opts.staffIssuer) {
    if (domain !== normalizeEmail(opts.staffDomain)) {
      throw new ConvexError("Not a staff account.");
    }
    return { kind: "staff", email };
  }

  if (issuer === GOOGLE_ISSUER) {
    // Exact equality against each entry, never a suffix match, for the same
    // reason as the staff check above.
    if (!STUDENT_DOMAINS.some((d) => domain === d)) {
      // Still refused. The only difference is whether the person reading it
      // learns the SIS record is stale, or concludes sign in is broken.
      const why = REFUSED_DOMAINS[domain];
      if (why) {
        throw new ConvexError(
          `The domain "${domain}" ${why}. Ask the office to update the student's ` +
            `email to an @${STUDENT_DOMAINS[0]} address on Student Profile > Email ` +
            `in PowerSchool, then sign in again.`,
        );
      }
      throw new ConvexError("Not a student account.");
    }
    return { kind: "student", email };
  }

  throw new ConvexError("Unrecognized token issuer.");
}

/**
 * Whether a resolved student record may still act.
 *
 * A VALID TOKEN IS NOT ENROLMENT. sisSync.ts:92 archives a student who stops
 * appearing on the PowerSchool roster, and archives them correctly: it keeps the
 * row, the balance and the email, because a transfer still has money and a
 * roster gap is not proof a person ceased to exist. But nothing read that flag
 * at the door. A withdrawn student whose Google account still works kept full
 * access, and the student portal turned that from reading their own card into
 * WRITING hall pass and tap records: somebody who left in October could open a
 * pass in November and appear on a teacher's live board as a child currently out
 * of the building.
 *
 * THE MESSAGE IS SPECIFIC ON PURPOSE, and this is not a nicety. `archivedAt` is
 * set by a sync, and a sync that runs against a partial roster archives students
 * who never left. The person reading this refusal is a real child standing at a
 * door being told the system does not recognise them, so it has to say what is
 * wrong, that their work is not lost, and exactly who fixes it. A generic
 * "Not authorized" would send them away with nothing and send the office to
 * debug sign-in.
 *
 * Returns a verdict rather than throwing, and lives here rather than in
 * identity.ts, so both the rule and its wording are directly testable.
 */
export function studentRecordVerdict(student: {
  archivedAt?: string | null;
}): { ok: boolean; reason: string } {
  if (student.archivedAt) {
    return {
      ok: false,
      reason:
        "Your account is not on the current PowerSchool roster, so it is on " +
        "hold. Nothing you earned has been deleted: your tickets and Wildcat " +
        "Cash are still on your record and come back as soon as you are on the " +
        "roster again. If you are still a student here, see the office and ask " +
        "them to check your enrollment.",
    };
  }
  return { ok: true, reason: "" };
}

/**
 * studentNumber -> the ONE address that student signs in with.
 *
 * Lives here, beside STUDENT_DOMAINS and REFUSED_DOMAINS, because choosing
 * which address becomes a join key is the same decision as choosing which
 * address may authenticate. Splitting them is how the two drift apart and a
 * roster row ends up keyed to an address `classifyIdentity` would reject.
 *
 * FIRST ROW PER STUDENT WINS. The student_email PowerQuery orders by
 * IsPrimaryEmailAddress, so first means primary, and `setStudentEmails` uses
 * the same rule. Both must agree, or a student with two addresses gets their
 * `students` row keyed to one and their schedule keyed to the other.
 *
 * REFUSES what could never sign in: a retired domain (rwwnms.org), a
 * misspelling (westrbookacademy.org), anything that merely ends with our name.
 * Exact equality on the domain, never a suffix match.
 */
export function primaryEmailByStudentNumber(
  rows: readonly {
    studentNumber: string;
    email: string;
    isPrimary?: string | number | null;
  }[],
): Map<string, string> {
  const byNumber = new Map<string, string>();

  for (const row of rows) {
    const number = String(row.studentNumber ?? "").trim();
    if (!number || byNumber.has(number)) continue;

    const email = normalizeEmail(row.email);
    if (!email.includes("@")) continue;
    if (!STUDENT_DOMAINS.some((d) => d === emailDomain(email))) continue;

    byNumber.set(number, email);
  }

  return byNumber;
}
