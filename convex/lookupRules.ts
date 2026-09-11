/**
 * Matching a person to what somebody typed.
 *
 * Pure and dependency-free so a plain-node test reaches it, same as
 * academicsRules.ts, courseSubject.ts, seniorEligibility.ts and
 * referralMailRules.ts. convex/staffLookup.ts imports ./_generated/server and
 * therefore cannot be imported by a test at all, which is the whole reason
 * these two predicates live here instead of inline beside their query.
 */

/**
 * Does this record match what was typed?
 *
 * EXPORTED AND PURE so a test can reach it. These two started as inline
 * filters, and the staff one silently drifted: it matched a name while the
 * student one matched a name OR an identifier, so "ericp@" reported a real
 * account as absent. Two predicates in one place cannot drift apart unnoticed.
 */
export function matchesStaff(needle: string, t: { name?: unknown; email?: unknown }): boolean {
  const q = needle.trim().toLowerCase();
  if (!q) return false;
  const name = String(t.name ?? "").toLowerCase();
  const email = String(t.email ?? "").toLowerCase();
  // The local part too, so "ericp" finds ericp@lapromisefund.org without
  // anybody having to type the domain.
  const local = email.split("@")[0] ?? "";
  return name.includes(q) || email.includes(q) || (local !== "" && local === q);
}

export function matchesStudent(
  needle: string,
  s: { firstName?: unknown; lastName?: unknown; studentNumber?: unknown; email?: unknown },
): boolean {
  const q = needle.trim().toLowerCase();
  if (!q) return false;
  const first = String(s.firstName ?? "").toLowerCase();
  const last = String(s.lastName ?? "").toLowerCase();
  const email = String(s.email ?? "").toLowerCase();
  return `${first} ${last}`.includes(q) || `${last}, ${first}`.includes(q) ||
    String(s.studentNumber ?? "").toLowerCase().includes(q) || email.includes(q);
}
