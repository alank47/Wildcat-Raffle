// The one normalizer both sides of a tag lookup use. Run: npm test
//
// TWO BUGS LIVE HERE, and both are silent.
//
// 1. There were two normalizers. `tapLocations.upsert` wrote through the strict
//    one (everything outside [a-z0-9-] becomes a hyphen), while `hallPasses.tap`
//    and `hallPasses.requestMine` read with `slug.trim().toLowerCase()`. A tag
//    registered as `Restroom_2` was stored `restroom-2` and could never be
//    matched by a tap of `restroom_2`. Nothing errors: the admin screen shows
//    the tag as present and healthy, and a child stands there tapping a sticker
//    that does nothing. The round-trip property at the bottom is the one that
//    catches a future divergence.
//
// 2. The slug arrives off a URL a student controls and had no length cap, then
//    ran through three regexes and was written into a tapEvents row. The pass
//    reason one file over was capped at 120 characters while this was open.
//
// The assertions are therefore about hostile and awkward input, not about
// `restroom-2` working.

import { normalizeSlug, MAX_SLUG_LENGTH, MAX_RAW_SLUG_LENGTH } from "./tapSlug.ts";

let pass = 0;
let fail = 0;
function check(label, ok, detail = "") {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? `  (${detail})` : ""}`); }
}

console.log("\nThe normal shapes");
{
  check("a plain slug survives", normalizeSlug("restroom-2") === "restroom-2");
  check("case is folded", normalizeSlug("Restroom-2") === "restroom-2");
  check("whitespace is trimmed", normalizeSlug("  restroom-2  ") === "restroom-2");
  check("digits and hyphens are kept", normalizeSlug("room-12") === "room-12");
}

console.log("\nThe mismatch that made a real tag unmatchable");
{
  // THE bug. upsert stored this as restroom-2; the old read-side normalizer
  // left it as restroom_2 and matched nothing, forever.
  check("an underscore becomes a hyphen", normalizeSlug("Restroom_2") === "restroom-2");
  check("a space becomes a hyphen", normalizeSlug("Restroom 2") === "restroom-2");
  check("a dot becomes a hyphen", normalizeSlug("restroom.2") === "restroom-2");
  check("runs collapse to one hyphen", normalizeSlug("restroom___2") === "restroom-2");
  check("leading and trailing hyphens go", normalizeSlug("--restroom-2--") === "restroom-2");
  check("unicode is not silently kept", normalizeSlug("réstroom") === "r-stroom");

  // The property, stated directly: whatever the write side stores, the read
  // side must produce from the same input. Normalizing twice must not move.
  const INPUTS = [
    "Restroom_2", "restroom 2", "ROOM.12", "  nurse  ", "office--1",
    "a", "-", "___", "Röom 12", "room/12", "room+12", "room%2012",
  ];
  check(
    "normalizing is idempotent, so write and read always agree",
    INPUTS.every((s) => normalizeSlug(normalizeSlug(s)) === normalizeSlug(s)),
    "if this ever fails, a tag can be stored under a slug no tap can produce",
  );
}

console.log("\nUnusable input yields \"\", which callers must never query");
{
  // slug is a REQUIRED column, so eq("slug", "") is a real bucket lookup. It is
  // empty only because upsert refuses to create a slug that normalizes to
  // nothing, and every read site checks for "" before querying.
  for (const [label, input] of [
    ["an empty string", ""],
    ["only whitespace", "   "],
    ["only hyphens", "---"],
    ["only punctuation", "!!!"],
    ["undefined", undefined],
    ["null", null],
  ]) {
    check(`${label} normalizes to ""`, normalizeSlug(input) === "");
  }
}

console.log("\nThe length cap: a payload is not a wall label");
{
  const long = "a".repeat(MAX_SLUG_LENGTH + 50);
  check(
    "a merely long slug is truncated to the cap",
    normalizeSlug(long).length === MAX_SLUG_LENGTH,
  );

  // Over the raw ceiling it is REFUSED, not truncated. Truncating would let a
  // 500KB string whose first 64 characters spell a real tag be accepted as a
  // tap at that tag.
  const payload = "restroom-2" + "x".repeat(MAX_RAW_SLUG_LENGTH);
  check("an over-length input is refused outright", normalizeSlug(payload) === "");
  check(
    "and a huge one is refused rather than scanned",
    normalizeSlug("x".repeat(500_000)) === "",
  );
  check(
    "a prefix that spells a real tag does NOT get truncated into a match",
    normalizeSlug("restroom-2" + "-y".repeat(MAX_RAW_SLUG_LENGTH)) !== "restroom-2",
    "otherwise the cap becomes a way to tap any tag with any string",
  );
  check(
    "exactly at the raw ceiling is still processed",
    normalizeSlug("a".repeat(MAX_RAW_SLUG_LENGTH)).length === MAX_SLUG_LENGTH,
  );
  check("the caps are ordered sensibly", MAX_SLUG_LENGTH < MAX_RAW_SLUG_LENGTH);

  // No output, for any input, can exceed the cap.
  check(
    "nothing can produce an over-length slug",
    ["", "x".repeat(1000), "a b c".repeat(50), "-".repeat(300), "ß".repeat(100)].every(
      (s) => normalizeSlug(s).length <= MAX_SLUG_LENGTH,
    ),
  );
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
