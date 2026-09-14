/**
 * The Wildcat Cash leaderboard, and where one student stands in it.
 *
 * IT LIVES ON THE SERVER, AND THAT IS THE WHOLE PRIVACY DESIGN. A student's
 * browser holds only their own record -- it has never had the roster -- so the
 * ordering has to be computed here, and here it can return the top few WITH
 * names and the viewer's own place WITHOUT anyone else's. Computing it in the
 * browser would mean shipping every child's earnings to every child, which is
 * the one thing a leaderboard must not do.
 *
 * Pure and dependency-free so a plain-node test can reach it, for the same
 * reason views.ts and accessRules.ts are.
 *
 * MEASURED ON EARNED, NOT BALANCE, and this is the decision to argue with.
 * Balance falls when a student spends, so a board built on it quietly punishes
 * using the store -- the one behaviour the whole economy exists to produce. A
 * child who hoards would outrank a child who earned more and bought a pencil.
 * Earned is a record of what they did; balance is what they have left.
 */

export const LEADERBOARD_BANDS = {
  academy: { key: "academy", label: "Academy", grades: null as number[] | null },
  hs: { key: "hs", label: "High School", grades: [9, 10, 11, 12] as number[] | null },
  ms: { key: "ms", label: "Middle School", grades: [6, 7, 8] as number[] | null },
};

export type BandKey = keyof typeof LEADERBOARD_BANDS;

export function bandOf(key: unknown) {
  const k = String(key ?? "").trim().toLowerCase();
  return (LEADERBOARD_BANDS as Record<string, typeof LEADERBOARD_BANDS.academy>)[k]
    ?? LEADERBOARD_BANDS.academy;
}

/** A grade as a number, or null. "9", " 9 ", "09", "Grade 9" all give 9. */
export function gradeNumber(grade: unknown): number | null {
  const m = /(\d+)/.exec(String(grade ?? "").trim());
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

export type LeaderStudent = {
  id?: unknown;
  firstName?: string;
  lastName?: string;
  grade?: string | null;
  enrolled?: boolean;
  wildcatCashEarned?: number | null;
  [k: string]: unknown;
};

/**
 * The id a student is known by, resolved the SAME WAY appDataShape.toAppStudent
 * resolves it: legacyId, then studentNumber, then the Convex row id.
 *
 * Raw rows out of ctx.db have `_id`, `legacyId` and `studentNumber` and no
 * `id` at all, so matching on `s.id` alone found nobody and every student was
 * told they were not ranked. The precedence has to match the app's, or the
 * viewer is compared against an identity the rest of the system does not use.
 */
export function studentIdOf(s: LeaderStudent): string {
  const anyS = s as Record<string, unknown>;
  const candidates = [anyS.id, anyS.legacyId, anyS.studentNumber, anyS._id];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
    if (typeof c === "number" && Number.isFinite(c)) return String(c);
  }
  return "";
}

/**
 * NOT `?? 0`. A student the sync has never sent an earned figure for is
 * unknown, and rendering unknown as zero puts a child at the bottom of a board
 * their whole year group can see, on the strength of a missing field.
 */
function earnedOf(s: LeaderStudent): number | null {
  const v = s?.wildcatCashEarned;
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

export function inBand(s: LeaderStudent, band: { grades: number[] | null }): boolean {
  if (!band.grades) return true;
  const g = gradeNumber(s?.grade);
  return g !== null && band.grades.includes(g);
}

export type LeaderboardResult = {
  band: string;
  bandLabel: string;
  total: number;
  unknownAmount: number;
  notYetEarned: number;
  top: Array<{ rank: number; studentId: string; name: string; grade: string | null; amount: number }>;
  viewer: { rank: number | null; of: number; amount: number | null; tiedWith: number; inBand: boolean } | null;
};

export function cashLeaderboard(opts: {
  students: LeaderStudent[];
  band?: unknown;
  topN?: number;
  viewerId?: unknown;
}): LeaderboardResult {
  const band = bandOf(opts.band);
  const topN = typeof opts.topN === "number" && opts.topN > 0 ? Math.min(opts.topN, 50) : 10;
  const viewerId = opts.viewerId === null || opts.viewerId === undefined ? null : String(opts.viewerId);

  const pool = (opts.students ?? []).filter(
    (s) => s && s.enrolled !== false && inBand(s, band),
  );

  const ranked: Array<{ s: LeaderStudent; amount: number; rank: number }> = [];
  let unknownAmount = 0;
  let notYetEarned = 0;
  for (const s of pool) {
    const amount = earnedOf(s);
    if (amount === null) { unknownAmount++; continue; }
    // A CHILD WHO HAS EARNED NOTHING IS NOT ON THE BOARD.
    //
    // FOUND ON LAUNCH EVE, 2026-09-13, hours before 619 students opened this
    // for the first time. The school had just reset every balance, so
    // wildcatCashEarned was 0 for all 759 -- and earnedOf accepts 0, because
    // `v >= 0`. Every student was therefore ranked, all tied at place 1, and
    // the panel would have told all 619 of them "You are #1 of 619 with $0.00
    // -- level with 618 others", above ten named classmates all showing
    // $0.00, all painted gold-podium, one of them also painted as you.
    //
    // The ten were not even arbitrary in a harmless way: the sort falls
    // through to last name, so the same ten children would have been on the
    // podium of every student's screen, for having earned nothing, because of
    // their surnames.
    //
    // Zero is not a rank. It is the absence of one. Counted separately so the
    // panel can still say how many are in the group, and the existing
    // "you are not ranked" copy -- which was written for exactly this shape --
    // now carries it. The moment one child earns a dollar the board appears
    // with one name on it, which is the right first state.
    if (amount === 0) { notYetEarned++; continue; }
    ranked.push({ s, amount, rank: 0 });
  }

  ranked.sort((a, b) => {
    if (b.amount !== a.amount) return b.amount - a.amount;
    const an = `${a.s.lastName ?? ""} ${a.s.firstName ?? ""}`.toLowerCase();
    const bn = `${b.s.lastName ?? ""} ${b.s.firstName ?? ""}`.toLowerCase();
    return an.localeCompare(bn);
  });

  // COMPETITION RANKING: 1, 2, 2, 4. Two students on the same amount hold the
  // same place and the next takes the place their count deserves. Children
  // check this against each other within a minute of a board appearing, and
  // any other scheme reads as the app picking a favourite.
  let place = 0;
  let lastAmount: number | null = null;
  ranked.forEach((r, i) => {
    if (lastAmount === null || r.amount !== lastAmount) { place = i + 1; lastAmount = r.amount; }
    r.rank = place;
  });

  let viewer: LeaderboardResult["viewer"] = null;
  if (viewerId !== null) {
    const mine = ranked.find((r) => studentIdOf(r.s) === viewerId);
    if (mine) {
      const tied = ranked.filter((r) => r.amount === mine.amount).length - 1;
      viewer = { rank: mine.rank, of: ranked.length, amount: mine.amount, tiedWith: tied, inBand: true };
    } else {
      // NOT RANKED. Two different reasons, and they must not share a sentence.
      //
      // `inBand` used to be false for both, so a child who is in this group
      // and has simply earned nothing was told "You are not in this group, try
      // the Academy board" -- which sends them somewhere that will say the
      // same thing. That became every student the moment zero stopped being a
      // rank, so on launch morning it would have been all 619.
      //
      // The pool is already band-filtered, so presence in it IS the answer.
      const inThisBand = pool.some((s) => studentIdOf(s) === viewerId);
      viewer = {
        rank: null, of: ranked.length, amount: null, tiedWith: 0,
        inBand: inThisBand,
      };
    }
  }

  return {
    band: band.key,
    bandLabel: band.label,
    total: ranked.length,
    unknownAmount,
    // In the band, with a real figure, and it is zero. Not an error and not
    // "unknown": they are simply not on the board yet.
    notYetEarned,
    // ONLY THE TOP ARE NAMED. The full ordering is computed so one student can
    // be told their own place; publishing all of it to six hundred children
    // would tell every one of them who has the least.
    top: ranked.slice(0, topN).map((r) => ({
      rank: r.rank,
      studentId: studentIdOf(r.s),
      name: `${r.s.firstName ?? ""} ${r.s.lastName ?? ""}`.trim(),
      grade: (r.s.grade ?? null) as string | null,
      amount: r.amount,
    })),
    viewer,
  };
}
