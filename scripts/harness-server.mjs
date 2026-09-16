/**
 * A static file server for the harnesses, with no dependency on the working
 * directory.
 *
 * WHY THIS EXISTS. The preview pane spawns a dev server with a cwd this sandbox
 * will not let a process read: `npm run dev` dies in npm's own config
 * bootstrap with "EPERM: process.cwd failed ... uv_cwd", and
 * `python3 -m http.server` dies in argparse, whose --directory default is
 * os.getcwd(). Both fail before any of their own code runs, so neither can be
 * configured around it.
 *
 * Every path here is derived from import.meta.url, which is absolute and needs
 * no cwd. Node itself starts fine; it is only the package managers that do not.
 *
 * WHAT IT IS FOR. The dashboard and cash harnesses are plain HTML that link the
 * real stylesheets. Opened as a file:// snapshot those links resolve to
 * nothing and every frame renders unstyled -- which on 2026-09-16 had me read a
 * panel's position off a page with zero stylesheets loaded, and let a
 * three-column store row inside a 270px panel reach a live student portal
 * unseen. Served over http, the harness is the app's real CSS.
 *
 * Read-only, and refuses anything outside the project root.
 *
 * RUN IT YOURSELF; THE PREVIEW PANE CANNOT. Its spawned processes are denied
 * even `open` on a file in this directory -- a stronger restriction than the
 * cwd one, and not something a launch.json can be written around:
 *
 *     node scripts/harness-server.mjs
 *     # then open http://localhost:8181/dashboard-harness.html
 *
 * A .claude/launch.json pointing here was removed for that reason; leaving one
 * only makes the pane fail on every attempt.
 *
 * AND THE DASHBOARD HARNESS IS PESSIMISTIC ABOUT WIDTH. It renders .wp-top and
 * .wp-dash but not .wp-stage, .wp-detail or .wp-passbar, so the desk shell's
 * columns collapse and the dash comes out around 344px where the real app
 * gives it the full width. Good for catching a squeeze -- the store row bug of
 * 2026-09-16 shows up here -- and wrong for answering "is this above the fold
 * on a Chromebook", which needs those three elements added first.
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname, normalize, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.HARNESS_PORT || 8181);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    // Default to the dashboard harness, since that is what this is for.
    let rel = decodeURIComponent(url.pathname);
    if (rel === "/" || rel === "") rel = "/dashboard-harness.html";

    // NO ESCAPING THE ROOT. normalize collapses .. before the prefix test, so
    // a request for /../../.ssh cannot resolve outside the project.
    const target = join(ROOT, normalize(rel));
    if (!target.startsWith(ROOT)) {
      res.writeHead(403).end("Outside the project root.");
      return;
    }

    const s = await stat(target).catch(() => null);
    if (!s || !s.isFile()) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
        .end(`Not found: ${rel}\n\nTry /dashboard-harness.html`);
      return;
    }

    const body = await readFile(target);
    res.writeHead(200, {
      "content-type": TYPES[extname(target).toLowerCase()] || "application/octet-stream",
      // No caching: a harness is rebuilt and reloaded constantly, and a stale
      // stylesheet here would be the exact failure this server exists to stop.
      "cache-control": "no-store",
    }).end(body);
  } catch (e) {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" })
      .end(String((e && e.message) || e));
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`harness server on http://localhost:${PORT}/ serving ${ROOT}`);
  console.log(`  /dashboard-harness.html   /cash-harness.html   /pass-harness.html`);
});
