import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import Stack from "@/components/Stack";
import Counter from "@/components/Counter";
import GlareHover from "@/components/GlareHover";
import StarBorder from "@/components/StarBorder";
import { useArrival } from "@/lib/arrive";
import { useFinePointer, useReducedMotion } from "@/lib/motion";
import {
  useCardsModel,
  type CardsModel,
  type LivePassSummary,
  type WalletCard,
  type WalletModel,
} from "@/lib/viewmodel";
import { Barcode } from "@/ui/Barcode";
import {
  Loaded,
  PageTitle,
  Provenance,
  SectionLabel,
  StatRow,
  Surface,
  Unavailable,
  friendlyTime,
  formatNumber,
} from "@/ui/primitives";

/**
 * THE CARD HOME.
 *
 * TWO HALVES, DELIBERATELY. `useCardsModel()` reads the session, normalises the
 * two wire shapes, and decides what is missing and what the words for that are.
 * Everything below it draws a model and reads nothing else. That is what makes
 * the wallet swappable for a React Bits Pro block without the swap touching a
 * single line that decides whether a balance exists — see PRO-SWAP.md.
 *
 * React Bits' `Stack` is the right component for the deck: the existing student
 * portal (styles.css §"STUDENT PORTAL") is already a Wallet-geometry stack, so
 * this is the same idea rendered by a component instead of by 400 lines of
 * hand-written transform maths, and a student who has used one knows how to use
 * the other.
 *
 * TWO THINGS I CHANGED ABOUT HOW IT IS USED, both because a wallet is a tool:
 *
 *   1. The card order is CONTROLLED. Stack fans its deck and only the top card
 *      is properly legible, which is fine for a gallery and not fine when the
 *      top card is the barcode somebody is holding up at a lunch till. The chips
 *      under the stack put any card on top in one tap, so nothing is ever more
 *      than one action away, and the ID starts on top because it is the card
 *      with a queue behind it.
 *   2. `sendToBackOnClick` is off and `mobileClickOnly` is on. On a touch screen
 *      a tap selects; on a mouse you can still drag. A card that reshuffles
 *      because a student touched it to read it is a card that has moved the
 *      thing they were reading.
 */
export default function Cards() {
  const model = useCardsModel();
  return <CardsView model={model} />;
}

/* ==================================================================
   Presentation
   ================================================================== */

function CardsView({ model }: { model: CardsModel }) {

  return (
    /* The entrance is a CSS stagger on the direct children — header, banner,
       wallet, totals — at 45ms apart. It is decorative, so nothing here waits
       for it: only opacity and transform move, every element is hit-testable
       from the first frame, and if the animation never runs the screen is
       already correct. */
    <div className="wc-stagger space-y-5">
      <header>
        <PageTitle size="text-[30px]">{model.greeting}</PageTitle>
        <p className="mt-1.5 text-[13.5px] tabular-nums text-wp-dim">
          {model.meta}
        </p>
      </header>

      {model.livePass && <LivePassBanner pass={model.livePass} />}

      <Loaded from={model.wallet} rows={1}>
        {(wallet) => <Wallet model={wallet} />}
      </Loaded>

      <Loaded from={model.totals} rows={2}>
        {(totals) => (
          /* A fragment, so these land as separate children of the page's
             wc-stagger and continue its beat instead of arriving as one block.
             It also means they animate on the frame the query RESOLVES: the
             skeleton is a different element, so the reveal lands on the data
             rather than on the placeholder. */
          <>
            <Surface>
              <SectionLabel>Raffle tickets</SectionLabel>
              <div className="mt-4">
                <StatRow
                  stats={totals.tickets}
                  columns="grid-cols-2 sm:grid-cols-4"
                  accentFirst
                />
              </div>
              <p className="mt-5 border-t border-[var(--wp-hair)] pt-4 text-[13px] leading-[1.5] text-wp-dim">
                {totals.ticketsNote}
              </p>
              <Provenance {...totals.provenance} />
            </Surface>

            {/* Wildcat Cash is NOT repeated here. It has a card of its own with
                the balance, earned and spent on it; a second copy on the same
                screen is two places to keep right and one more thing to scroll
                past. */}
            <Surface>
              <SectionLabel>Attendance</SectionLabel>
              {totals.attendance.available ? (
                <div className="mt-4">
                  <StatRow
                    stats={totals.attendance.stats}
                    columns="grid-cols-2"
                  />
                </div>
              ) : (
                <div className="mt-3">
                  <Unavailable reason={totals.attendance.reason} />
                </div>
              )}
            </Surface>

            {model.checkedAt && (
              <p className="px-1 text-[11.5px] text-wp-dim/80">
                Cards checked with the school server at{" "}
                {friendlyTime(model.checkedAt)}.
              </p>
            )}
          </>
        )}
      </Loaded>
    </div>
  );
}

/**
 * A live hall pass is the one thing on this screen that has to interrupt.
 * StarBorder earns its keep exactly here and nowhere else: it is the only
 * continuously animating element in the signed-in app, it appears only while a
 * pass is actually open, and it goes away the moment the pass closes.
 */
function LivePassBanner({ pass }: { pass: LivePassSummary }) {
  return (
    <StarBorder
      as="div"
      className="block w-full"
      color={pass.overdue ? "#D9742F" : "#B5D4F4"}
      speed="7s"
      thickness={1}
      innerClassName={`relative z-1 rounded-[19px] border px-5 py-4 ${
        pass.overdue
          ? "border-wc-orange/50 bg-[#2A1A10]"
          : "border-wc-blue/50 bg-[#0E1B2C]"
      }`}
    >
      <div className="flex items-center justify-between gap-4 text-left">
        <div>
          <p className="text-[11px] font-bold tracking-[0.09em] text-wc-blue-pale uppercase">
            {pass.overdue ? "Hall pass overdue" : "Hall pass open"}
          </p>
          <p className="mt-1 text-[15px] font-bold text-wp-fg">
            {pass.elapsed === null
              ? "Out of class"
              : `Out for ${pass.elapsed} minute${pass.elapsed === 1 ? "" : "s"}`}
            {pass.limit !== null && (
              <span className="font-normal text-wp-dim"> of {pass.limit}</span>
            )}
          </p>
        </div>
        <Link
          to="/pass"
          className="wc-press wc-hover-raise shrink-0 rounded-full border border-transparent bg-white/10 px-4 py-2 text-[13px] font-bold text-wp-fg"
        >
          Open
        </Link>
      </div>
    </StarBorder>
  );
}

/* ------------------------------------------------------------------
   The deck
   ------------------------------------------------------------------ */

function Wallet({ model }: { model: WalletModel }) {
  const [topKey, setTopKey] = useState(model.initialTop);

  const faces = useMemo(
    () => model.cards.map((card) => ({ key: card.key, node: <Face card={card} /> })),
    [model.cards],
  );

  const ordered = useMemo(() => {
    const rest = faces.filter((f) => f.key !== topKey);
    const top = faces.find((f) => f.key === topKey);
    // Stack draws the LAST entry frontmost.
    return top ? [...rest, top] : faces;
  }, [faces, topKey]);

  /* MUST be memoized. Stack re-syncs its internal deck from `cards` in an effect
     keyed on the array's identity, so a fresh array every render is an infinite
     setState loop. */
  const cards = useMemo(() => ordered.map((f) => f.node), [ordered]);

  return (
    <section aria-label="Your cards">
      {/* The lift is on the deck, gated to a fine pointer in CSS. It says the
          object can be picked up, which on a pointer device it can: the top
          card drags. On a touch screen the same gesture exists and no hover
          rule ever fires. */}
      <div className="wc-hover-deck h-[292px] w-full sm:h-[318px]">
        <Stack
          cards={cards}
          randomRotation={false}
          sensitivity={140}
          sendToBackOnClick={false}
          mobileClickOnly
          animationConfig={{ stiffness: 300, damping: 26 }}
        />
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        {model.cards
          .slice()
          .reverse()
          .map((card) => (
            <button
              key={card.key}
              type="button"
              onClick={() => setTopKey(card.key)}
              aria-pressed={topKey === card.key}
              className={`wc-press wc-hover-raise rounded-full border px-3.5 py-1.5 text-[12.5px] font-bold ${
                topKey === card.key
                  ? "border-wc-blue-pale/60 bg-wc-blue-pale/15 text-wc-blue-pale"
                  : "border-[var(--wp-hair)] bg-white/[0.03] text-wp-dim"
              }`}
            >
              {card.chip}
            </button>
          ))}
      </div>
    </section>
  );
}

function Face({ card }: { card: WalletCard }) {
  const fine = useFinePointer();
  const body = card.body;

  const payload: ReactNode =
    body.kind === "missing" ? (
      <Missing reason={body.reason} />
    ) : body.kind === "barcode" && body.glare ? (
      <GlareHover
        width="100%"
        height="auto"
        background="transparent"
        borderRadius="10px"
        borderColor="transparent"
        glareColor="#ffffff"
        /* The one hover effect in this app that is driven by JavaScript rather
           than by a media query, so it is gated in JavaScript instead: a touch
           device fires a synthetic mouseenter on tap and would leave a wipe
           halfway across a barcode somebody is holding up at a till. */
        glareOpacity={fine ? 0.28 : 0}
        glareAngle={-38}
        glareSize={200}
        /* 260ms, the app's modal band. React Bits ships 650ms, which on a
           laminated-card sweep reads as a slow wipe rather than light catching
           an edge. */
        transitionDuration={260}
        className="!cursor-default !border-0"
        style={{ display: "block" }}
      >
        <Barcode value={body.value} />
      </GlareHover>
    ) : body.kind === "barcode" ? (
      <Barcode value={body.value} />
    ) : body.kind === "cash" ? (
      <CashFace body={body} />
    ) : (
      <HallPassFace body={body} />
    );

  return (
    <div
      /* Only the ID card pushes its payload to the bottom, because a barcode
         belongs where a hand holds the phone. A card whose whole content is a
         sentence reads better with the sentence at the top and the space below
         it, not floating at the bottom of an empty rectangle. */
      className={`flex h-full w-full flex-col p-5 ${
        card.identity ? "justify-between" : ""
      }`}
      style={{
        background: card.tint,
        // The shadow is thrown upward onto the card above, which is what makes a
        // stack read as physical rather than as a list. Same values as
        // styles.css:3495.
        boxShadow:
          "0 -0.5px 0 rgba(255,255,255,0.14) inset, 0 -10px 26px rgba(0,0,0,0.55), 0 2px 3px rgba(0,0,0,0.30)",
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-[11px] font-bold tracking-[0.09em] text-white/65 uppercase">
          {card.label}
        </p>
        {card.identity?.name && (
          <p className="text-right text-[13px] font-bold text-white">
            {card.identity.name}
          </p>
        )}
      </div>

      {card.identity && (
        <div className="mt-4 flex-1">
          <div className="flex items-end gap-8">
            <Printed label="School" value={card.identity.school} />
            <Printed label="Grade" value={card.identity.grade} />
          </div>
        </div>
      )}

      {/* `flex-1` on a card WITHOUT a printed identity block, so a face whose
          payload is a two-part layout — the Cash card's balance at the top and
          its earned/spent footer — can push the footer to the bottom edge
          instead of stacking everything under the heading and leaving two
          thirds of a green rectangle empty. The ID card is excluded because its
          identity block already owns that space. */}
      <div className={card.identity ? "mt-3" : "mt-4 flex-1"}>{payload}</div>
    </div>
  );
}

function Printed({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10.5px] font-bold tracking-[0.09em] text-white/55 uppercase">
        {label}
      </p>
      <p className="mt-1 text-[14px] font-bold text-white">{value}</p>
    </div>
  );
}

function Missing({ reason }: { reason: string | null }) {
  return (
    <p className="text-[12.5px] leading-[1.5] text-white/70">
      {reason ??
        "Not available yet, and the server did not say why. The front office " +
          "can check your record."}
    </p>
  );
}

function HallPassFace({
  body,
}: {
  body: Extract<WalletCard["body"], { kind: "pass" }>;
}) {
  if (body.open) {
    return (
      <div>
        <p className="text-[26px] leading-none font-bold text-white">
          {body.overdue ? "Overdue" : "Open"}
        </p>
        <p className="mt-2 text-[12.5px] text-white/70">
          {body.elapsed === null
            ? "Out of class now."
            : `Out for ${body.elapsed} minute${body.elapsed === 1 ? "" : "s"}.`}
        </p>
      </div>
    );
  }
  return (
    <div>
      <p className="text-[22px] leading-none font-bold text-white">
        No pass open
      </p>
      <Link
        to="/pass"
        className="wc-press wc-hover-raise mt-3 inline-block rounded-full border border-transparent bg-white/15 px-4 py-2 text-[13px] font-bold text-white"
      >
        Ask for one
      </Link>
    </div>
  );
}

/**
 * The one hero number in the app, and the only place `Counter` is used.
 *
 * Counter is an odometer: it rolls each digit place on its own spring. That is a
 * lot of motion for a figure you glance at, so it gets exactly one home — the
 * balance, which is money, which is the number a student most wants to watch
 * change. Everything else counts up flatly with CountUp.
 *
 * AND IT ROLLS ONLY WHEN THE BALANCE HAS CHANGED. The odometer starts from zero
 * and the roll is nearly a second, so a wallet that re-rolls on every visit
 * shows "$0" to a student several times an hour. `useArrival` is what keeps it
 * to the one moment the figure is genuinely new.
 */
function CashFace({
  body,
}: {
  body: Extract<WalletCard["body"], { kind: "cash" }>;
}) {
  const reduced = useReducedMotion();
  const arriving = useArrival("cards.balance", body.balance);

  return (
    <div className="flex h-full flex-col justify-between">
      <div>
        <div className="flex items-end gap-1 text-wc-yellow">
          <span className="pb-1 text-[22px] leading-none font-bold">$</span>
          {reduced || !arriving ? (
            <span className="text-[46px] leading-none font-bold tabular-nums">
              {body.balance}
            </span>
          ) : (
            <Counter
              value={body.balance}
              fontSize={46}
              gap={0}
              horizontalPadding={0}
              borderRadius={0}
              fontWeight={700}
              textColor="#E6E280"
              gradientHeight={10}
              gradientFrom="#1A2E1F"
              gradientTo="transparent"
            />
          )}
        </div>
        <p className="mt-2 text-[12.5px] text-white/70">
          Spendable at the school store.
        </p>
      </div>

      <div className="flex gap-8">
        {/* Earned and spent are shown as words when the sync has not sent them.
            A card that prints "$0 spent" at a child who has spent money is the
            same class of lie as a missing grade rendered as an F. */}
        <Printed
          label="Earned"
          value={body.earned === null ? "Not synced" : `$${formatNumber(body.earned)}`}
        />
        <Printed
          label="Spent"
          value={body.spent === null ? "Not synced" : `$${formatNumber(body.spent)}`}
        />
      </div>
    </div>
  );
}
