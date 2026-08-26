/**
 * Who may see restricted student data. Pure, so the policy is testable.
 *
 * The restricted set is fixed by the brief: federal ethnicity (7), federal race
 * (8), IEP (12), 504 (13), English Learner (14). It is not a judgement call
 * made per query.
 *
 * DEFAULT IS DENY FOR EVERYONE, INCLUDING ADMINS.
 *
 * The brief, Phase 5 point 3: "Decide and enforce, per role, which restricted
 * fields a teacher can see for students on their own roster. Default to the
 * narrowest option until someone with authority widens it." And its closing
 * question asks what decision federal race and ethnicity inform in a
 * teacher-facing dashboard, recommending descope if nobody can name one.
 *
 * Nobody has named one. So the answer today is: no role sees these fields,
 * and the data is not even loaded. Widening this is a deliberate act by a
 * named person, recorded in ALLOWED_BY_ROLE below, not an accident of someone
 * adding a column to a view.
 */

export const RESTRICTED_FIELDS = [
  "fedEthnicity",   // manifest 7
  "raceCodes",      // manifest 8, one-to-many, never collapsed
  "iepStatus",      // manifest 12, source still unconfirmed
  "section504",     // manifest 13, source still unconfirmed
  "elaStatus",      // manifest 14
] as const;

export type RestrictedField = (typeof RESTRICTED_FIELDS)[number];

/**
 * Per-role allowlist. Empty for every role, on purpose.
 *
 * To widen: add the field to the role's list, record WHO approved it and WHAT
 * decision it informs in docs/field-sourcing.md, and add a test asserting the
 * roles that still cannot see it. An entry here without those two things is
 * not a decision, it is a leak with a commit message.
 */
export const ALLOWED_BY_ROLE: Record<string, RestrictedField[]> = {
  teacher: [],
  // EMPTY, deliberately, and this is the point of the pbis role.
  //
  // PBIS reviews discipline patterns, which needs COUNTS BY RACE, not any
  // child's race. Those are different permissions and only the first was
  // asked for. Aggregates come from disciplineAggregates.ts, which never
  // returns a student row, so PBIS needs nothing here to do its job.
  //
  // Decided 2026-08-19 with the app owner, who was explicit: "I am not
  // looking to see an individual child's race."
  //
  // NOTE: admin and superadmin below WERE later widened, for verification.
  // That does not extend to pbis, and the gap is the whole design.
  pbis: [],
  campusaide: [],
  // WIDENED 2026-08-19 by Alan K (app owner). Recorded in
  // docs/field-sourcing-approval.md, which is what the note above asks for.
  //
  // The stated decision it informs: verifying that the aggregate breakdown is
  // counting and displaying correctly. An aggregate nobody can check against a
  // source is a number taken on faith, and this one is used to make claims
  // about how the school disciplines children by race.
  //
  // This is genuinely WIDER than the aggregate-only grant that preceded it.
  // Deliberately still excludes teacher, campusaide and pbis: PBIS reviews
  // patterns and asked for counts, not children.
  admin: ["fedEthnicity", "raceCodes"],
  superadmin: ["fedEthnicity", "raceCodes"],
};

export type Decision = {
  allowed: RestrictedField[];
  denied: RestrictedField[];
  /** True when the role may see nothing restricted at all. */
  fullyDenied: boolean;
};

export function restrictedFor(role: string): Decision {
  const allowed = ALLOWED_BY_ROLE[role] ?? [];
  const denied = RESTRICTED_FIELDS.filter((f) => !allowed.includes(f));
  return { allowed: [...allowed], denied, fullyDenied: allowed.length === 0 };
}

/**
 * Strips every restricted field a role may not see.
 *
 * Takes the whole record and removes, rather than picking allowed fields out,
 * because this one is applied to data that may legitimately carry other keys.
 * The allowlist discipline still applies at the view layer above it; this is
 * the second line specifically for the restricted set.
 */
export function redactRestricted<T extends Record<string, unknown>>(
  row: T,
  role: string,
): Partial<T> {
  const { denied } = restrictedFor(role);
  const out: Record<string, unknown> = { ...row };
  for (const f of denied) delete out[f];
  return out as Partial<T>;
}
