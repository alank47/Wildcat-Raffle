// Reading a slug off a physical NFC tag in the native app. Run: npm test
//
// THE BUG THIS PINS IS A CHILD STANDING AT A DOOR TAPPING A STICKER THAT DOES
// NOTHING. Every failure mode here is silent by construction: the decode either
// produces our slug or it produces null, and null is indistinguishable from
// "that was somebody else's tag", so there is no error, no log, and nothing on
// screen except a scanner that keeps listening.
//
// Three real ways the old code produced null on a good tag:
//
// 1. It understood ONE prefix code. A URI record does not hold the URL; it
//    holds a one byte abbreviation code and then the rest of the string. The
//    old code expanded code 4 (https://) and nothing else, so a tag encoded by
//    any third party writer app, which very often emits code 1 or 2, read as
//    unregistered forever.
// 2. It looked for fields that do not exist. `record.uri` is on neither
//    plugin, and the payload arrives base64 encoded over the bridge on both
//    iOS and Android, not as a string URL and not as a plain array.
// 3. It never checked the record TYPE. A Text record's first payload byte is a
//    status byte holding a language code length, not a prefix code, so the old
//    code happily decoded one as a URI and produced convincing rubbish.
//
// The functions are lifted out of the shipped script.js rather than copied, so
// this cannot pass against a version of the code that is no longer the one
// students run. script.js is a browser file with no build step and no exports;
// the slices below are the same trick script-load-race.test.mjs uses.
import fs from "node:fs";

const src = fs.readFileSync(new URL("./script.js", import.meta.url), "utf8");

/** The source between two markers, or a loud failure naming the missing one. */
function slice(startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  if (start === -1) {
    console.log(`\n  FAIL  marker not found in script.js: ${startMarker}`);
    process.exit(1);
  }
  const end = src.indexOf(endMarker, start + startMarker.length);
  if (end === -1) {
    console.log(`\n  FAIL  end marker not found in script.js: ${endMarker}`);
    process.exit(1);
  }
  return src.slice(start, end);
}

const urlHelper = slice(
  "/** Pull our slug out of the tap URL we wrote",
  "/** The first URL record on a scanned tag",
);
const decoder = slice(
  "// ---- Native NDEF decoding ----",
  "// ---- end native NDEF decoding ----",
);

const api = new Function(
  urlHelper + "\n" + decoder + "\n" +
  "return { WC_NDEF_URI_PREFIX, wcNfcSlugFromUrl, wcNativeRecordBytes," +
  " wcNativeUriFromBytes, wcNativeSlugFromRecord, wcNativeSlugFromTag };",
)();

const {
  WC_NDEF_URI_PREFIX,
  wcNfcSlugFromUrl,
  wcNativeRecordBytes,
  wcNativeUriFromBytes,
  wcNativeSlugFromRecord,
  wcNativeSlugFromTag,
} = api;

let pass = 0;
let fail = 0;
function check(label, ok, detail = "") {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? `  (${detail})` : ""}`); }
}

/** The bytes of one NDEF URI record: prefix code, then the rest as UTF-8. */
function uriBytes(code, rest) {
  return [code, ...Buffer.from(String(rest), "utf8")];
}

/** How the plugin hands a record over the bridge: type string + base64 payload. */
function record(type, bytes) {
  return { type, payload: Buffer.from(Uint8Array.from(bytes)).toString("base64") };
}

function uriRecord(code, rest) {
  return record("U", uriBytes(code, rest));
}

function tag(...records) {
  return { messages: [{ records }] };
}

// ---------------------------------------------------------------------------

console.log("\nThe prefix table, every code");
{
  // The whole table, not the four codes anybody remembers. The assertion is
  // that byte zero is expanded to the documented prefix and the remainder is
  // appended verbatim, for all 36 codes.
  const EXPECTED = [
    "", "http://www.", "https://www.", "http://", "https://",
    "tel:", "mailto:", "ftp://anonymous:anonymous@", "ftp://ftp.", "ftps://",
    "sftp://", "smb://", "nfs://", "ftp://", "dav://", "news:", "telnet://",
    "imap:", "rtsp://", "urn:", "pop:", "sip:", "sips:", "tftp:", "btspp://",
    "btl2cap://", "btgoep://", "tcpobex://", "irdaobex://", "file://",
    "urn:epc:id:", "urn:epc:tag:", "urn:epc:pat:", "urn:epc:raw:", "urn:epc:", "urn:nfc:",
  ];
  check("the shipped table has all 36 codes", WC_NDEF_URI_PREFIX.length === EXPECTED.length,
    String(WC_NDEF_URI_PREFIX.length));
  check(
    "every code expands to the documented prefix",
    EXPECTED.every((prefix, code) => wcNativeUriFromBytes(uriBytes(code, "x")) === prefix + "x"),
    EXPECTED.map((p, c) => [c, wcNativeUriFromBytes(uriBytes(c, "x"))])
      .filter(([c, got]) => got !== EXPECTED[c] + "x").map(([c]) => c).join(","),
  );

  // The four that can carry one of our tags, stated one at a time, because
  // these are the ones a wall sticker is actually encoded with. Code 4 was the
  // only one the old code knew.
  check("code 4, https://, our own writer", wcNativeSlugFromRecord(
    uriRecord(4, "wildcatraffle.com/?tap=room-16")) === "room-16");
  check("code 2, https://www., a third party writer", wcNativeSlugFromRecord(
    uriRecord(2, "wildcatraffle.com/?tap=room-16")) === "room-16");
  check("code 3, http://", wcNativeSlugFromRecord(
    uriRecord(3, "wildcatraffle.com/?tap=room-16")) === "room-16");
  check("code 1, http://www.", wcNativeSlugFromRecord(
    uriRecord(1, "wildcatraffle.com/?tap=room-16")) === "room-16");
  check("code 0, no compression, the whole URL stored literally", wcNativeSlugFromRecord(
    uriRecord(0, "https://wildcatraffle.com/?tap=room-16")) === "room-16");

  // A code past the end of the table is not a reason to throw the record away:
  // it means no compression we recognise, so the rest is read as it stands.
  check("a code past the table falls back to no prefix, it does not throw",
    wcNativeUriFromBytes(uriBytes(200, "https://wildcatraffle.com/?tap=room-16"))
      === "https://wildcatraffle.com/?tap=room-16");
  check("and that tag still yields its slug", wcNativeSlugFromRecord(
    uriRecord(200, "https://wildcatraffle.com/?tap=room-16")) === "room-16");
}

console.log("\nA record that is not a URI record is refused, not guessed at");
{
  // A Text record's payload[0] is a status byte: bit 7 is the encoding and the
  // low bits are the LENGTH of the language code that follows. Byte 2 here is
  // the length of "en". Decoding it as a URI prefix gives prefix table entry 2
  // ("https://www.") glued to "enRoom 16", which is exactly the kind of
  // plausible rubbish that fails a lookup with no error anywhere.
  const text = record("T", [0x02, ...Buffer.from("enRoom 16", "utf8")]);
  check("a Text record yields no slug", wcNativeSlugFromRecord(text) === null);

  // The nastier version of the same thing: a Text record whose words happen to
  // spell one of our URLs. Without the type check this is a working tap.
  const forged = record("T", [0x02, ...Buffer.from("enhttps://wildcatraffle.com/?tap=room-16", "utf8")]);
  check("a Text record that spells our URL is still refused",
    wcNativeSlugFromRecord(forged) === null,
    "the type check is the only thing standing between a T record and a tap");

  // The plugin invents this record when a tag carries no NDEF message at all,
  // so it arrives on every blank or unformatted sticker an admin holds up.
  const fallback = record("ID", Buffer.from("04A2B3C4D5E6", "utf8"));
  check("the synthetic ID fallback record yields no slug", wcNativeSlugFromRecord(fallback) === null);

  for (const [label, type] of [
    ["a MIME record", "text/plain"],
    ["an external type record", "wildcat.org:tag"],
    ["an empty type", ""],
    ["a lowercase u, which is not the well known URI type", "u"],
  ]) {
    check(`${label} yields no slug`, wcNativeSlugFromRecord(
      { type, payload: Buffer.from(uriBytes(4, "wildcatraffle.com/?tap=room-16")).toString("base64") },
    ) === null);
  }
}

console.log("\nA malformed payload returns null rather than throwing");
{
  // Every one of these has to fall through quietly. The scanner calls this in a
  // loop over every record on every tag it meets, so a throw here would take
  // out the whole scan session over one bad sticker.
  for (const [label, payload] of [
    // Valid base64 that is not a URI record inside. Byte zero is 'h', code 104,
    // past the end of the prefix table, so it expands to nothing and the rest
    // is not a URL. This is the shape a foreign tag arrives in.
    ["base64 of something that is not a URL", Buffer.from("hello world", "utf8").toString("base64")],
    ["base64 with illegal characters", "!!!!not base64!!!!"],
    ["an empty string", ""],
    ["null", null],
    ["undefined", undefined],
    ["a number", 4],
    ["a boolean", true],
    ["an object with no length", { uri: "https://wildcatraffle.com/?tap=room-16" }],
    ["an empty array", []],
    ["an array holding a non-number", [4, "x", NaN]],
  ]) {
    let threw = null;
    let got;
    try { got = wcNativeSlugFromRecord({ type: "U", payload }); } catch (e) { threw = e; }
    check(`${label} does not throw`, threw === null, threw && threw.message);
    check(`${label} yields no slug`, got === null || got === undefined, JSON.stringify(got));
  }

  // A raw byte array is a legitimate shape too: it is what the plugin's own
  // numberArray() view hands back, and being right for it costs one branch.
  check("a raw number[] payload still decodes",
    wcNativeSlugFromRecord({ type: "U", payload: uriBytes(4, "wildcatraffle.com/?tap=room-16") })
      === "room-16");
  check("and so does a Uint8Array payload",
    wcNativeSlugFromRecord({ type: "U", payload: Uint8Array.from(uriBytes(4, "wildcatraffle.com/?tap=room-16")) })
      === "room-16");
  // And so does an already-expanded URL string, which is what the plugin's
  // string() view produces. That is not base64, so the byte path returns null
  // and the fallback has to catch it.
  check("an already decoded URL string still decodes",
    wcNativeSlugFromRecord({ type: "U", payload: "https://wildcatraffle.com/?tap=room-16" })
      === "room-16");

  check("a whole tag object that is nonsense yields null", wcNativeSlugFromTag(null) === null);
  check("a tag with no messages yields null", wcNativeSlugFromTag({}) === null);
  check("a tag with an empty message yields null", wcNativeSlugFromTag(tag()) === null);
}

console.log("\nA URL with no tap slug is somebody else's tag, not an error");
{
  // These are real. A shop loyalty tag, a Wi-Fi poster, a museum label: the
  // scanner meets them and must keep listening rather than reporting a failure
  // at a student who has not done anything wrong.
  for (const [label, url] of [
    ["our own domain with no query", "https://wildcatraffle.com/"],
    ["our own domain with some other query", "https://wildcatraffle.com/?ref=poster"],
    ["an empty tap parameter", "https://wildcatraffle.com/?tap="],
    ["somebody else's site entirely", "https://example.com/promo"],
    ["a tel: tag", "tel:+15551234567"],
    ["a mailto: tag", "mailto:office@westbrookacademy.org"],
    ["an empty string", ""],
  ]) {
    check(`${label} yields no slug`, wcNfcSlugFromUrl(url) === null, String(wcNfcSlugFromUrl(url)));
  }
  check("a tel: URI record yields no slug", wcNativeSlugFromRecord(uriRecord(5, "+15551234567")) === null);
  check("another school's tap URL still reads as a slug, and the SERVER refuses it",
    wcNfcSlugFromUrl("https://example.com/?tap=room-16") === "room-16",
    "the host is not the guard here; tapLocations is");
}

console.log("\nThe whole tag, in the order the records arrive");
{
  check("a tag whose only record is ours", wcNativeSlugFromTag(
    tag(uriRecord(4, "wildcatraffle.com/?tap=restroom-2"))) === "restroom-2");

  // A human readable label written second is normal practice, and the URI
  // record must still be found past it.
  check("a Text label first, our URI record second", wcNativeSlugFromTag(
    tag(record("T", [0x02, ...Buffer.from("enRestroom 2", "utf8")]),
        uriRecord(4, "wildcatraffle.com/?tap=restroom-2"))) === "restroom-2");

  check("the FIRST of our slugs wins when a tag carries two", wcNativeSlugFromTag(
    tag(uriRecord(4, "wildcatraffle.com/?tap=restroom-2"),
        uriRecord(4, "wildcatraffle.com/?tap=room-16"))) === "restroom-2");

  check("a slug is folded to lower case, as the server stores it", wcNativeSlugFromTag(
    tag(uriRecord(4, "wildcatraffle.com/?tap=Restroom-2"))) === "restroom-2");

  check("a tag with several messages is searched through", wcNativeSlugFromTag({
    messages: [
      { records: [record("ID", Buffer.from("04A2B3", "utf8"))] },
      { records: [uriRecord(4, "wildcatraffle.com/?tap=nurse")] },
    ],
  }) === "nurse");
}

console.log("\nThe two things String.fromCharCode.apply got wrong");
{
  // A multi-byte character used to come back mangled, one byte at a time, so a
  // URL carrying one decoded to something that was not the URL on the tag.
  const url = "https://wildcatraffle.com/?tap=room-16&label=" + encodeURIComponent("Café");
  check("multi-byte UTF-8 survives the decode",
    wcNativeUriFromBytes(uriBytes(0, url)) === url);
  check("and the slug still comes out", wcNativeSlugFromRecord(uriRecord(0, url)) === "room-16");

  // The old call spread the whole payload as arguments, which blows the stack
  // once a tag is big enough. An NTAG216 holds ~888 bytes, so this is not
  // theoretical; it is one oversized sticker away.
  const long = "wildcatraffle.com/?tap=room-16&pad=" + "a".repeat(200000);
  let threw = null;
  let slug = null;
  try { slug = wcNativeSlugFromRecord(uriRecord(4, long)); } catch (e) { threw = e; }
  check("a 200KB payload does not blow the stack", threw === null, threw && threw.message);
  check("and its slug still comes out", slug === "room-16");
}

console.log("\nBytes in, bytes out");
{
  check("base64 decodes to the same bytes that went in",
    JSON.stringify(wcNativeRecordBytes(Buffer.from([4, 104, 105]).toString("base64")))
      === JSON.stringify([4, 104, 105]));
  check("high bytes survive the decode without sign trouble",
    JSON.stringify(wcNativeRecordBytes(Buffer.from([0, 200, 255]).toString("base64")))
      === JSON.stringify([0, 200, 255]));
  check("an empty byte array yields no URI", wcNativeUriFromBytes([]) === null);
  check("null bytes yield no URI", wcNativeUriFromBytes(null) === null);
}

/* ============================================================
   WHAT GETS WRITTEN ONTO A STICKER.

   This one is worth more than it looks, because its failure is silent and
   arrives as a wall of dead tags.

   @exxili/capacitor-nfc does the string-to-bytes framing in its JS WRAPPER
   (dist/esm/index.js, buildUriPayload). This app has no bundler and cannot
   import that wrapper, so it talks to Capacitor.Plugins.NFC directly and has to
   do the framing itself. Hand the raw bridge a STRING payload and the iOS side
   does this, in NFCPlugin.swift:

     let payload = recordData["payload"] as? [NSNumber]   // cast fails
     ... "Skipping record due to missing or invalid 'payload'"  // record dropped
     ... call.resolve()                                    // success anyway

   An EMPTY NDEF message is written and the admin is told every sticker
   programmed correctly. They would find out when a child stood at a doorway.
   ============================================================ */
/** The full source of a named function, brace-matched. */
function fnBody(source, name) {
  const start = source.indexOf(name);
  if (start === -1) { console.log(`\n  FAIL  not found in source: ${name}`); process.exit(1); }
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") { depth--; if (depth === 0) return source.slice(start, i + 1); }
  }
  return source.slice(start);
}

console.log("\nWhat gets written onto a sticker");
{
  const wcNativeUriPayload = new Function(
    fnBody(src, "function wcNativeUriPayload") + "\nreturn wcNativeUriPayload;",
  )();

  const url = "https://wildcatraffle.com/tap/?tap=restroom-2";
  const out = wcNativeUriPayload(url);

  // The invariant that actually protects the tags.
  check("the payload is an ARRAY, never a string", Array.isArray(out),
    "a string payload is silently dropped by the plugin and writes a blank tag");
  check("every element is a byte", out.every((b) => Number.isInteger(b) && b >= 0 && b <= 255));
  check("it opens with a URI identifier code", out[0] >= 0x00 && out[0] <= 0x23);
  check("code 0 means the scheme is spelled out in full",
    out[0] !== 0x00 || Buffer.from(out.slice(1)).toString("utf8") === url);
  check("and the URL survives the round trip",
    wcNativeUriFromBytes(out) === url);
  check("a slug with no room to grow still fits an NTAG213",
    wcNativeUriPayload("https://wildcatraffle.com/tap/?tap=" + "x".repeat(40)).length < 144,
    "NTAG213 usable is 144 bytes");

  // Pinned against the plugin's own implementation where it is installed.
  // mobile/node_modules is gitignored and per machine, so this cannot be a hard
  // requirement on a fresh clone; it is a hard assertion wherever it CAN run.
  const wrapper = new URL(
    "./mobile/node_modules/@exxili/capacitor-nfc/dist/esm/index.js",
    import.meta.url,
  );
  if (fs.existsSync(wrapper)) {
    const plug = fs.readFileSync(wrapper, "utf8");
    const buildUriPayload = new Function(
      "const b = " +
        fnBody(plug, "const buildUriPayload = (uri").replace(/^const buildUriPayload = /, "") +
        "\nreturn b;",
    )();
    check(
      "byte-identical to the plugin wrapper this app cannot import",
      JSON.stringify(wcNativeUriPayload(url)) === JSON.stringify(buildUriPayload(url)),
    );
  } else {
    console.log("  SKIP  plugin comparison (mobile/node_modules not installed here)");
  }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
