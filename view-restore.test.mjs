// Where you were, across a refresh. Run: npm test
//
// WHAT THIS PINS. A refresh used to land everyone back on their role's default
// screen, because boot calls switchTab('tickets') / ('students') / ('dashboard')
// per role and nothing recorded where the person actually was. A teacher
// halfway through a hall-pass board, refreshing to clear a glitch, was thrown
// back to Award Tickets every time.
//
// The restore has one dangerous edge and it is the reason this file exists:
// boot's role branch is what DISABLES the tabs a role may not see, and it runs
// before the restore. Restoring blindly would walk a teacher straight into an
// admin screen that boot had just locked. So a stored tab is only honoured when
// its button exists, is not disabled, and is actually visible in the current
// mode. Everything else falls through to the default boot already chose.
//
// The functions are lifted out of the shipped script.js rather than copied, so
// this cannot pass against a version of the code that is no longer the one
// staff run. Same trick as nfc-tag-decode.test.mjs and pass-clock.test.mjs.
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./script.js", import.meta.url), "utf8");

/** The full source of a named function, brace-matched. */
function fnBody(source, name) {
  const start = source.indexOf(name);
  if (start === -1) {
    console.log(`\n  FAIL  not found in script.js: ${name}`);
    process.exit(1);
  }
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return source.slice(start);
}

let pass = 0;
let fail = 0;
function check(label, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail ? `  (${detail})` : ""}`);
  }
}

/** A tab button as the shell renders it: the tab name lives in its onclick. */
function tabButton(name, { disabled = false, visible = true } = {}) {
  return {
    getAttribute: (a) => (a === "onclick" ? `switchTab('${name}')` : null),
    classList: { contains: (c) => c === "disabled" && disabled },
    // offsetParent is null for anything display:none, which is how the shell
    // hides tabs that belong to another mode.
    offsetParent: visible ? {} : null,
  };
}

/** Builds a world: a fake sessionStorage, a fake DOM, and a switchTab spy. */
function world({ saved = null, buttons = [], throwOnRead = false } = {}) {
  const store = new Map();
  if (saved !== null) store.set("wc_view_tab", saved);
  const switched = [];

  const scope = {
    WC_VIEW_KEY: "wc_view_tab",
    switchTab: (name) => switched.push(name),
    window: {
      sessionStorage: {
        getItem: (k) => {
          if (throwOnRead) throw new Error("private mode");
          return store.has(k) ? store.get(k) : null;
        },
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
      },
    },
    document: { querySelectorAll: () => buttons },
  };

  const make = (name) =>
    new Function(
      "scope",
      `with (scope) { ${fnBody(src, "function " + name)} return ${name}; }`,
    )(scope);

  return {
    remember: make("wcRememberTab"),
    forget: make("wcForgetTab"),
    restore: make("wcRestoreTab"),
    stored: () => (store.has("wc_view_tab") ? store.get("wc_view_tab") : null),
    switched,
  };
}

console.log("\nRemembering the tab");
{
  const w = world();
  w.remember("hallMonitor");
  check("a tab switch is recorded", w.stored() === "hallMonitor");

  w.remember(null);
  check("a null tab does not overwrite it", w.stored() === "hallMonitor");

  w.forget();
  check("signing out clears it", w.stored() === null, "a shared Chromebook must not leak the last screen");
}

console.log("\nRestoring it, but only where allowed");
{
  const ok = world({ saved: "students", buttons: [tabButton("students")] });
  ok.restore();
  check("a tab the person may still see is restored", ok.switched[0] === "students");

  // The dangerous edge. Boot's role branch disables what a role may not open.
  const locked = world({
    saved: "settings",
    buttons: [tabButton("settings", { disabled: true })],
  });
  locked.restore();
  check(
    "a tab boot DISABLED for this role is refused",
    locked.switched.length === 0,
    "restoring it would walk a teacher into an admin screen boot had just locked",
  );

  const hidden = world({
    saved: "kiosk",
    buttons: [tabButton("kiosk", { visible: false })],
  });
  hidden.restore();
  check(
    "a tab hidden in the current mode is refused",
    hidden.switched.length === 0,
  );

  const gone = world({ saved: "retiredTab", buttons: [tabButton("students")] });
  gone.restore();
  check("a tab that no longer exists is refused", gone.switched.length === 0);

  const fresh = world({ saved: null, buttons: [tabButton("students")] });
  fresh.restore();
  check(
    "a first visit keeps the default boot chose",
    fresh.switched.length === 0,
    "no stored position means boot's role landing stands",
  );

  // A name that is a prefix of another must not match it, or a refresh lands
  // somewhere the person never was.
  const near = world({
    saved: "cash",
    buttons: [tabButton("cashActivity"), tabButton("cash")],
  });
  near.restore();
  check("a similar tab name is not mistaken for it", near.switched[0] === "cash");
}

console.log("\nWhen storage is unavailable");
{
  const w = world({ saved: "students", throwOnRead: true, buttons: [tabButton("students")] });
  let threw = false;
  try {
    w.restore();
  } catch (e) {
    threw = true;
  }
  check(
    "private mode does not break boot",
    !threw && w.switched.length === 0,
    "losing the position is not worth failing a sign-in over",
  );
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
