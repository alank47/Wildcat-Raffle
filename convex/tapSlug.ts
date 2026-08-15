/**
 * What a tag slug IS. One normalizer, used by every side. Pure, no imports.
 *
 * WHY THIS FILE EXISTS: there were two normalizers and they disagreed.
 *
 * `tapLocations.upsert` wrote through a normalizer that collapses everything
 * outside [a-z0-9-] to a hyphen, so an admin registering `Restroom_2` stored
 * `restroom-2`. `hallPasses.tap` and `hallPasses.requestMine` read with
 * `slug.trim().toLowerCase()`, which leaves `restroom_2` as `restroom_2`. The
 * tag encoded with an underscore therefore matched NOTHING, forever, and the
 * symptom is a student holding a phone against a sticker that does nothing while
 * the admin screen shows the tag as present and healthy. Nobody would have found
 * that from the code; they would have replaced the sticker.
 *
 * A write-side and a read-side normalizer for the same key must be the same
 * function, or they are a silent lookup miss waiting for the first slug with a
 * character somebody did not think about.
 *
 * IT ALSO BOUNDS THE INPUT. `tap` takes the slug straight off a URL a student
 * controls, and before the cap that string could be any length, run through
 * three regexes, and then be written into a tapEvents row. Capping the student's
 * free-text pass reason at 120 characters while leaving this one open was the
 * bigger hole of the two.
 */

/** Longest slug that can survive normalization. A wall label, not a payload. */
export const MAX_SLUG_LENGTH = 64;

/**
 * Longest raw input considered at all.
 *
 * Anything past this is REFUSED rather than truncated. Truncating would let a
 * 500KB string ending in junk normalize down to a real tag's slug and be
 * accepted as a tap at that tag. The length test happens before any regex runs,
 * so a hostile string is rejected in constant time rather than scanned three
 * times.
 */
export const MAX_RAW_SLUG_LENGTH = 256;

/**
 * The one true slug form: trimmed, lowercased, anything outside [a-z0-9-]
 * collapsed to a single hyphen, no leading or trailing hyphen.
 *
 * Returns "" for anything unusable, INCLUDING an over-length input. Callers
 * treat "" as "no such tag" and must never query with it: `slug` is a required
 * column, so eq("slug", "") is a real bucket lookup, and it stays empty only
 * because `upsert` refuses to create a slug that normalizes to nothing.
 */
export function normalizeSlug(raw: unknown): string {
  const s = String(raw ?? "");
  // Before the regexes, deliberately. This is the constant-time gate.
  if (s.length > MAX_RAW_SLUG_LENGTH) return "";
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, MAX_SLUG_LENGTH);
}
