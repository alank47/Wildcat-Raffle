/**
 * Pure identity rules. No Convex imports, no database, no I/O.
 *
 * Split out from identity.ts on purpose: this is the part that decides whether
 * someone is staff, a student, or refused, and it should be testable directly
 * rather than through a mirror of itself in a test file. A mirror can drift
 * from the real thing and still pass, which is worse than no test.
 */

export const STUDENT_DOMAIN = "westbrookacademy.org";
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
  if (!domain) throw new Error("Token carried no email address.");

  if (issuer === opts.staffIssuer) {
    if (domain !== normalizeEmail(opts.staffDomain)) {
      throw new Error("Not a staff account.");
    }
    return { kind: "staff", email };
  }

  if (issuer === GOOGLE_ISSUER) {
    if (domain !== STUDENT_DOMAIN) throw new Error("Not a student account.");
    return { kind: "student", email };
  }

  throw new Error("Unrecognized token issuer.");
}
