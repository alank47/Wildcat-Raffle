/**
 * The merge rule for a SIS roster sync. Pure, no Convex imports, so the one
 * property that matters can be tested directly rather than trusted.
 *
 * THE PROPERTY: a roster sync writes identity and enrollment, never balances.
 *
 * PowerSchool has no idea a child has 340 tickets or $12 of Wildcat Cash. Any
 * value it appears to offer for one of those is missing data, not a zero, and
 * writing it spends someone's money. So the patch is built from an ALLOWLIST
 * of SIS-owned fields. An earned field cannot be written even if a later edit
 * adds it to the incoming payload, because it is never read from there.
 *
 * A denylist would be the tempting shape and the wrong one: it fails open, so
 * the day someone adds `springCarnivalTickets` to the app it is silently
 * sync-writable until a human remembers to exclude it.
 */

/** Everything a child earned. Nothing here may ever be written by a sync. */
export const EARNED_FIELDS = [
  "pbisTickets",
  "attendanceTickets",
  "academicTickets",
  "bigRaffleQualified",
  "weeksQualified",
  "wildcatCashBalance",
  "wildcatCashEarned",
  "wildcatCashSpent",
  "wildcatCashDeducted",
  "wildcatCashRewardsRedeemed",
  "wildcatCashTransactions",
  "cashBalance",
  "cashTransactions",
] as const;

/** Everything the SIS owns and is allowed to update on an existing student. */
export const SIS_OWNED_FIELDS = [
  "firstName",
  "lastName",
  "grade",
  // PowerSchool is the record of truth for this, the same as grade. It is not
  // a restricted field (manifest 9, "Standard") and it is never earned, so a
  // sync may write it freely. It stays OUT of EARNED_FIELDS above for the same
  // reason grade does.
  "gender",
  "email",
  "school",
] as const;

export type StudentLike = Record<string, unknown>;

function normalizeEmail(email: unknown): string {
  return String(email ?? "").trim().toLowerCase();
}

/** The SIS-owned subset of an incoming record, normalized. */
export function sisFieldsFor(incoming: StudentLike): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of SIS_OWNED_FIELDS) {
    if (!(key in incoming)) continue;
    let value = incoming[key];
    if (key === "email") {
      value = normalizeEmail(value) || undefined;
    }
    if (key === "school" && value !== "middleschool" && value !== "highschool") {
      continue; // unrecognized school values are dropped, not guessed at
    }
    if (value === undefined || value === "") continue;
    out[key] = value;
  }
  return out;
}

/**
 * The patch to apply to an existing student. Returns ONLY changed SIS fields,
 * so an unchanged roster produces zero writes rather than 446 no-op patches.
 */
export function mergeStudent(
  prior: StudentLike,
  incoming: StudentLike,
): Record<string, unknown> {
  const sis = sisFieldsFor(incoming);
  const patch: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(sis)) {
    if (prior[key] !== value) patch[key] = value;
  }

  // Belt and braces. sisFieldsFor cannot emit an earned field, but this makes
  // the guarantee explicit at the boundary where the write happens, and it is
  // what the test asserts against.
  for (const earned of EARNED_FIELDS) {
    if (earned in patch) delete patch[earned];
  }

  return patch;
}
