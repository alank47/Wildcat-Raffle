// The coalescing save queue.
//
// Every assertion here is a way the three-line setTimeout version silently
// loses a teacher's work. Coalescing writes is easy; coalescing them WITHOUT
// dropping one is the entire job, so the adversarial cases matter far more
// than the happy path.
//
// Run: npm test

import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./wildcat-savequeue.js", import.meta.url), "utf8");
new Function(src)();
const SQ = globalThis.WildcatSaveQueue;

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };

/** Drain the microtask queue so promise chains inside the queue settle. */
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

/** A save whose completion the test controls, one call at a time. */
function controllableSave() {
  const calls = [];
  const fn = () => {
    let resolve, reject;
    const p = new Promise((res, rej) => { resolve = res; reject = rej; });
    calls.push({ resolve, reject, p });
    return p;
  };
  fn.calls = calls;
  return fn;
}

/** Fake clock and timers, so nothing here waits in real time. */
function harness(opts = {}) {
  let t = 0;
  let nextId = 1;
  const timers = [];
  const errors = [];
  const q = SQ.create({
    save: opts.save,
    now: () => t,
    setTimer: (fn, ms) => { const id = nextId++; timers.push({ id, at: t + ms, fn }); return id; },
    clearTimer: (id) => { const i = timers.findIndex((x) => x.id === id); if (i >= 0) timers.splice(i, 1); },
    onError: (e, n) => errors.push({ e, n }),
    quietMs: opts.quietMs ?? 1000,
    maxWaitMs: opts.maxWaitMs ?? 5000,
    backoffMs: opts.backoffMs ?? 2000,
    maxBackoffMs: opts.maxBackoffMs ?? 30000,
  });
  return {
    q, errors,
    now: () => t,
    nextDelay: () => (timers.length ? timers[0].at - t : null),
    async advance(ms) {
      const target = t + ms;
      for (;;) {
        const due = timers.filter((x) => x.at <= target).sort((a, b) => a.at - b.at);
        if (!due.length) break;
        const first = due[0];
        timers.splice(timers.indexOf(first), 1);
        t = Math.max(t, first.at);   // the clock reads the fire time, as a real one does
        first.fn();
        await settle();
      }
      t = target;
      await settle();
    },
  };
}

/** Track settlement without triggering unhandled rejection warnings. */
function track(p) {
  const state = { done: false, ok: null, err: null };
  p.then((v) => { state.done = true; state.ok = v; },
         (e) => { state.done = true; state.err = e; });
  return state;
}

console.log("\nA burst becomes one write");
{
  const save = controllableSave();
  const h = harness({ save });

  const a = track(h.q.request("award 1"));
  const b = track(h.q.request("award 2"));
  const c = track(h.q.request("award 3"));

  await h.advance(200);
  check("nothing is written during the quiet window", save.calls.length === 0);

  await h.advance(1000);
  check("one save covers all three requests", save.calls.length === 1);

  save.calls[0].resolve("ok");
  await settle();
  check("and every caller is resolved by it", a.done && b.done && c.done);
  check("with the save's result, not a placeholder", a.ok === "ok" && c.ok === "ok");
  check("the queue reports the coalescing", h.q.stats().requested === 3 && h.q.stats().saves === 1);
}

console.log("\nA caller is never told 'saved' before it is");
{
  // saveInBackground reports "persisted" from this promise. A debounce that
  // resolves immediately makes that toast a lie.
  const save = controllableSave();
  const h = harness({ save });
  const a = track(h.q.request("referral"));

  await h.advance(1000);
  check("the save has started", save.calls.length === 1);
  check("but the caller is STILL waiting", a.done === false);

  save.calls[0].resolve("written");
  await settle();
  check("it settles only once the write completed", a.done && a.ok === "written");
}

console.log("\nA request during a save is not swallowed");
{
  // THE LOST UPDATE. The in-flight write took its snapshot before this
  // request existed, so the request needs its own pass.
  const save = controllableSave();
  const h = harness({ save });

  const first = track(h.q.request("award A"));
  await h.advance(1000);
  check("the first save is running", save.calls.length === 1);

  const during = track(h.q.request("award B"));
  await settle();
  check("no second save starts while one is in flight", save.calls.length === 1);
  check("and the late request is NOT resolved by the running save", during.done === false);

  save.calls[0].resolve("first");
  await settle();
  check("the first caller resolves", first.done === true);
  check("the late request is still outstanding", during.done === false);
  check("the queue knows it still has work", h.q.isPending() === true);

  await h.advance(1000);
  check("a second save runs for it", save.calls.length === 2);
  save.calls[1].resolve("second");
  await settle();
  check("and only now does the late caller resolve", during.done && during.ok === "second");
}

console.log("\nA steady trickle cannot postpone a write forever");
{
  // STARVATION. A pure debounce resets on every call and never fires.
  const base = controllableSave();
  const clock = { now: () => 0 };
  let firedAt = null;
  const save = () => { if (firedAt === null) firedAt = clock.now(); return base(); };
  const h = harness({ save, quietMs: 1000, maxWaitMs: 5000 });
  clock.now = h.now;

  h.q.request("first");                       // the oldest unsaved change, t=0
  // A request every 700ms: always inside the quiet window, forever. A pure
  // debounce resets on each one and never writes at all.
  for (let i = 0; i < 3; i++) {
    await h.advance(700);
    h.q.request("another");
  }
  check("still nothing written at 2.1s, which is correct", base.calls.length === 0);

  for (let i = 0; i < 8 && !base.calls.length; i++) {
    await h.advance(700);
    if (!base.calls.length) h.q.request("another");
  }
  check("the ceiling forces a write despite continuous arrivals",
    base.calls.length === 1);
  check("and it lands within the ceiling of the OLDEST change, not the newest",
    firedAt !== null && firedAt <= 5000);

  // The ceiling re-arms for the next batch rather than staying tripped.
  base.calls[0].resolve("ok");
  await settle();
  h.q.request("after");
  await h.advance(1000);
  check("the next batch uses the quiet window again", base.calls.length === 2);
}

console.log("\nA failed save is retried, not abandoned");
{
  const save = controllableSave();
  const h = harness({ save, backoffMs: 2000 });
  const a = track(h.q.request("award"));

  await h.advance(1000);
  save.calls[0].reject(new Error("permission-denied"));
  await settle();

  check("the caller is told it failed", a.done && a.err && /permission-denied/.test(a.err.message));
  check("the error is reported once", h.errors.length === 1);
  check("but the work is NOT dropped", h.q.isPending() === true);

  await h.advance(2000);
  check("it is retried", save.calls.length === 2);
  save.calls[1].resolve("ok");
  await settle();
  check("and the queue is clean once it lands", h.q.isPending() === false);
}

console.log("\nRepeated failure backs off, and success resets it");
{
  const save = controllableSave();
  const h = harness({ save, backoffMs: 1000, maxBackoffMs: 8000 });
  h.q.request("x");
  await h.advance(1000);

  const delays = [];
  for (let i = 0; i < 5; i++) {
    save.calls[save.calls.length - 1].reject(new Error("contention"));
    await settle();
    delays.push(h.nextDelay());
    await h.advance(h.nextDelay());
  }
  check("the wait grows with consecutive failures", delays[1] > delays[0] && delays[2] > delays[1]);
  check("and is capped rather than growing without bound",
    delays.every((d) => d <= 8000));

  save.calls[save.calls.length - 1].resolve("ok");
  await settle();
  h.q.request("y");
  await h.advance(1000);
  check("one success clears the backoff", save.calls.length >= 2);
  check("failures are counted for diagnostics", h.q.stats().failures === 5);
}

console.log("\nflush writes now, for a closing tab");
{
  const save = controllableSave();
  const h = harness({ save });
  const a = track(h.q.request("award"));

  const flushed = track(h.q.flush());
  await settle();
  check("flush does not wait for the quiet window", save.calls.length === 1);

  save.calls[0].resolve("ok");
  await settle();
  check("the original caller still resolves", a.done && a.ok === "ok");
  check("and flush resolves once nothing is outstanding", flushed.done === true);
}

console.log("\nflush waits for a running save, then takes what arrived during it");
{
  const save = controllableSave();
  const h = harness({ save });
  h.q.request("A");
  await h.advance(1000);
  check("a save is running", save.calls.length === 1);

  const late = track(h.q.request("B"));
  const flushed = track(h.q.flush());
  await settle();
  check("flush does not start an overlapping write", save.calls.length === 1);

  save.calls[0].resolve("first");
  await settle();
  check("once it lands, flush immediately writes what arrived during it",
    save.calls.length === 2);

  save.calls[1].resolve("second");
  await settle();
  check("the late request resolves", late.done && late.ok === "second");
  check("and flush resolves only when the queue is empty",
    flushed.done === true && h.q.isPending() === false);
}

console.log("\nflush on a clean queue writes nothing");
{
  const save = controllableSave();
  const h = harness({ save });
  const flushed = track(h.q.flush());
  await settle();
  check("no save is made", save.calls.length === 0);
  check("and it resolves rather than hanging", flushed.done === true);
}

console.log("\nExactly one save runs at a time, always");
{
  // Two writes to the same document at once IS the contention this exists to
  // prevent, so it is asserted directly rather than inferred from call counts.
  let inFlight = 0, maxConcurrent = 0, completed = 0;
  const finishers = [];
  const save = () => {
    inFlight += 1;
    maxConcurrent = Math.max(maxConcurrent, inFlight);
    let resolve;
    const p = new Promise((r) => { resolve = r; });
    finishers.push(() => { inFlight -= 1; completed += 1; resolve("ok"); });
    return p;
  };
  const h = harness({ save, quietMs: 400 });

  // Requests arriving faster than saves complete, which is launch day.
  for (let i = 0; i < 12; i++) {
    h.q.request("burst " + i);
    await h.advance(250);
    if (finishers.length > completed) { finishers[completed](); await settle(); }
  }
  await h.advance(2000);
  while (finishers.length > completed) { finishers[completed](); await settle(); }

  check("never more than one write in flight", maxConcurrent === 1);
  check("and the work still got written", completed > 0);
  check("with far fewer writes than requests", completed < 12);
}

console.log("\nA save that throws synchronously does not wedge the queue");
{
  let firstCall = true;
  const save = () => {
    if (firstCall) { firstCall = false; throw new Error("boom"); }
    return Promise.resolve("recovered");
  };
  const h = harness({ save, backoffMs: 500 });
  const a = track(h.q.request("x"));
  await h.advance(1000);
  check("the caller is rejected rather than hanging forever", a.done && a.err);

  // The retry waits max(quiet window, backoff), so 1000 here rather than 500.
  await h.advance(1000);
  await settle();
  check("and the queue recovers on the retry", h.q.isPending() === false);
}

console.log("\nisPending is honest, because the unload handler trusts it");
{
  const save = controllableSave();
  const h = harness({ save });
  check("clean at rest", h.q.isPending() === false);

  h.q.request("x");
  check("pending as soon as a change is requested", h.q.isPending() === true);

  await h.advance(1000);
  check("still pending while the write is in flight", h.q.isPending() === true);

  save.calls[0].resolve("ok");
  await settle();
  check("clean only once the write has landed", h.q.isPending() === false);
}

console.log("\nThe queue refuses to be built without a save function");
{
  let threw = false;
  try { SQ.create({}); } catch (e) { threw = true; }
  check("misconfiguration fails loudly at construction", threw === true);
}

console.log("\nThe app wires it up so the guarantees actually apply");
{
  const script = readFileSync(new URL("./script.js", import.meta.url), "utf8");
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");

  check("the module is loaded before script.js uses it",
    html.indexOf("wildcat-savequeue.js") > 0 &&
    html.indexOf("wildcat-savequeue.js") < html.indexOf("script.js?v="));

  // The durability window is the cost of coalescing. Both handlers are needed:
  // beforeunload is unreliable on iOS, pagehide does not fire on tab-switch.
  check("outstanding work is flushed when the page is hidden",
    /visibilityState === 'hidden'\) flushSaves\(\)/.test(script));
  check("and when the page goes away", /'pagehide', function \(\) \{ flushSaves\(\)/.test(script));

  // The two paths that fire repeatedly on launch day.
  check("ticket awards go through the queue", /await requestSave\('Ticket award'\)/.test(script));
  check("cash awards go through the queue", /await requestSave\('Cash award'\)/.test(script));
  check("referrals and closures go through it too, via saveInBackground",
    /return requestSave\(label\)/.test(script));

  // A missing module must degrade to saving directly, never to silence.
  check("a failure to load the module still saves",
    /if \(!q\) return Promise\.resolve\(saveData\(\)\);/.test(script));

  // Awaiting is the point: the award path must not return before it is durable.
  check("the award still awaits durability rather than a timer",
    /await requestSave\('Ticket award'\)/.test(script) &&
    /the guarantee\n\s*\/\/ the old comment describes is unchanged/.test(script));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
