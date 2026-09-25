// Leaving a tab that holds unsaved cash asks first. Run: npm test
//
// The owner's choice, 2026-09-25 ("Small and Safe fix works"). A page reload
// empties the list of money the server has not confirmed -- how ten awards
// were lost on 2026-09-24. The automatic update now waits for that money
// (self-update.test.mjs); this covers a PERSON refreshing or closing the tab:
// the browser's own "Leave site?" prompt, as unsaved referrals already had.
import { readFileSync } from "node:fs";

const script = readFileSync(new URL("./script.js", import.meta.url), "utf8");
let pass = 0, fail = 0;
const check = (n, c, why) => {
  c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${why ? "  (" + why + ")" : ""}`));
};
const lift = (src, name) => {
  const i = src.indexOf("function " + name + "(");
  if (i < 0) throw new Error("missing " + name);
  let d = 0, k = src.indexOf("{", i);
  for (; k < src.length; k++) { if (src[k] === "{") d++; else if (src[k] === "}") { d--; if (d === 0) break; } }
  return src.slice(i, k + 1);
};

// The real handler and the real cash filter, run against a small world.
const world = (src) => new Function(`
  const _unsavedReferrals = new Map();
  const _pendingCashMovements = new Map();
  const _cashLastHeldCapped = new Set();
  let _wcLeavingOnPurpose = false;
  const timers = [];
  const setTimeout = (fn) => { timers.push(fn); };
  ${lift(src, "unconfirmedCashForUpdate")}
  ${lift(src, "leavingOnPurpose")}
  ${lift(src, "wcBeforeUnload")}
  const fire = () => {
    const e = { prevented: false, returnValue: undefined, preventDefault() { this.prevented = true; } };
    wcBeforeUnload(e);
    return e.prevented;
  };
  return { fire, leavingOnPurpose, runTimers: () => timers.splice(0).forEach((f) => f()),
    award: (id) => _pendingCashMovements.set("12101", [...(_pendingCashMovements.get("12101") || []),
      { id, at: new Date().toISOString(), amount: 100, kind: "award" }]),
    confirm: () => _pendingCashMovements.clear(),
    capped: (id) => _cashLastHeldCapped.add(id),
    referral: () => _unsavedReferrals.set("r1", "a referral") };
`)();

console.log("\nA PERSON LEAVING\n");
{
  const w = world(script);
  check("nothing unsaved: no prompt", w.fire() === false);
  w.award("txn_1");
  check("an award not yet confirmed: the browser asks before leaving", w.fire() === true);
  w.confirm();
  check("once the server confirms it: no prompt", w.fire() === false);
  w.award("txn_big"); w.capped("txn_big");
  check("a movement the server held 'capped' (no retry can land it) does not nag", w.fire() === false);
}

console.log("\nTHE APP'S OWN RELOADS\n");
{
  const w = world(script);
  w.award("txn_1");
  w.leavingOnPurpose();
  check("the automatic update or a forced refresh: no prompt from nowhere", w.fire() === false);
  w.runTimers();
  check("...and if that reload was cancelled, the warning comes back", w.fire() === true);
  const r = world(script);
  r.referral(); r.leavingOnPurpose();
  check("the unsaved-REFERRAL warning is unchanged: it still fires even then", r.fire() === true);
  check("both automatic reloads mark themselves, right before they navigate",
    (script.match(/leavingOnPurpose\(\);\s*if \(target\) location\.replace\(target\); else location\.reload\(\);/g) || []).length === 2);
  check("the handler is the one registered", /window\.addEventListener\('beforeunload', wcBeforeUnload\);/.test(script));
}

console.log("\nDO THE CHECKS HAVE TEETH?\n");
{
  // The warning switched off for cash (the old handler): an unsaved award leaves silently.
  const old = world(script.replace("if (!_unsavedReferrals.size && !cash) return;", "if (!_unsavedReferrals.size) return;"));
  old.award("txn_1");
  check("TEETH: the old referral-only handler lets an unsaved award go silently", old.fire() === false);
  // The purpose flag never reset: a cancelled reload would silence the warning for good.
  const stuck = world(script.replace("setTimeout(() => { _wcLeavingOnPurpose = false; }, 5000);", ""));
  stuck.award("txn_1"); stuck.leavingOnPurpose(); stuck.runTimers();
  check("TEETH: without the reset, a cancelled reload silences it for good", stuck.fire() === false);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
