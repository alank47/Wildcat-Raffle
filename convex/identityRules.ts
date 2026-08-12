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
export const STUDENT_DOMAINS = ["westbrookacademy.org", "rwwnms.org"] as const;

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
      throw new ConvexError("Not a student account.");
    }
    return { kind: "student", email };
  }

  throw new ConvexError("Unrecognized token issuer.");
}
