// The browser's Back button inside the Wildcat Digital Store.
//
// Asked for 2026-09-28: "can you make it so that if students press the back
// button on the browser, it takes them back?" Back from the shop has to land
// on the student's Wildcat Hub page -- not leave Wildcat Hub, which is where a
// history with no entry of ours would send them.
//
// The shop's own functions are lifted out of script.js and run against a
// small fake history that fires popstate the way a browser does: to every
// listener, in the order they were added. The dialog code's listener goes
// first, as it does on the page (it is registered at load), and it is the
// SHIPPED one, lifted from backClosesDialogs.
//
// Run: npm test
import { readFileSync } from "node:fs";

const raw = readFileSync(new URL("./script.js", import.meta.url), "utf8");
let pass = 0, fail = 0;
const check = (n, c, why) => {
  c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${why ? "  (" + why + ")" : ""}`));
};
const lift = (name) => {
  const i = raw.indexOf("function " + name + "(");
  if (i < 0) throw new Error("not found: " + name);
  let d = 0, k = raw.indexOf("{", i);
  for (; k < raw.length; k++) { if (raw[k] === "{") d++; else if (raw[k] === "}") { d--; if (d === 0) break; } }
  return raw.slice(i, k + 1);
};
// The dialog code's popstate listener, as shipped.
const dAt = raw.indexOf("(function backClosesDialogs() {");
const dFrom = raw.indexOf("window.addEventListener('popstate', function (ev) {", dAt);
if (dFrom < 0) throw new Error("backClosesDialogs listener not found");
const dBody = raw.slice(raw.indexOf("{", dFrom + 40) + 1, raw.indexOf("\n            });", dFrom));

function world(opts) {
  const H = {
    stack: (opts && opts.stack) ? opts.stack.map((st) => ({ state: st })) : [{ state: null }],
    i: (opts && opts.stack) ? opts.stack.length - 1 : 0, queue: [], listeners: [],
    get state() { return this.stack[this.i].state; },
    pushState(st) { this.stack = this.stack.slice(0, this.i + 1); this.stack.push({ state: st }); this.i++; },
    replaceState(st) { this.stack[this.i] = { state: st }; },
    // ASYNC, AND AIMED WHEN CALLED, as Chromium does it (measured: back()
    // then pushState() straight away lands on the entry BELOW the one back()
    // was called from, and the pushed entry is left forward of it). The index
    // only changes when the popstate fires, so code that reads history.state
    // straight after back() still sees the entry it asked to leave.
    back() { this.queue.push(this.i - 1); },
    forward() { this.queue.push(this.i + 1); },
  };
  const els = {};
  const document = {
    title: "Wildcat Hub",
    body: { appendChild(el) { els[el.id] = el; } },
    createElement() {
      return { id: "", hidden: true, innerHTML: "", attrs: {}, setAttribute(k, v) { this.attrs[k] = v; },
               querySelector() { return null; } };
    },
    getElementById(id) { return els[id] || null; },
    querySelector() { return null; },
  };
  els.studentPassView = { id: "studentPassView", inert: false };
  const location = { href: "https://wildcatraffle.com/" };
  const env = new Function("history", "document", "window", "location",
    "let _wpStore = { look: 'scene' }; let _wpStoreError = null;\n" +
    "let _wcDialogDismiss = null; let _wcDialogSelfBack = 0;\n" +
    "function wdsShopHtml() { return '<div>shop</div>'; }\n" +
    lift("wpById") + "\nlet _wpShopOpen = false;\nlet _wdsSelfBack = 0;\nlet _wdsOwed = false;\n" +
    lift("wpRenderShop") + "\n" + lift("wpOpenShop") + "\n" + lift("wpShopOnPopstate") + "\n" + lift("wpCloseShop") + "\n" + lift("wpForgetStaleHistory") + "\n" +
    // A dialog, with the same history contract as _wcDialog's finish().
    "function openDialog(plain) { history.pushState(plain ? { wcDialogOpen: true } : { wcDialogOpen: true, overShop: _wpShopOpen === true }); let done = false;\n" +
    "  _wcDialogDismiss = function (how) { if (done) return; done = true; _wcDialogDismiss = null;\n" +
    "    if (!(how && how.historyAlreadyConsumed) && history.state && history.state.wcDialogOpen) { _wcDialogSelfBack++; history.back(); } };\n" +
    "  return { press: function () { _wcDialogDismiss && _wcDialogDismiss(); } }; }\n" +
    "const dialogListener = function (ev) {" + dBody + "};\n" +
    "return { open: wpOpenShop, close: wpCloseShop, onPop: wpShopOnPopstate, openDialog, dialogListener, forget: wpForgetStaleHistory,\n" +
    "  isOpen: () => _wpShopOpen, dialogOpen: () => !!_wcDialogDismiss, selfBack: () => _wdsSelfBack };"
  )(H, document, {}, location);
  // Registration order on the page: the dialog listener at load, the shop's
  // when the portal wires its buttons.
  H.listeners.push(env.dialogListener, env.onPop);
  const settle = () => {
    while (H.queue.length) {
      const target = H.queue.shift();
      if (target < 0 || target >= H.stack.length) continue;
      H.i = target;
      const ev = { state: H.stack[H.i].state };
      H.listeners.forEach((fn) => fn(ev));
    }
  };
  const userBack = () => { H.back(); settle(); };
  const userForward = () => { H.forward(); settle(); };
  return { H, env, settle, userBack, userForward, els };
}

console.log("\nBACK FROM THE SHOP\n");
{
  const { H, env, userBack, els } = world();
  env.open();
  check("opening the shop gives Back something of ours to land on", H.i === 1 && H.state.wdsShop === true);
  check("and puts the page behind out of reach", els.studentPassView.inert === true);
  userBack();
  check("Back closes the shop", env.isOpen() === false);
  check("and lands on their Wildcat Hub page, not before it", H.i === 0);
  check("with the page usable again", els.studentPassView.inert === false);
}

console.log("\nBACK WITH A DIALOG OPEN OVER THE SHOP\n");
{
  const { H, env, userBack } = world();
  env.open();
  env.openDialog();
  userBack();
  check("Back closes the dialog first", env.dialogOpen() === false);
  check("and they are still in the shop", env.isOpen() === true);
  let presses = 0;
  while (env.isOpen() && presses < 5) { userBack(); presses++; }
  check("one more Back leaves the shop -- no dead presses", !env.isOpen() && presses === 1, String(presses));
  check("still on their page, never past it", H.i === 0);
}

console.log("\nBUYING: CONFIRM, THEN THE RECEIPT, THEN DONE\n");
{
  const { H, env, settle } = world();
  env.open();
  const confirm = env.openDialog();
  confirm.press();            // "Confirm": the dialog spends its own entry
  settle();
  check("confirming keeps them in the shop", env.isOpen() === true && H.state.wdsShop === true);
  const receipt = env.openDialog();
  receipt.press();            // "Done"
  settle();
  check("closing the receipt keeps them in the shop too", env.isOpen() === true && H.i === 1);
}

console.log("\nLEAVING BY THE BUTTON\n");
{
  const { H, env, settle } = world();
  env.open();
  env.close();                // "Leave store", or Escape
  settle();
  check("Leave store spends the shop's entry, so Back is not wasted afterwards", H.i === 0 && !env.isOpen());
}

console.log("\nTHE DOOR CLICKED TWICE\n");
{
  const { H, env } = world();
  env.open();
  env.open();
  check("is one entry, not two", H.i === 1 && H.stack.length === 2);
}

console.log("\nA HALL PASS TAKING THE SCREEN\n");
{
  const { H, env, settle } = world();
  env.open();
  env.close();                // wpRenderFull calls wpCloseShop()
  settle();
  check("closes the shop and tidies its entry", !env.isOpen() && H.i === 0);
}

console.log("\nWHAT THE REVIEW FOUND (2026-09-28)\n");
{
  // THE BUG: Back cancels a confirm, then the next dialog closed by its OWN
  // button closed the shop, mid-purchase.
  const a = world();
  a.env.open();
  a.env.openDialog();
  a.userBack();                       // Back cancels "Are you sure?"
  const confirm = a.env.openDialog(); // Buy again
  confirm.press();                    // Confirm
  a.settle();
  check("Back-cancel, then Confirm by the button: still in the shop",
    a.env.isOpen() === true && a.H.state.wdsShop === true);
  const receipt = a.env.openDialog();
  receipt.press();                    // Done
  a.settle();
  check("and the receipt's Done keeps them there too", a.env.isOpen() === true && a.H.state.wdsShop === true);

  const b = world();
  b.env.open();
  b.env.openDialog(); b.userBack();
  b.env.openDialog(); b.userBack();
  check("Back-cancelling twice leaves them in the shop, on its entry",
    b.env.isOpen() === true && b.H.state.wdsShop === true && b.H.i === 1);

  const c = world();
  c.env.open();
  c.env.openDialog(); c.userBack();   // Back closes the receipt
  c.env.close(); c.settle();          // then Leave store
  check("Leave store after a Back-cancel spends the shop's entry: no dead presses on the page",
    !c.env.isOpen() && c.H.i === 0);

  // Closed from under an open dialog (a hall pass takes the screen).
  const d = world();
  d.env.open();
  const r2 = d.env.openDialog();      // the receipt
  d.env.close();                      // the hall pass takeover
  r2.press(); d.settle();             // Done
  check("a shop closed under a dialog tidies its entry once the dialog is done", !d.env.isOpen() && d.H.i === 0);

  // Reopened before Leave store's own Back has landed.
  const e = world();
  e.env.open();
  e.env.close();                      // back() queued, not landed
  e.env.open();                       // door clicked again, fast
  e.settle();
  check("reopening fast still gives the shop an entry", e.env.isOpen() && e.H.state && e.H.state.wdsShop === true);
  e.userBack();
  check("so Back still leaves the shop, not the app", !e.env.isOpen());

  // A reload while a dialog was open leaves a stale entry.
  const f = world({ stack: [null, { wcDialogOpen: true }] });
  f.env.forget();
  check("a stale dialog entry from before a reload is forgotten", f.H.state === null);
  f.env.open();
  f.userBack();
  check("and Back leaves the shop in one press", !f.env.isOpen() && f.H.i === 1);
}

console.log("\nA DIALOG OPENED OVER ANOTHER\n");
{
  // The dialog code's own comment names this chain (confirm, then prompt).
  // Closing the top one lands on the lower dialog's entry, which is not the
  // shop's -- only the dialog code's mark says this Back was not ours.
  const h = world();
  h.env.open();
  h.env.openDialog();
  const top = h.env.openDialog();
  top.press(); h.settle();
  check("closing the top dialog of two keeps them in the shop", h.env.isOpen() === true);
}

console.log("\nFORWARD (the \u2192 key beside Back on a Chromebook)\n");
{
  // After Confirm, the spent dialog entry sits forward of the shop's.
  const a = world();
  a.env.open();
  a.env.openDialog().press(); a.settle();
  a.userForward();
  check("Forward onto a spent dialog entry keeps them in the shop, on the shop's entry",
    a.env.isOpen() && a.H.state && a.H.state.wdsShop === true);
  a.userBack();
  check("and one Back still leaves the shop", !a.env.isOpen() && a.H.i === 0);

  // After Back cancelled a confirm.
  const b = world();
  b.env.open();
  b.env.openDialog(); b.userBack();
  b.userForward();
  check("the same after a Back-cancel", b.env.isOpen() && b.H.state && b.H.state.wdsShop === true);

  // After Back closed the shop, Forward lands on its spent entry.
  const c = world();
  c.env.open();
  c.userBack();
  c.userForward();
  check("Forward onto a closed shop's entry steps straight back off it", !c.env.isOpen() && c.H.i === 0);
}

console.log("\nTHE SHOP'S OWN STEP BACK NEVER CANCELS A DIALOG\n");
{
  const d = world();
  d.env.open();
  d.env.close();                      // Leave store: back() in flight
  d.env.openDialog();                 // a dialog opens before it lands
  d.settle();
  check("a dialog that opened meanwhile stays open", d.env.dialogOpen() === true);
}

console.log("\nTHE PAGE AROUND IT\n");
{
  const busy = lift("screenHasUnfinishedWork");
  check("an update reload waits while a student is in the shop",
    /if \(typeof _wpShopOpen !== 'undefined' && _wpShopOpen\) return true;/.test(busy));
  check("cleaning an NFC tap out of the address keeps the entry's state",
    /window\.history\.replaceState\(window\.history\.state, '', url\.toString\(\)\);/.test(lift("clearTapFromUrl")));
  check("dialogs pushed over the shop say so",
    /history\.pushState\(\{ wcDialogOpen: true,\s*overShop: typeof _wpShopOpen !== 'undefined' && _wpShopOpen === true \}/.test(raw));
}

console.log("\nA DIALOG ENTRY THAT DOES NOT KNOW ABOUT THE SHOP\n");
{
  // An entry without overShop (pushed by a tab from before this change, say).
  // Closing the top dialog of two lands on it; only the dialog code's mark
  // says that Back was the dialog's, so the shop must not close.
  const p = world();
  p.env.open();
  p.env.openDialog(true);
  const top = p.env.openDialog(true);
  top.press(); p.settle();
  check("a dialog's own Back is never taken as the student leaving the shop", p.env.isOpen() === true);
}

console.log("\nTHE STAFF SIDE IS UNCHANGED\n");
{
  // No shop at all: the dialog code behaves exactly as before -- Back closes
  // the dialog and puts the entry back, so it costs one press.
  const g = world();
  g.env.openDialog();
  g.userBack();
  check("Back still closes a dialog", g.env.dialogOpen() === false);
  check("and re-pushes its entry, as it always did", g.H.i === 1 && g.H.state && g.H.state.wcDialogClosed === true);
}

console.log("\nTHE WIRING\n");
{
  const wire = raw.slice(raw.indexOf("function wpWireBuyButtons()"), raw.indexOf("function wpDashboard("));
  check("the listener is registered with the other shop doors, once",
    (wire.match(/window\.addEventListener\('popstate', wpShopOnPopstate\);/g) || []).length === 1
    && /if \(_wpBuyWired\) return;/.test(wire));
  check("after forgetting any stale entry from before a reload",
    /wpForgetStaleHistory\(\);\s*window\.addEventListener\('popstate', wpShopOnPopstate\);/.test(wire));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
