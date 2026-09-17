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
};

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

  const quantity = normalizeQuantity(opts.quantity ?? 1);
  if (quantity === null) {
    return {
      allowed: false,
      code: "bad_quantity",
      reason: `Choose between 1 and ${MAX_STUDENT_QUANTITY}.`,
    };
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
