/**
 * Packages powerschool/plugin into an installable PowerSchool plugin zip.
 *
 * Run:  npm run build:plugin
 * Out:  powerschool/out/wildcat-hub-sync-<version>.zip
 *
 * PowerSchool requires plugin.xml at the archive root, not inside a wrapper
 * folder. Zipping the folder itself is the single most common install failure,
 * so this script zips the contents and then verifies the layout before it
 * hands you the file.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = resolve(HERE, "..", "..", "plugin");
const OUT_DIR = resolve(HERE, "..", "..", "out");
const PLUGIN_XML = resolve(PLUGIN_DIR, "plugin.xml");

function fail(message) {
  console.error(`\nFAILED: ${message}`);
  process.exit(1);
}

if (!existsSync(PLUGIN_XML)) {
  fail(`plugin.xml not found at ${PLUGIN_XML}`);
}

const xml = readFileSync(PLUGIN_XML, "utf8");

// Read the version off the <plugin> element specifically. Matching any
// version attribute picks up the <?xml version="1.0"?> declaration instead.
const pluginTag = xml.match(/<plugin\b[\s\S]*?>/);
if (!pluginTag) fail("Could not find the <plugin> element in plugin.xml.");
const versionMatch = pluginTag[0].match(/\bversion="([^"]+)"/);
if (!versionMatch) fail("The <plugin> element has no version attribute.");
const version = versionMatch[1];

// Guard: the brief forbids write access anywhere in the access request.
const writeAccess = xml.match(/access="(?!ViewOnly")([^"]+)"/g);
if (writeAccess) {
  fail(
    `plugin.xml requests non read access: ${[...new Set(writeAccess)].join(", ")}. ` +
      `This plugin is scoped to read only.`,
  );
}

// Guard: <access_request> takes <field> elements directly. Wrapping them in a
// <data> element is schema invalid and PowerSchool rejects the install with
// "Invalid content was found starting with element ...:data".
if (/<data>/.test(xml)) {
  fail(
    "plugin.xml wraps its fields in a <data> element. The schema expects " +
      "<field> directly inside <access_request>. Remove the wrapper.",
  );
}

// Guard: the access request must actually contain fields.
const fieldCount = (xml.match(/<field\s/g) ?? []).length;
if (fieldCount === 0) fail("plugin.xml declares no fields.");

// Guard: no secret ever belongs in the plugin package.
if (/client[_-]?secret|client[_-]?id\s*=\s*"[^"]{6,}"/i.test(xml)) {
  fail("plugin.xml appears to contain a client id or secret. Remove it before packaging.");
}

// Guard: the em dash rule applies to shipped files too. Written as an escape
// so this file does not itself contain the character it is banning.
const EM_DASH = "—";
const emDashFiles = [];
for (const file of [PLUGIN_XML, resolve(PLUGIN_DIR, "queries_root", "wildcathub.named_queries.xml")]) {
  if (existsSync(file) && readFileSync(file, "utf8").includes(EM_DASH)) {
    emDashFiles.push(file);
  }
}
if (emDashFiles.length > 0) {
  fail(`Em dash found in: ${emDashFiles.join(", ")}`);
}

mkdirSync(OUT_DIR, { recursive: true });
const zipPath = resolve(OUT_DIR, `wildcat-hub-sync-${version}.zip`);
rmSync(zipPath, { force: true });

// -r zips recursively, -x excludes macOS cruft that PowerSchool rejects.
execFileSync(
  "zip",
  ["-r", "-q", zipPath, ".", "-x", ".DS_Store", "-x", "__MACOSX/*", "-x", "*/.DS_Store"],
  { cwd: PLUGIN_DIR, stdio: "inherit" },
);

const listing = execFileSync("unzip", ["-l", zipPath], { encoding: "utf8" });
if (!/\splugin\.xml\s*$/m.test(listing)) {
  fail("plugin.xml is not at the archive root. PowerSchool will reject this zip.");
}

console.log(listing);
console.log(`Built ${zipPath}`);
console.log(`Plugin version ${version}, ${fieldCount} fields requested, all ViewOnly`);
console.log("");
console.log("Next: PowerSchool > System > System Settings > Plugin Management Configuration");
console.log("      Install, then Enable, then copy the client id and secret into .env.");
console.log("      See docs/plugin-install.md.");
