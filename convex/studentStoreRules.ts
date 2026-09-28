/**
 * Whether a STUDENT may buy a reward, and what the purchase does. Pure: no
 * ctx, no clock, no database.
 *
 * WHAT IS NEW AND WHY IT NEEDS THIS MUCH CARE. Until now a child's tap could
 * not move Wildcat Cash. The student portal is four queries and no mutations;
 * the only student write path that exists at all is hall passes, and those are
 * closed. This is the first code path where a 12-year-old spends money, and it
 * will be used by hundreds of them at once, faster than any adult uses the app.
 *
 * SO THE SERVER OWNS THE PRICE. The mutation takes a reward id and a quantity.
 * It does not take a cost, a total, or a balance. Every money incident in this
 * repo's history was a number the browser supplied and the server trusted --
 * the 2026-09-13 resurrection was a stale tab re-sending 336 balances it
 * remembered. An argument that does not exist cannot be forged by a child who
 * has found the developer console, and some of them will.
 *
 * THESE RULES MIRROR wildcat-store.js `canPurchase` / `buildPurchase`, which
 * the staff store has used in production since before this existed -- four
 * receipts, one of them cancelled and refunded. There is no bundler in this
 * project (index.html loads plain <script> tags), so the client module cannot
 * be imported here and this is a deliberate duplicate. studentStore.test.mjs
 * pins the two against each other on the same inputs, because the day they
 * disagree is the day a child is charged a price the receipt does not show.
 *
 * WHAT THIS ADDS ON TOP OF THE STAFF RULES, all of them refusals:
 *   - the store has to be OPEN (a server-owned switch, so it can be shut
 *     without a deploy and without asking anyone to refresh)
 *   - the reward has to be marked for student purchase (`studentPurchasable`),
 *     because an adult handing over a Lunch with Teacher is not the same
 *     transaction as a child buying one unsupervised
 *   - the student has to be enrolled
 *   - quantity is capped, because a spinner a child can hold down is a
 *     spinner a child will hold down
 */

/** The most of one thing a student may buy in a single go. */
export const MAX_STUDENT_QUANTITY = 5;

/**
 * What a child is told when the store is shut and nobody set a message.
 *
 * ONE STRING, exported, because there were briefly two: this module's fallback
 * and another inside the appState reader. Two defaults for the same sentence
 * means the message a student sees depends on which code path noticed the
 * store was closed, and nobody would ever find out which.
 */
export const STORE_CLOSED_DEFAULT = "The store is closed right now.";

export type StoreReward = {
  id?: string;
  name?: string;
  cost?: number;
  description?: string;
  category?: string;
  /** null means unlimited. 0 means genuinely out of stock. */
  stock?: number | null;
  available?: boolean;
  retiredAt?: string | null;
  /**
   * Whether a STUDENT may buy this, as opposed to an adult buying it for them.
   * Absent is treated as FALSE: a catalogue written before this field existed
   * must not become self-serve the moment the code ships.
   */
  studentPurchasable?: boolean;
  /**
   * Which campus may buy it: "all", "middle" (grades 6-8) or "high" (9-12).
   * Absent means "all", which is every reward written before this existed.
   * Anything else is a typo, and a typo is refused rather than guessed at.
   */
  campus?: string | null;
  /**
   * The most one student may ever hold, counting every receipt that was not
   * cancelled. Null or absent means no limit.
   */
  limitPerStudent?: number | null;
  /**
   * Whether the OTHER campus may see a campus-only reward (they still cannot
   * buy it). Absent or false hides it, which is how the first sale ran. The
   * owner asked for this to be a switch (2026-09-28): "is middle schoolers only
   * seeing middle school pass a feature that i can click on/off?"
   */
  showOtherCampus?: boolean;
  /**
   * What the child is told once they have bought it -- where to go, when, what
   * to bring. Shown in the receipt dialog and kept beside the receipt code in
   * "Your purchases". Asked for 2026-09-28: "Id like to convey information to
   * students when they purchase the pass."
   */
  purchaseMessage?: string | null;
};

/** The longest purchase message an admin may write. A dialog, not a letter. */
export const PURCHASE_MESSAGE_MAX = 500;

/**
 * The reward's purchase message, trimmed, or null when there is none. Capped
 * here as well as in the form, so a message saved some other way cannot turn
 * a receipt into a wall of text.
 */
export function purchaseMessageOf(reward: StoreReward | null | undefined): string | null {
  const raw = reward?.purchaseMessage;
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  return t ? t.slice(0, PURCHASE_MESSAGE_MAX) : null;
}

/** The campuses a reward can be restricted to. "all" is the absence of one. */
export const CAMPUSES = ["all", "middle", "high"] as const;
export type Campus = (typeof CAMPUSES)[number];

/**
 * Which campus a reward is for, or null when the field holds something that
 * is not a campus.
 *
 * NULL IS A REFUSAL, NOT "EVERYONE". Reading an unrecognised value as "all"
 * would turn a mistyped "Middle " into a pass the whole school can buy, which
 * is the one outcome the owner asked this to prevent ("we dont want to sort
 * through the data as to who bought").
 */
export function rewardCampus(reward: StoreReward | null | undefined): Campus | null {
  const raw = reward?.campus;
  if (raw === undefined || raw === null || raw === "") return "all";
  const v = String(raw).trim().toLowerCase();
  return (CAMPUSES as readonly string[]).includes(v) ? (v as Campus) : null;
}

/**
 * The campus a grade belongs to. The school is 6-12 and every enrolled record
 * holds a bare number (measured 2026-09-27: 763 students, grades 6 to 12, no
 * other values), so anything outside that range is unknown rather than
 * rounded to the nearer campus.
 */
export function studentCampus(grade: unknown): "middle" | "high" | null {
  const n = parseInt(String(grade ?? "").trim(), 10);
  if (!Number.isFinite(n)) return null;
  if (n >= 9 && n <= 12) return "high";
  if (n >= 6 && n <= 8) return "middle";
  return null;
}

/** "Middle School" / "High School", for the words a child reads. */
export function campusLabel(c: Campus | "middle" | "high"): string {
  return c === "high" ? "High School" : c === "middle" ? "Middle School" : "everyone";
}

/**
 * The per-student limit, or null for none. Undefined when the field holds
 * something that is not a whole number of one or more -- refused, like a
 * campus typo, because reading "0" or "one" as "no limit" is the wrong way to
 * be wrong.
 */
export function rewardLimit(reward: StoreReward | null | undefined): number | null | undefined {
  const raw = reward?.limitPerStudent;
  if (raw === undefined || raw === null || (raw as unknown) === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || Math.floor(n) !== n || n < 1) return undefined;
  return n;
}

/**
 * How many of one reward a student already holds: every unit on a receipt
 * that was not cancelled, bought by them or for them by an adult.
 *
 * Counted from RECEIPTS, not from the purchase register, because the register
 * only knows about self-serve buys. A pass an adult bought for a child at the
 * office is still a pass that child holds. A cancelled receipt does not count,
 * so a refunded purchase gives the child their chance back.
 */
export function ownedUnits(
  receipts: Array<Record<string, any> | null | undefined>,
  studentAppId: string,
  rewardId: string,
): number {
  const who = String(studentAppId ?? "");
  const what = String(rewardId ?? "");
  if (!who || !what) return 0;
  let n = 0;
  for (const r of receipts || []) {
    if (!r || String(r.studentId ?? "") !== who || String(r.rewardId ?? "") !== what) continue;
    if (r.status === "cancelled") continue;
    const q = Number(r.quantity);
    n += Number.isFinite(q) && q > 0 ? q : 1;
  }
  return n;
}

/** How long a dry-run testers list lasts before it lapses on its own. */
export const TESTERS_TTL_MS = 3 * 60 * 60 * 1000;

/**
 * Whether the store is open at `nowMs`, from the stored switch.
 *
 * THE CLOSING TIME IS CHECKED HERE AS WELL AS BY THE SCHEDULER. The scheduler
 * flips the switch at the time, which is what tells every cached query the
 * answer changed. But a purchase is a mutation, never cached, and it must not
 * depend on a scheduled job having run: a sale that "closes at 11:59" and
 * keeps selling because a job was delayed is a promise broken to the other
 * campus. So a purchase reads the clock too.
 *
 * The OPENING time is deliberately NOT read from the clock. If the scheduled
 * opening failed to run, the store stays shut -- the safe way to fail -- and
 * the admin panel says it has not opened.
 */
export function effectiveStoreState(
  value: Record<string, unknown> | null | undefined,
  nowMs: number,
  /** The student asking, if any: a dry-run tester may buy while it is shut. */
  studentNumber?: string | null,
): { open: boolean; reason: string; opensAt: string | null; closesAt: string | null; testing: boolean } {
  const v = (value ?? {}) as Record<string, unknown>;
  const closesAt = typeof v.closesAt === "string" && v.closesAt ? v.closesAt : null;
  const opensAt = typeof v.opensAt === "string" && v.opensAt ? v.opensAt : null;
  const closeMs = closesAt ? Date.parse(closesAt) : NaN;
  const pastClose = Number.isFinite(closeMs) && nowMs >= closeMs;
  // Past the close but before the scheduled job has run: the "has ended"
  // message, not the "opens Tuesday" one it was showing beforehand.
  const ended = typeof v.endedReason === "string" && v.endedReason ? v.endedReason : null;
  const before = typeof v.reason === "string" && v.reason ? v.reason : null;
  const reason = (pastClose ? ended : before) || STORE_CLOSED_DEFAULT;
  const everyone = v.open === true && !pastClose;
  // A DRY-RUN TESTER sees the store open while it is shut to everybody else --
  // but only until testersUntil, so a list nobody remembered to clear cannot
  // keep a back door open after the rehearsal.
  const untilMs = typeof v.testersUntil === "string" ? Date.parse(v.testersUntil) : NaN;
  const who = String(studentNumber ?? "").trim();
  const testing = !everyone && !!who && Array.isArray(v.testers) &&
    (v.testers as unknown[]).map(String).includes(who) &&
    Number.isFinite(untilMs) && nowMs < untilMs;
  return {
    open: everyone || testing,
    reason,
    opensAt,
    closesAt,
    testing,
  };
}

export type StoreStudent = {
  id?: string;
  firstName?: string;
  lastName?: string;
  grade?: string;
  wildcatCashBalance?: number;
  enrolled?: boolean;
  archivedAt?: string | null;
};

export type Verdict = {
  allowed: boolean;
  code: string;
  reason: string;
  total?: number;
  shortfall?: number;
};

const ok = (total: number): Verdict => ({ allowed: true, code: "ok", reason: "", total });

/** A whole number of one or more, within the cap. Anything else is refused. */
export function normalizeQuantity(raw: unknown): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n) || Math.floor(n) !== n) return null;
  if (n < 1 || n > MAX_STUDENT_QUANTITY) return null;
  return n;
}

/**
 * May this student buy this reward, right now?
 *
 * ORDERED BY WHAT THE CHILD NEEDS TO READ. "The store is closed" comes before
 * every complaint about their balance, because a shut store is not their
 * fault and telling them they are poor first is unkind and also wrong.
 *
 * Every `reason` here is written to be read BY A STUDENT. No field names, no
 * ids, no mention of the catalogue. "That one is not in the student store"
 * rather than "studentPurchasable is false".
 */
export function studentPurchaseVerdict(opts: {
  student: StoreStudent | null | undefined;
  reward: StoreReward | null | undefined;
  quantity?: unknown;
  storeOpen: boolean;
  closedReason?: string;
  /** Units of this reward the student already holds. See ownedUnits. */
  alreadyOwned?: number;
  /**
   * The price the child was SHOWN. Never used to charge -- the charge is
   * always the catalogue's cost -- only to refuse when the two differ, so a
   * repricing between the card loading and the tap cannot take more than the
   * button said. Absent means the caller did not say, which is allowed.
   */
  seenPrice?: unknown;
}): Verdict {
  const { student, reward, storeOpen, closedReason } = opts;

  if (!storeOpen) {
    return {
      allowed: false,
      code: "store_closed",
      reason: closedReason || STORE_CLOSED_DEFAULT,
    };
  }
  if (!student) {
    return { allowed: false, code: "no_student", reason: "We could not find your account." };
  }
  if (student.archivedAt || student.enrolled === false) {
    return {
      allowed: false,
      code: "not_enrolled",
      reason: "Your account is not active. Please ask in the office.",
    };
  }
  if (!reward) {
    return { allowed: false, code: "no_reward", reason: "That reward is no longer listed." };
  }
  if (reward.retiredAt) {
    return { allowed: false, code: "retired", reason: "That reward is no longer available." };
  }
  if (reward.available === false) {
    return { allowed: false, code: "unavailable", reason: "That reward is not available right now." };
  }
  // ABSENT IS FALSE. Five of the six rewards in this catalogue predate the
  // field; none of them should become self-serve just because this shipped.
  if (reward.studentPurchasable !== true) {
    return {
      allowed: false,
      code: "not_self_serve",
      reason: "That one is not in the student store. Ask a teacher about it.",
    };
  }

  // THE CAMPUS. Before quantity and price, because "that one is for the other
  // campus" is the true answer and "you need $300 more" would be a false one.
  const forCampus = rewardCampus(reward);
  if (forCampus === null) {
    return {
      allowed: false,
      code: "bad_campus",
      reason: "That one is not set up properly yet. Please tell a teacher.",
    };
  }
  if (forCampus !== "all") {
    const mine = studentCampus(student.grade);
    if (mine === null) {
      return {
        allowed: false,
        code: "unknown_campus",
        reason: "We could not tell which campus you are on. Please ask in the office.",
      };
    }
    if (mine !== forCampus) {
      return {
        allowed: false,
        code: "wrong_campus",
        reason: `That one is only for ${campusLabel(forCampus)} students.`,
      };
    }
  }

  const quantity = normalizeQuantity(opts.quantity ?? 1);
  if (quantity === null) {
    return {
      allowed: false,
      code: "bad_quantity",
      reason: `Choose between 1 and ${MAX_STUDENT_QUANTITY}.`,
    };
  }

  // THE PER-STUDENT LIMIT. Counted from every live receipt, so buying one at
  // the office and one on a Chromebook is still two.
  const limit = rewardLimit(reward);
  if (limit === undefined) {
    return {
      allowed: false,
      code: "bad_limit",
      reason: "That one is not set up properly yet. Please tell a teacher.",
    };
  }
  if (limit !== null) {
    const owned = Math.max(0, Number(opts.alreadyOwned) || 0);
    if (owned >= limit) {
      return {
        allowed: false,
        code: "limit_reached",
        reason: limit === 1
          ? "You already have this one. It is limited to one per student."
          : `You already have ${owned}. It is limited to ${limit} per student.`,
      };
    }
    if (owned + quantity > limit) {
      return {
        allowed: false,
        code: "limit_reached",
        reason: `You can buy ${limit - owned} more of these.`,
      };
    }
  }

  const cost = Number(reward.cost);
  if (!Number.isFinite(cost) || cost <= 0) {
    // A FREE OR UNPRICED REWARD IS NOT A BARGAIN, IT IS A BUG. Selling it for
    // nothing would be a silent stock giveaway, so it is refused rather than
    // handed out while somebody works out what happened.
    return {
      allowed: false,
      code: "no_price",
      reason: "That reward has no price set. Please tell a teacher.",
    };
  }

  // THE PRICE THEY SAW. Prices are set on demand and can move while a card is
  // on screen; the button said one number, and the child agreed to that one.
  if (opts.seenPrice !== undefined && opts.seenPrice !== null) {
    const seen = Number(opts.seenPrice);
    if (!Number.isFinite(seen) || seen !== cost) {
      return {
        allowed: false,
        code: "price_changed",
        reason: `The price just changed to $${cost}. Check it and press Buy again if you still want it.`,
      };
    }
  }

  // STOCK IS CHECKED HERE AND AGAIN IN THE MUTATION, inside the transaction.
  // This function cannot hold a lock, and two children tapping the last item
  // in the same second is not a hypothetical at a school of 620.
  if (reward.stock != null && reward.stock < quantity) {
    return {
      allowed: false,
      code: Number(reward.stock) === 0 ? "out_of_stock" : "low_stock",
      reason: Number(reward.stock) === 0
        ? "That one has sold out."
        : `Only ${reward.stock} left — choose ${reward.stock} or fewer.`,
    };
  }

  const total = cost * quantity;
  const balance = Number(student.wildcatCashBalance) || 0;
  if (balance < total) {
    return {
      allowed: false,
      code: "cannot_afford",
      reason: `You have $${balance} and this costs $${total}. ` +
              `You need $${total - balance} more.`,
      total,
      shortfall: total - balance,
    };
  }

  return ok(total);
}

/**
 * The counter movement for a purchase.
 *
 * `spent` goes UP and the balance goes DOWN, and `earned` is untouched -- the
 * same shape recordCashTransaction produces for `kind: 'redeem'`. Getting this
 * wrong is what put Maria Agaton Colin in a red intervention table: a purchase
 * counted as a deduction reads as a child being punished for buying something.
 */
export function purchaseCounterDelta(total: number): Record<string, number> {
  const t = Math.abs(Number(total) || 0);
  return { wildcatCashBalance: -t, wildcatCashSpent: t };
}

/**
 * The receipt, in the shape wildcat-store.js buildPurchase produces.
 *
 * IDENTICAL FIELDS ON PURPOSE. The staff store's fulfil and cancel paths read
 * these receipts, and `canFulfill` / `canCancel` / `applyFulfill` /
 * `buildCancel` already work -- a student purchase that produced a
 * differently-shaped receipt would be un-fulfillable and un-refundable by
 * every screen that exists. The `channel: 'student'` branch was already in
 * buildPurchase before any of this was written.
 *
 * The snapshot fields (rewardName, unitCost) matter MORE HERE THAN USUAL. The
 * owner sets prices from the school's balance distribution shortly before a
 * release -- so a reward's cost is expected to move, by design, possibly the
 * day after somebody bought one. Without the snapshot, a repricing would
 * rewrite history: last week's receipt would claim a child paid this week's
 * price, and the purchase log exported for a parent would not match the cash
 * that actually left their account.
 */
export function buildStudentReceipt(opts: {
  receiptId: string;
  student: StoreStudent;
  /**
   * THE APP-FACING STUDENT ID, PASSED EXPLICITLY AND NEVER GUESSED.
   *
   * This read `student.id`, and the mutation hands it a RAW Convex row, which
   * has `_id` and `legacyId` and no `id` at all -- so it wrote an empty string.
   * toAppStudent is the thing that maps `legacyId ?? _id` to `id`, and the
   * server never goes through it.
   *
   * The damage was silent and two steps away: the staff cancel path does
   * `students.find(s => s.id === receipt.studentId)`, found nobody for "",
   * handed buildCancel `student: undefined`, and buildCancel only builds a
   * refund `if (refund && o.student)` -- so the receipt cancelled, the toast
   * said "cancelled and refunded", and $100 never went back. A required
   * argument cannot be forgotten the way an optional field can be misread.
   */
  studentAppId: string;
  reward: StoreReward;
  quantity: number;
  nowIso: string;
}): Record<string, unknown> {
  const { receiptId, student, studentAppId, reward, quantity, nowIso } = opts;
  const appId = String(studentAppId ?? "").trim();
  if (!appId) {
    // LOUD. An empty student id produces a receipt nothing can refund, and the
    // failure only shows up when somebody tries to cancel it.
    throw new Error("buildStudentReceipt: studentAppId is required and was empty.");
  }
  const total = Number(reward.cost) * quantity;
  const grade = String(student.grade ?? "").trim();
  const gradeNum = parseInt(grade, 10);

  return {
    id: receiptId,
    studentId: appId,
    studentName: `${student.firstName ?? ""} ${student.lastName ?? ""}`.trim(),
    studentGrade: grade,
    school: gradeNum >= 9 ? "High School" : "Middle School",

    rewardId: String(reward.id ?? ""),
    rewardName: String(reward.name ?? ""),
    rewardCategory: String(reward.category || "General"),
    unitCost: Number(reward.cost),
    quantity,
    totalCost: total,

    purchasedAt: nowIso,
    // THE CHILD IS THE ACTOR, and the receipt says so rather than crediting a
    // member of staff who was not there. `role: 'student'` is what the
    // purchase log filters on to tell self-serve from over-the-counter.
    purchasedBy: {
      id: appId,
      name: `${student.firstName ?? ""} ${student.lastName ?? ""}`.trim(),
      username: "",
      role: "student",
    },
    channel: "student",

    status: "issued",
    fulfilledAt: null,
    fulfilledBy: null,
    cancelledAt: null,
    cancelledBy: null,
    cancelReason: null,
    updatedAt: null,
    txId: null,
    refundTxId: null,
  };
}

/**
 * The cash ledger row for a purchase, matching recordCashTransaction's shape.
 *
 * `kind: 'redeem'` is the field that matters and the one every analytic reads:
 * it is what keeps a purchase out of the deduction counts and out of the
 * intervention table. `type` is the SIGN and nothing else -- eleven panels
 * read it, and cash-audit.test.mjs pins the writer's expression.
 */
export function buildPurchaseLedgerRow(opts: {
  txnId: string;
  receiptId: string;
  student: StoreStudent;
  /** The app-facing id, explicit. See buildStudentReceipt. */
  studentAppId: string;
  reward: StoreReward;
  quantity: number;
  total: number;
  nowIso: string;
  balanceAfter: number;
}): Record<string, unknown> {
  const { txnId, receiptId, student, reward, quantity, total, nowIso, balanceAfter } = opts;
  const appId = String(opts.studentAppId ?? "").trim();
  if (!appId) {
    // A ledger row with no studentId belongs to nobody:
    // distributeCashTransactions would file it under no student at all.
    throw new Error("buildPurchaseLedgerRow: studentAppId is required and was empty.");
  }
  const grade = String(student.grade ?? "").trim();
  const gradeNum = parseInt(grade, 10);

  return {
    id: txnId,
    timestamp: nowIso,
    studentId: appId,
    studentName: `${student.firstName ?? ""} ${student.lastName ?? ""}`.trim(),
    studentGrade: grade,
    school: gradeNum >= 9 ? "High School" : "Middle School",

    // NO TEACHER, because there was not one. An empty teacherId is what
    // updateTeacherInteractions skips on, which is correct: a child buying
    // something is not an adult's interaction with them, and attributing it
    // to anybody would inflate their positivity ratio with a purchase.
    teacherId: "",
    teacherUsername: "",
    teacherName: `${student.firstName ?? ""} ${student.lastName ?? ""}`.trim(),

    kind: "redeem",
    // The SIGN of this row's own amount, computed the way
    // recordCashTransaction computes it. Always 'negative' for a purchase --
    // written as a derivation rather than the constant so that if a purchase
    // ever becomes a credit, this does not quietly lie. Eleven panels read it.
    type: -Math.abs(total) >= 0 ? "positive" : "negative",

    behaviorId: "reward:" + String(reward.id ?? ""),
    behaviorName: String(reward.name ?? ""),
    amount: -Math.abs(total),
    notes: `Reward purchase ${receiptId}` +
           (quantity > 1 ? ` (x${quantity})` : "") + " [self-serve]",
    balanceAfter,
  };
}
