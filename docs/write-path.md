# The PowerSchool write path

**Status: built, tested, and shut.** The client can express every write this
project could legitimately want. It has never sent one, and it refuses to,
because four independent gates are closed and none of them can be opened by
environment variables alone.

Nothing in this document was learned by attempting a write against
`lapf.powerschool.com`. The instance is production and holds real student
records; a write that unexpectedly succeeded would mutate a child's file and
could not be undone. The write state was established by reading the granted
access request and by driving the client against a local fake. One question,
whether the `LOG` table is exposed at all, was answered with a single **GET**,
which is the only verb that could answer it and the only one this repo's read
harness permits (section 6).

- Code: `powerschool/sync/src/write-client.ts`
- Tests: `powerschool/sync/src/write-client.test.mjs`, 403 assertions, all
  against an injected fake or a `node:http` server on `127.0.0.1`
- Print the grant proof and the exact requests: `node src/write-client.ts --explain`
  from `powerschool/sync`
- Answer the exposure question again at any time:
  `node --env-file=.env src/write-client.ts --probe-log` (GET only)

### What changed in this revision, and why

A reviewer defeated the previous version of this document. Three of its claims
were wrong and are corrected below, in place, rather than quietly dropped:

1. **Gate 2 was openable from inside this repo.** `WriteClientOptions` accepted
   any `grantsPath`, so pointing it at a proposed grant file in the working tree
   plus setting two environment variables produced `preflight ok: true` against
   `lapf.powerschool.com` and opened a socket. Section 4 is new and describes
   the binding that now prevents it. Line for line, the old claim that gate 2 is
   "not openable from this repo alone" was false.
2. **The free-text earned-value scan was cited as a control.** It is lint. The
   same reviewer got 11 of 11 adversarial phrasings past it. Clause 1 now cites
   only the three structural controls, which do hold under attack.
3. **The conflict rule's watermark had no storage.** Clause 3 is
   compare-and-set, and a fingerprint that lives in a local variable proves
   nothing across processes. `WatermarkStore` is now part of the rule and the
   methods that need it refuse to run without one.

A fourth defect was a raw NUL byte in `write-client.ts`, which made `file(1)`
report it as `data` and made BSD `grep` skip it silently, so every grep-based
audit of the repo, including the no-em-dash rule and any secret sweep, excluded
that file without saying so. Fixed; the file is ASCII text again.

### What changed in the revision after that, and why

A second reviewer defeated the version above. Three more claims were wrong, and
the first of them was worse than the bypass it replaced: it needed only
`PS_WRITE_ENABLED`, where the earlier one also needed a production host string
and `PS_WRITE_ALLOW_PRODUCTION_HOST=yes`.

5. **The base URL check was a string prefix, not an origin comparison, and
   every other gate derived "am I talking to a local fake" from the client's
   base URL rather than from the URL being sent.** `preflight` tested
   `request.url.startsWith(this.baseUrl)`. On a client bound to
   `http://127.0.0.1`, the URL
   `http://127.0.0.1@lapf.powerschool.com/ws/schema/table/log` passes that test,
   because everything before the `@` is a URL's *userinfo* component and the
   host is what follows it. `hostBlock()` returned `null` on sight of a loopback
   base, so gate 3 never ran. `preflight` computed `loopback` from the base too,
   so the caller's grant override was honoured and gate 2 never consulted the
   installed plugin. Result: `preflight.ok` **true**, block list **empty**, and
   the client handed `fetch()` a `POST` whose URL host was
   `lapf.powerschool.com`, the production SIS. Only `PS_WRITE_ENABLED` was
   needed; the production-host variable was not. Reproduced before fixing.
   The comparison is now parsed on both sides and matched by protocol, hostname
   and port; a URL carrying userinfo is refused outright; and every gate reads
   the parsed request URL. Section 2 and test section 26.
6. **Gate 3 was dead code in both directions.** The previous revision documented
   `ProductionHostBlocked` as deliberately unreachable because gate 2 outranked
   it. It was also skipped outright on loopback-bound clients, so it could not
   fire under *any* reachable configuration. A gate whose entire job is stopping
   production traffic that can never execute is not a gate. It now sits in tier
   2 of the refusal precedence, above arming and above the grant, and test
   section 6 asserts that `send()` actually throws it.
7. **`Subtype` and `Consequence` were free strings capped at 20 characters**
   while `LogTypeID` got the full GEN treatment, so the client could file an
   entry under a classification this district never configured. PowerSchool's
   own docs are explicit that both are configured menu fields. Both are now
   resolved from GEN by name, with the same refusals `resolveLogType` already
   had, and a subtype is additionally bound to the log type it hangs off.
   Section 5 and test section 27.

Three further holes were found while fixing those and closed in the same pass,
none of them reported by a reviewer:

8. **The declared table and columns were never checked against the wire.**
   `send()` accepts a plain object, and `request.table` / `request.columns` are
   what the grant check and the allowlists read, while the URL and the body are
   what the socket reads. A hand-built request could declare `log` / `["Entry"]`
   and carry `{"tables":{"students":{"Discipline_ActionTaken":"S"}}}`. Gate 1c.
9. **Redirects were followed.** `fetch()` follows `3xx` by default, which would
   carry the `POST`, its bearer token and its body to a host no gate examined,
   and following a redirect on a `POST` can replay a write. Both the token call
   and the write call now set `redirect: "error"`. Test section 26c includes a
   control proving default `fetch` does follow, so the assertion tests the
   client's choice rather than the platform's.
10. **Time of check against time of use.** `request.url` was read once by the
    gates and again by `fetch()`; a getter could answer loopback for the first
    and production for the second. `send()` now materialises the request once,
    before any gate runs, and reads only that snapshot.

## 1. The conflict rule

Three clauses. Each names where it is enforced, so a reviewer can check the
claim rather than take it.

### Clause 1. The app is authoritative for points, and the SIS never learns them

This is stronger than "the app wins a merge". The number is never transmitted in
either direction. There is no reconciliation to get wrong because there is
nothing to reconcile.

Students hold 6,616,500 in Wildcat Cash. PowerSchool has no counterpart for a
single unit of it. Mirroring the balance into the SIS, in any table, would
create a second authority for a number the SIS never generated, and the two
would diverge the moment either side was edited.

**The controls are structural. There are exactly three, and only these three
should ever be cited:**

| # | Control | Where |
|---|---|---|
| 1 | The caller-facing input type has no `amount`, `points`, `balance` or `tickets` parameter, so there is no parameter through which a number can arrive | `BehaviorEntryInput` |
| 2 | No column on the write allowlist could hold a balance. Every writable column is an identifier, a date, an author, a type, or free prose | `LOG_WRITABLE_COLUMNS` |
| 3 | `buildLogRow` constructs the outgoing row key by key from known fields. It never spreads the caller's object, and `assertWritableColumns` re-checks the finished key set | `buildLogRow` |

Verified adversarially rather than asserted. An input object carrying
`wildcatCashBalance: 6616500`, `points: 999`, `Discipline_ActionTaken: "S"`,
`DCID: "1"` and `amount: 500` produces this payload:

```
StudentID, SchoolID, Entry_Date, Entry_Time, Entry_Author, Subject, Entry, LogTypeID
leaked 6616500? false | points? false | Discipline? false | DCID? false
```

**`findEarnedValueText` is lint, not a control.** It scans the two free-text
columns for an obviously stated amount. A reviewer got 11 of 11 adversarial
phrasings past it, including "awarded 100", "student now has 1,250", "cash 5000",
"gave him 50 wc" and "Deducted one hundred Wildcat Cash". It exists to catch the
honest accident, a teacher typing "Deducted 100 Wildcat Cash for defiance" into
a note, and it will miss a determined phrasing every time. Do not weaken
anything above on the strength of it, and do not read a pass as evidence. It is
tested in both directions anyway, because a lint rule that refuses ordinary
sentences gets switched off by the first teacher who hits it.

Note the deliberate asymmetry with the read path: `convex/sisMerge.ts` guards the
inbound direction with an allowlist of SIS-owned fields. This file guards the
outbound direction the same way. Neither uses a denylist. A denylist fails open,
so the day somebody adds `springCarnivalTickets` it is silently writable until a
human remembers to exclude it.

### Clause 2. PowerSchool is authoritative for enrollment, and the app never writes it

Enrollment, demographics, sections, courses, terms, attendance and grades flow
one way: SIS to app. The write client cannot address any of them.

Enforced by a one-entry table allowlist:

```
export const WRITABLE_TABLES = ["log"] as const;
```

`students`, `cc`, `sections`, `courses`, `terms`, `attendance`, `pgfinalgrades`,
every `U_` extension table, and the entire `/ws/v1` resource surface are
unreachable from this file. There is no code path that constructs a request for
them, and `send()` refuses a hand-built one. Tested.

`/ws/v1` matters here specifically because it is the surface that can update a
core student record, and PSUG's own hands-on lab lists "UPDATE a student's name"
as an exercise. It is real, it works, and this client does not implement it.

An app-owned `U_` extension table deserves a named refusal, because the
reference is correct that it is the only write target a third party can create
from scratch, and somebody will propose it. It is declined on principle, not on
access: see clause 1. Recorded here so it does not have to be rediscovered.

### Clause 3. A human edit in PowerSchool beats the app, always

**The app may overwrite a behavior entry only when it can prove the row is still
exactly what it last wrote.** Anything else returns a conflict for a human to
resolve. It never merges, never picks a winner, and never writes on a guess.

PowerSchool's `LOG` table exposes no reliable last-modified column, so this is
compare-and-set against a content fingerprint rather than a timestamp check.
That is the stronger test, not the weaker one: a timestamp tells you *when*
something changed, a fingerprint tells you *whether*, and only "whether" decides
if an overwrite destroys an edit.

**The watermark is stored, not assumed.** This is what makes the clause real
rather than decorative. `WatermarkStore` has two implementations in
`write-client.ts`: `FileWatermarkStore`, a JSON document written to a temp file
and renamed so a half-written watermark can never be read, and
`MemoryWatermarkStore`, named so a production caller cannot pick it up by
accident. `createBehaviorEntry`, `updateBehaviorEntry` and
`updateBehaviorEntryByAppEntryId` all **refuse to run** without a store rather
than degrading to an unconditional overwrite. The Convex-backed store for the
eventual real caller is in section 8 as a proposed diff, not applied, because
`convex/schema.ts` is shared and off limits to this piece.

Mechanism, in `planUpdate`:

1. The app stores a **watermark** after every successful write: the DCID, the
   exact column map it sent, a SHA-256 fingerprint of that map, the author, and
   the time. `updateBehaviorEntryByAppEntryId` reads it back out of storage; a
   caller cannot hand in a watermark it assembled itself.
2. Before any update the caller must supply a **fresh read-back** of the row.
   Not a cached one: a read older than 120 seconds is refused outright.
2b. The read-back must be **unprojected**. `RemoteRow` carries a required
   `projection` field and anything other than `"*"` aborts. This is not
   bookkeeping. Steps 3 and 4 below look for a provenance marker inside `Entry`
   and for populated `Discipline_*` columns; a caller who read back only the
   columns it intended to write would find neither and would pass both checks
   having proven nothing. Requiring the projection to be declared turns that
   silent bypass into a refusal.
3. The row must still carry the app's **provenance marker**
   (`[wildcat-hub:<appEntryId>]`, appended to `Entry` on every write). A missing
   or different marker means the text was rewritten by a human, or the DCID was
   reused. Conflict.
4. If the row carries any populated `Discipline_*` column, a human has promoted
   the note into a discipline record. The app never touches it again, not even
   the columns it originally wrote. Conflict.
5. If the read-back's fingerprint differs from the watermark's, somebody edited
   it. The conflict names the changed columns. No write.
6. If the read-back already equals the desired content, no-op. An unchanged
   entry produces zero writes rather than a redundant PUT.
7. Only then, write. The new fingerprint is persisted before the call returns.

Plus these failure modes, which are aborts rather than conflicts:

- **No watermark on record for this `appEntryId`.** The app cannot prove what it
  last wrote, so it must not overwrite. A human decides, not a retry.
- **The watermark carries no DCID.** The create landed but PowerSchool returned
  no recognisable row id, so the app wrote a row it cannot address. That state
  is recorded rather than dropped: dropping it would leave the app believing it
  never wrote at all and duplicating the entry on the next attempt.
- **The row is gone from PowerSchool.** Somebody deleted it. The app does not
  recreate a row a human removed.
- **The watermark's fingerprint does not match its own recorded columns**,
  meaning the watermark itself was altered in storage or transit. Nothing
  derived from it is trusted.

Creation has the mirror problem: the endpoint offers no idempotency key, so a
retry after a lost response would duplicate a child's behavior entry.
`planCreate` closes that by hand. The caller reads back the student's rows, and a
row already carrying this `appEntryId` means the earlier attempt landed. It
returns `noop` with the existing DCID instead of writing a second one.

**Known limit, stated plainly.** The 120 second freshness bound narrows the race
between the read-back and the write; it does not close it. `/ws/schema/table`
offers no conditional write, no ETag and no If-Match, so a human editing the row
inside that window loses their edit. Closing it properly requires a
PowerSchool-side capability that does not exist. If that risk is unacceptable,
the answer is not a shorter window, it is to not enable the write path.

## 2. The four gates

All four must be open before a byte leaves the process. Today none of the first
three are.

| # | Gate | Opened by | State |
|---|---|---|---|
| 1 | **Arming** | `PS_WRITE_ENABLED` set to the exact literal `enable-powerschool-writes` | **closed** |
| 2 | **Grant** | every target column carrying `access="FullAccess"` in the **installed** `plugin.xml`, at the version recorded in `INSTALLED_PLUGIN_VERSION`, and actually approved inside PowerSchool | **closed.** Not openable by any environment variable, and not openable by pointing the client at a different file. See section 4 for exactly what it does and does not prove |
| 3 | **Host** | `PS_WRITE_ALLOW_PRODUCTION_HOST=yes`, needed because `lapf.powerschool.com` carries no sandbox marker. Judged on the **parsed hostname of the request URL**, not on `PS_HOST` and not on the client's base URL | **closed** |
| 4 | **Ceiling** | `PS_WRITE_CEILING`, default 25 mutating requests ATTEMPTED per process. Attempts, not responses: a fetch that throws may still have landed | open, capped |

Gate 1 deliberately does not accept `1`, `true` or `yes`. A generic truthy value
is the kind of thing a CI template sets by accident. The literal can only appear
because somebody typed it on purpose, and it greps cleanly across the repo and
the deployment config.

**All four gates read the URL that is about to go on the wire, not the client's
base URL.** This sentence is the correction of the defect described in point 5
above and it is the load-bearing one in this section. A previous revision
decided "am I talking to a local fake" from `this.baseUrl`, which meant a client
bound to `127.0.0.1` skipped gate 2 and gate 3 entirely for a request addressed
to `lapf.powerschool.com`. Gate 3 now assesses `productionRisk` against the
parsed hostname of the request; gate 2 honours a caller-supplied grant override
only when the parsed hostname is loopback **and** the client is loopback bound.

**Refusal precedence**, which decides only which reason a human reads first.
Every block is always reported in `preflight().blocks` regardless.

| Tier | Blocks | Error class |
|---|---|---|
| 1 | `verb:`, `table:`, `url:`, `body:` | `ForbiddenTarget` |
| 2 | `host:` | `ProductionHostBlocked` |
| 3 | `grant-source:`, `grant-version:`, `grant-override:` | `GrantMissing` |
| 4 | `arming:` | `WriteDisarmed` |
| 5 | `grant:` | `GrantMissing` |
| 6 | `ceiling:` | `WriteCeilingReached` |

Tier 1 is the set of things that are never permissible under any configuration;
nothing can be set to make them acceptable. Tier 2 was previously ordered below
the grant, which combined with the loopback shortcut made `ProductionHostBlocked`
unreachable under every configuration a caller could construct. "You are aimed
at the SIS holding 641 real students" is the most alarming true statement
available, so it leads.

Five structural controls sit alongside the gates:

- **Verb allowlist: POST and PUT only.** `DELETE` is not implemented and is
  refused at the chokepoint even if a request object carrying it is hand-built.
  Nothing in Wildcat Hub should be able to remove a SIS row. "The teacher took
  it back" is expressed as `renderRetract`, an edit that leaves the original
  text in place and appends a dated, attributed retraction line. The audit trail
  survives; the record does not vanish.
- **Target matching is an ORIGIN comparison.** Both sides are parsed with
  `new URL()` and matched on protocol, hostname and port. A URL carrying a
  userinfo component is refused outright, because the host such a URL resolves
  to is whatever follows the `@` rather than what precedes it, and this client
  never needs a credential in a URL: it authenticates with a bearer token. The
  path must sit under `/ws/schema/table/`. A URL that does not parse is a block,
  never an exception a caller could catch. Refused and tested:
  `http://127.0.0.1@lapf.powerschool.com/...`,
  `http://127.0.0.1.lapf.powerschool.com/...`,
  `http://127.0.0.1<U+3002>lapf.powerschool.com/...` (an ideographic full
  stop, which `new URL()` normalises to a real dot), `http://127.0.0.1:9999.evil/...`
  (does not parse), `https://127.0.0.1/...` on an `http` base, a differing port,
  and on a production-bound client
  `https://lapf.powerschool.com.evil.test/...` and
  `https://lapf.powerschool.com@evil.test/...`, both of which the old prefix
  test also allowed.
- **The loopback escape hatch cannot address a real instance.** Tests drive the
  client against `127.0.0.1` through a `loopbackBaseUrl` option that is checked
  against `^http://127\.0\.0\.1(:\d{1,5})?$`. `http://localhost:8080`,
  `http://127.0.0.1.evil.test`, `http://127.0.0.1@lapf.powerschool.com` and
  anything `https://` are all refused by the constructor. That was already true
  and was never the hole; the hole was that the constructor check was anchored
  at both ends and the `preflight` check was anchored at neither.
- **What preflight judges is what the wire carries** (gate 1c). The table named
  in the URL path, the table named in the body's `tables` envelope and the
  declared `request.table` must all be the same one, and the body's column set
  must be exactly the declared column set, re-checked against the allowlists.
  Without this, a hand-built request could declare `log` / `["Entry"]`, satisfy
  the grant check on those, and send `students` with a `Discipline_*` column.
- **Redirects are refused, not followed, and the request is snapshotted once.**
  `redirect: "error"` on both the token call and the write call, because a `3xx`
  would carry the POST, the bearer token and the body to a host no gate looked
  at. `send()` materialises the caller's request object through a single JSON
  round trip before any gate runs, so a `url` or `body` getter cannot answer
  loopback for the gates and production for `fetch()`.

The rendering half (`renderCreate`, `renderUpdate`, `renderRetract`) reads no
environment, opens no socket, and always works. That is deliberate: a human can
print the exact request long before anybody considers enabling anything.

## 3. Proof that the current grant blocks writes

Read from the granted access request, not attempted. Real output of
`node src/write-client.ts --explain`:

```
Access request read from: .../powerschool/plugin/plugin.xml
Grant source:             installed (only "installed" can authorise a write)
Plugin version:           1.0.6
Version recorded as installed on the instance: 1.0.6
Source binding:           OK, this is the installed plugin at the pinned version.
Declared fields:          107 across 16 tables (107 ViewOnly, 0 FullAccess)

Grant check for the 10 columns a create would write:
  BLOCK log.StudentID          needs FullAccess, has not requested
  BLOCK log.SchoolID           needs FullAccess, has not requested
  BLOCK log.Entry_Date         needs FullAccess, has not requested
  BLOCK log.Entry_Time         needs FullAccess, has not requested
  BLOCK log.Entry_Author       needs FullAccess, has not requested
  BLOCK log.Subject            needs FullAccess, has not requested
  BLOCK log.Entry              needs FullAccess, has not requested
  BLOCK log.LogTypeID          needs FullAccess, has not requested
  BLOCK log.Subtype            needs FullAccess, has not requested
  BLOCK log.TeacherID          needs FullAccess, has not requested

VERDICT: 10 of 10 columns are blocked by the granted access request. Writes are
impossible today, proven by reading plugin.xml, not by sending anything.

Arming: PS_WRITE_ENABLED is not set. The write client refuses every mutating
verb by default.
```

Why this is conclusive rather than suggestive. PowerSchool's published
`plugin.xsd` defines `access` as an enumeration of exactly two values, `ViewOnly`
and `FullAccess`. There is no partial, no write-only, no per-verb variant, and
grants are per column, one `<field>` element each, with no wildcard and no
table-level element. Anything not listed is denied. Plugin 1.0.6 declares 107
fields, all `ViewOnly`, and `LOG` appears in none of them. Write access does not
exist here by construction, not by omission.

Housekeeping note: this count finds **107** `<field>` elements. Prior docs say
108. The 108th `access="ViewOnly"` occurrence in the file is inside the header
comment on line 5, not a grant. The parser strips XML comments before counting,
which is also why a commented-out `<field>` cannot become a silent permission.
Tested.

## 4. What gate 2 actually proves, and what it does not

This section exists because the previous version of this document made a claim
here that was false, and the falsehood was load-bearing.

**What it does not prove.** Reading `plugin.xml` reads a file in a git working
tree. The working tree is not the SIS. A person with commit access can write
`access="FullAccess"` into that file in ten seconds, and doing so grants nothing:
PowerSchool only changes what it permits when an admin uploads a new plugin zip
and disables and re-enables the plugin. The grant check is a **proxy** for the
real authority, and the real authority is a human inside PowerSchool that this
repository cannot reach.

**What it does prove, and what stops the proxy being trivially forged.** Four
rules, each independently sufficient, all tested in section 24 of the suite:

1. **Path binding.** For any target that is not loopback, the grant check reads
   `powerschool/plugin/plugin.xml` fresh from disk, at a path resolved from the
   module's own URL. A `grants` index or `grantsPath` supplied by the caller is
   ignored for that decision, and its presence is reported as its own refusal
   (`grant-override:`) so the error names the real reason.
2. **Basename rule.** A `grantsPath` whose basename is not exactly `plugin.xml`
   is refused at construction, loudly, before anything else runs. This is the
   specific move that defeated the previous version: `grantsPath:
   powerschool/plugin/plugin-v2.xml`.
3. **Version pin.** `INSTALLED_PLUGIN_VERSION` in `write-client.ts` records the
   version a human confirmed is enabled on the instance. If `plugin.xml` moves
   ahead of it, the file stops counting as evidence. So applying a proposed
   grant locally does not quietly become permission to write; updating the pin
   is a separate, reviewable code change, and it is still only half the job.
4. **Loopback carve-out only.** A caller-supplied grant index is honoured
   exclusively when the client is bound to `127.0.0.1`, which cannot be a
   PowerSchool instance. That is the same treatment `loopbackBaseUrl` already
   had.

Reproduction of the original attack, with every externally settable gate opened
(`PS_WRITE_ENABLED`, `PS_WRITE_ALLOW_PRODUCTION_HOST`, `PS_WRITE_CEILING`) and a
fetch that throws and counts, against `lapf.powerschool.com`:

```
A in-memory open grant  -> preflight.ok: false | blocks: grant-override,grant
   refused: GrantMissing
B decoy plugin.xml      -> preflight.ok: false | blocks: grant-override,grant
   refused: GrantMissing
C plugin-v2.xml path    -> refused at construction: ForbiddenTarget
D loopback lie refused: https://lapf.powerschool.com          -> ForbiddenTarget
D loopback lie refused: http://127.0.0.1@lapf.powerschool.com -> ForbiddenTarget
D loopback lie refused: http://127.0.0.1.lapf.powerschool.com -> ForbiddenTarget
E prod URL on loopback client -> refused: ForbiddenTarget
G hand-built DELETE -> refused: ForbiddenTarget
G deleteBehaviorEntry exported? undefined

SOCKET ATTEMPTS THAT REACHED fetch(): 0 []
```

And the reviewer's original move, run verbatim against the real file the
sibling access-request piece produced (it now sits at `powerschool/plugin-v2.xml`,
having moved from `powerschool/plugin/`; the tests look in both places):

```
plugin-v2.xml FullAccess count: 11
plugin-v2.xml version: 2.0.0

=== BYPASS: grantsPath -> powerschool/plugin-v2.xml (NOT the installed plugin) ===
REFUSED: ForbiddenTarget
grantsPath ".../powerschool/plugin-v2.xml" is refused: its basename is
"plugin-v2.xml", not "plugin.xml". The grant check answers "what did PowerSchool
grant", and only the installed plugin.xml can answer it. A proposed grant such as
plugin-v2.xml is a request, not a permission.

SOCKET ATTEMPTS: 0 []
```

Case B is worth reading twice. It is a file **literally named `plugin.xml`**,
carrying the pinned version and a full set of `FullAccess` grants, placed in a
temp directory. It is refused by path, not by name, so renaming the decoy buys
nothing.

The next reviewer's attack, and the ones found while fixing it, run the same
way. Real output of an independent harness whose `fetch` records and refuses,
with a wide-open in-memory grant and **every** environment gate set:

```
A. The round-3 bypass, and every prefix-sharing neighbour
   (loopback-bound client, EVERY environment gate open)
   ok=false blocks=3 ForbiddenTarget  http://127.0.0.1:9999@lapf.powerschool.com/ws/schema/table/log
   ok=false blocks=3 ForbiddenTarget  http://127.0.0.1@lapf.powerschool.com/ws/schema/table/log
   ok=false blocks=3 ForbiddenTarget  http://127.0.0.1.lapf.powerschool.com/ws/schema/table/log
   ok=false blocks=3 ForbiddenTarget  http://127.0.0.1:9999.evil/ws/schema/table/log
   ok=false blocks=3 ForbiddenTarget  http://127.0.0.1<U+3002>lapf.powerschool.com/ws/schema/table/log
   ok=false blocks=1 ForbiddenTarget  https://127.0.0.1/ws/schema/table/log
   ok=false blocks=1 ForbiddenTarget  https://127.0.0.1:9999/ws/schema/table/log
   ok=false blocks=1 ForbiddenTarget  http://127.0.0.1:9998/ws/schema/table/log
   ok=false blocks=1 ForbiddenTarget  http://127.0.0.1:9999/ws/v1/student/4021

B. Gate 3 fires. Production-bound client, armed, wide-open grant override.
   ProductionHostBlocked: Refusing to send POST https://lapf.powerschool.com/...

C. Payload smuggling. Declares log/Entry, body writes students.
   ForbiddenTarget: - body: the body writes ["students"] but the request
   declares table "log". One table per request, and it must be the declared one.

D. Free-string subtype and consequence.
   subtype: PayloadRejected: Subtype must be a GenValueRef resolved from GEN
            rows where Cat='subtype', not the free string ...
   consequence: PayloadRejected: Consequence must be a GenValueRef ...

E. Earned value smuggled onto the input object.
   payload keys: StudentID,SchoolID,Entry_Date,Entry_Time,Entry_Author,
                 Subject,Entry,LogTypeID,Subtype
   leaks 6616500? false | 'points'? false | Discipline? false | DCID? false

F. DELETE, anywhere.
   ForbiddenTarget
   deleteBehaviorEntry on the client? undefined

G. Default arming, nothing set.
   WriteDisarmed

SOCKET ATTEMPTS THAT REACHED fetch(): 0 []
```

The three-block rows in A are worth reading: `url:`, `host:` and `grant:` all
fired. That is the second half of the fix visible in output. Before it, on a
loopback-bound client, `host:` and `grant:` were both skipped because both asked
the base URL rather than the request whether this was a local fake.

**The honest summary.** Gate 2 cannot be opened by an environment variable, by a
constructor option, or by any file the caller nominates. It can be opened by a
person who edits `plugin.xml`, edits `INSTALLED_PLUGIN_VERSION`, and gets a
PowerSchool admin to approve the plugin. That is three deliberate acts by at
least two people, one of whom does not work in this repository. It is not a
cryptographic guarantee and it is not described as one.

## 5. The exact requests, for eyeballing

Real output. Substitute your own student and log type; the shape is what matters.

**Create.** `POST https://lapf.powerschool.com/ws/schema/table/log`

```
Authorization: Bearer [redacted]
Accept: application/json
Content-Type: application/json
```
```json
{
  "tables": {
    "log": {
      "StudentID": 4021,
      "SchoolID": 3,
      "Entry_Date": "2026-08-12",
      "Entry_Time": "15:15:00",
      "Entry_Author": "Wildcat Hub (app)",
      "Subject": "Positive behavior",
      "Entry": "Helped a classmate reset the lab bench without being asked.\n[wildcat-hub:wh-2026-08-12-000123]",
      "LogTypeID": 404,
      "Subtype": "RESPECT",
      "TeacherID": 91
    }
  }
}
```

**Update.** `PUT https://lapf.powerschool.com/ws/schema/table/log/998877`

Same envelope plus a top level `id` and `name`:

```json
{
  "tables": { "log": { "...": "same columns" } },
  "id": "998877",
  "name": "log"
}
```

Six things a reviewer should check in that body, and why each is there:

1. **`LogTypeID` is 404 because GEN said so, not because the code says 404.**
   Log types are district configuration. A published real district's mapping
   runs Merits=404, Contact=461, Medical=514, MTSS=24018, plus a built-in
   negative Response To Behavior=-100000. Hardcoding one is how an integration
   files "Medical" when it meant "Merit". `resolveLogType` maps a name to this
   instance's id from GEN rows read at runtime, refuses a bare integer, refuses
   a row from the wrong GEN category, refuses an ambiguous name rather than
   picking one, and refuses a lookup older than 24 hours.
1b. **`Subtype` and `Consequence` get the same treatment, and did not used to.**
   A reviewer found them accepted as free strings capped at 20 characters, which
   let the client file an entry under a classification this district never
   created. PowerSchool's own admin documentation is explicit that both are
   configured menu fields. On Subtype, verbatim: *"Further characterization of a
   log entry associated to a specific LogType. By default, this field appears as
   a menu on the Log Entries page."* On Consequence: *"Action resulting from the
   log entry. By default, this field appears as a menu on the Log Entries
   page."* Subtypes are created per log type as a code plus a description pair
   (*"Enter the code for the log subtype"*, *"Enter a description of the log
   subtype"*), and the Data Dictionary says `LOG.Consequence` is *"populated by
   a popup build from the Gen table cat=consequence"*. So both live in GEN in
   their own `Cat`, and `resolveSubtype` / `resolveConsequence` refuse absence,
   refuse ambiguity, refuse another school's row, refuse a stale read, and
   refuse a free string by name. A subtype additionally records the log type it
   was resolved under, and `buildLogRow` refuses a subtype resolved under
   "Merits" on an entry filed under "Contact", which is a mistake no free string
   could ever have expressed. Sources:
   <https://ps.powerschool-docs.com/pssis-admin/latest/log-entry-fields> and
   <https://ps.powerschool-docs.com/pssis-admin/latest/log-types>, both fetched
   this session.
   **UNVERIFIED, confirm before enabling:** which GEN column supplies the string
   the LOG column actually stores. The columns are 20 characters wide, subtypes
   are documented as code plus description, and GEN carries `Name` as well as
   `Value`. The resolver prefers `Value`, then `Code`, then `Name`, and records
   which one it used in `valueColumn` so the choice is visible rather than
   inferred.
2. **`Entry_Date` is the school's date, not UTC's.** 2026-08-12T22:15Z is
   15:15 on the 12th in Los Angeles, and 2026-08-13T03:30Z is 20:30 on the
   *12th*. Formatting in UTC would file every after-school entry on the
   following day. Tested across DST and at local midnight.
3. **`Entry` ends with a provenance marker.** It tells a human reading a
   student's file which entries came from Wildcat Hub, and it is how a retry
   finds its own earlier write instead of duplicating it. A caller cannot
   supply one: text that already contains a marker is refused.
4. **No `Discipline_*` column appears, and none can.** All 34 are off the
   allowlist. Those columns exist to satisfy the federal Gun-Free Schools Act
   and feed state discipline reporting. Wildcat Hub writes a behavior **note**;
   it never files a discipline **record**. This is the single most important
   exclusion in the file.
5. **No amount appears anywhere.** See clause 1.

Over-length values are refused, never truncated. Silently trimming a behavior
note is data loss nobody notices until someone reads half a sentence in a
child's file. Caps come from the Data Dictionary: `Entry_Author` 30, `Subject`
40, `Subtype` 20, `Consequence` 20.

## 6. The exposure question, answered

**`LOG` is exposed over `/ws/schema/table`. The write path is real.**

This was the load-bearing unknown, and it is settled. Nothing in any public
document states that PowerSchool whitelists `log` for that endpoint, and this
instance already refuses some tables outright, so it could not be assumed either
way. It was answered with a **GET**, one row, through the read harness whose
chokepoint permits no verb but `GET` and `POST` to a named query. Real output of
`node --env-file=.env src/write-client.ts --probe-log`:

```
LOG exposure probe. GET only, one row, no mutation possible.
========================================================================
  log  HTTP 403  EXPOSED, UNGRANTED. The write path is real and is gated by the
       access request, exactly where this client says it is.
       {"message":"At least one column lacks sufficient permission",
        "errors":[{"code":"NoAccess","field":"dcid","resource":"Log"}]}
  gen  HTTP 403  EXPOSED, UNGRANTED.
       {"message":"At least one column lacks sufficient permission",
        "errors":[{"code":"NoAccess","field":"dcid","resource":"Gen"}]}
  teachers HTTP 405  NOT EXPOSED. PowerSchool does not serve this table over
       /ws/schema/table for anyone. No access_request edit can open it.
       {"message":"GET, POST and PUT are not allowed on table"}
```

`teachers` is in that run as a **control**, not a target. It is the table this
instance is already known to refuse at the endpoint level. A run that returns 403
for `log` and 405 for `teachers` has demonstrated that the probe distinguishes
"exposed but ungranted" from "not exposed at all", rather than returning 403 for
everything. PowerSchool even names the resource it routed to, `"resource":"Log"`,
which is a stronger answer than the status code alone.

Consequences, plainly:

- Sections 3, 4, 5 and 7 of this document describe a path that exists. They are
  not wasted effort.
- `GEN` is reachable the same way, so log types can be read by table as well as
  by PowerQuery.
- Table-level exposure and field-level grant are independent gates, and this
  result closes only the first. The second is still shut, by 107 ViewOnly
  grants.

### Still open

1. **Is `LOG` populated at Westbrook, and which of the 34 `Discipline_*` columns
   are live here?** The 5.2 Data Dictionary marks nearly all of them "No longer
   used by application", while the current admin docs still list all 34 as
   configurable. Which is true at Westbrook is empirical. It matters for clause
   3 step 4: the escalation check reads whichever ones are populated. Answerable
   with a GET once `LOG` columns are granted ViewOnly, which is a smaller ask
   than the write grant and should be done first.
2. **What log types exist in this instance?** A GET or a PowerQuery over `GEN`
   where `Cat='logtype'`. Until that is known, no `LogTypeID` is legitimate. The
   probe above proves `GEN` answers.
3. **What wire format does `Entry_Time` expect?** The Data Dictionary types it
   but does not state the format the table endpoint accepts. This client sends
   `HH:MM:SS`. **Unverified.** Some PowerSchool time columns are integer seconds
   since midnight. Confirm against a real row before enabling.
4. **What does a successful insert return?** `extractDcid` reads several
   plausible response shapes and returns null for anything unrecognised. A null
   DCID is now recorded as a watermark with no DCID, which makes the next update
   abort rather than fire blind, but it is still a guess about the response shape
   and should be replaced with the observed one.

## 7. What would have to happen to enable this

In order. Steps 1 and 2 are the ones that matter; the rest is mechanics.

1. **Get a human decision that the SIS should hold app-generated behavior notes
   at all.** This is a policy question about a permanent student record, not an
   engineering one. Westbrook currently runs two behavior systems that do not
   know about each other; connecting them one way is a choice with consequences
   for what shows up in a student's file forever.
2. **Read `LOG` before writing it.** Ask for the ViewOnly grants first, answer
   the remaining questions in section 6, and run the dashboard against real log
   entries for a term. A read-only integration that shows a teacher the entries
   that already exist may be the whole answer, in which case nothing below is
   needed.
3. **Add the `LOG` write grants to `plugin.xml`.** Not applied here:
   `plugin.xml` is off limits to this piece. The snippet below is the
   independent statement of what this client needs. Test section 23
   cross-checks it against the sibling piece's proposed `plugin-v2.xml`,
   asserting that every column this client writes is `FullAccess` there, that it
   grants no *more* than the client uses (11 and 11), and that no `FullAccess`
   grant exists outside `log`. All three pass against the file currently in the
   working tree at `powerschool/plugin-v2.xml`. If the two ever drift, that test
   fails rather than a production write returning 403.
4. **Bump the plugin version, and update `INSTALLED_PLUGIN_VERSION` in
   `write-client.ts` only after the upload succeeds.** 1.0.6 to 1.1.0.
   PowerSchool rejects a re-upload at the same version. Updating the constant
   before the upload is exactly the mistake gate 2 exists to catch. Note that
   1.0.6 already does not identify a single artifact: the installed zip differs
   from the working tree by one character in the publisher contact email. Fix
   that in the same pass.
5. **Have a PowerSchool admin disable and re-enable the plugin.** New grants do
   not take effect until they do.
6. **Verify from the admin side, not from code.** Under the installed plugin,
   expand installed resources and read the Data Access Requests screen: Table
   Name, Field Name, FLS Controlled, Blacklisted, Status. That screen is the
   non-destructive way to confirm a write grant exists. Do not confirm it by
   writing.
7. **Wire a real `WatermarkStore`** (section 8). Without one, the create and
   update methods refuse to run, on purpose.
8. **Then, and only then, set the environment variables.** All three:
   `PS_WRITE_ENABLED=enable-powerschool-writes`,
   `PS_WRITE_ALLOW_PRODUCTION_HOST=yes`, and a `PS_WRITE_CEILING` sized to the
   run. Start against one student, read the row back, and read it again the next
   morning before doing a second.

Proposed `plugin.xml` addition, to be inserted immediately before the closing
`</access_request>`:

```xml
      <!-- ================================================================
           BEHAVIOR LOG WRITE. Requires FullAccess, which is the only access
           value that can carry a write. Do not add this block until
           docs/write-path.md section 7 has been worked through in order.

           Deliberately absent from this block: all 34 Discipline_* columns.
           Wildcat Hub writes behavior notes, never discipline records that
           feed state reporting. Adding one of them here is not a small
           change; it puts app-generated data into a legally reportable file.

           GEN is ViewOnly on purpose. Log types are district configuration
           and the app reads them, never writes them.
           ================================================================ -->
      <field table="LOG" field="DCID"         access="ViewOnly"/>
      <field table="LOG" field="ID"           access="ViewOnly"/>
      <field table="LOG" field="StudentID"    access="FullAccess"/>
      <field table="LOG" field="SchoolID"     access="FullAccess"/>
      <field table="LOG" field="TeacherID"    access="FullAccess"/>
      <field table="LOG" field="Entry_Date"   access="FullAccess"/>
      <field table="LOG" field="Entry_Time"   access="FullAccess"/>
      <field table="LOG" field="Entry_Author" access="FullAccess"/>
      <field table="LOG" field="Subject"      access="FullAccess"/>
      <field table="LOG" field="Entry"        access="FullAccess"/>
      <field table="LOG" field="LogTypeID"    access="FullAccess"/>
      <field table="LOG" field="Subtype"      access="FullAccess"/>
      <field table="LOG" field="Consequence"  access="FullAccess"/>

      <field table="GEN" field="ID"        access="ViewOnly"/>
      <field table="GEN" field="Name"      access="ViewOnly"/>
      <field table="GEN" field="Cat"       access="ViewOnly"/>
      <field table="GEN" field="SchoolID"  access="ViewOnly"/>
      <field table="GEN" field="SortOrder" access="ViewOnly"/>
      <field table="GEN" field="Value"     access="ViewOnly"/>
```

`DCID` and `ID` are `ViewOnly`: the server assigns them, and the update path
needs to read the DCID back to address the row.

`GEN.Value` is on that list because `resolveSubtype` and `resolveConsequence`
prefer it over `Name` when deciding the string a menu column stores. Without it
they fall back to `Name`, which may or may not be what `LOG.Subtype` actually
holds at Westbrook. That is the UNVERIFIED item in section 5 point 1b, and the
grant is the cheap half of answering it: `GEN` is already proven reachable over
`/ws/schema/table` (section 6), so a `ViewOnly` grant on these five columns
settles both the log type ids and the menu vocabulary without any write grant at
all. Ask for the `GEN` block first and on its own.

## 8. Proposed watermark storage for the Convex caller (NOT APPLIED)

`FileWatermarkStore` is real, runnable and tested, and it is the right store for
a script driving this client directly. A Convex action needs a table instead.
The diff below is **proposed, not applied**: `convex/schema.ts` is shared and off
limits to this piece.

Insert after the `psRestricted` table definition in `convex/schema.ts`:

```diff
   }).index("by_studentNumber", ["studentNumber"]),
 
+  /**
+   * Clause 3 of docs/write-path.md, made durable.
+   *
+   * One row per behavior entry the app has written to PowerSchool. The
+   * fingerprint is what the app last sent; an update is permitted only when a
+   * fresh read-back of the SIS row still fingerprints identically. Without
+   * this table the conflict rule degrades to an unconditional overwrite of a
+   * teacher's edit, which is why the write client refuses to run without a
+   * store rather than continuing without one.
+   *
+   * logDcid is optional on purpose: null records a row that was written and
+   * whose id never came back, which a human has to resolve. Dropping that
+   * record would make the app believe it never wrote and duplicate the entry.
+   *
+   * Carries no points, no balance and no student name. It is a hash and an id.
+   */
+  psWriteWatermarks: defineTable({
+    appEntryId: v.string(),
+    logDcid: v.optional(v.string()),
+    fingerprint: v.string(),
+    columns: v.any(),      // the exact column map last sent
+    author: v.string(),
+    writtenAtIso: v.string(),
+  })
+    .index("by_appEntryId", ["appEntryId"])
+    .index("by_logDcid", ["logDcid"]),
+
   schedules: defineTable({
```

The store implementation on top of it is about fifteen lines and belongs with
the Convex action that calls the write client, which does not exist yet:

```ts
const convexStore: WatermarkStore = {
  async get(appEntryId) {
    return await ctx.runQuery(api.psWrite.watermarkByAppEntryId, { appEntryId });
  },
  async put(watermark) {
    await ctx.runMutation(api.psWrite.upsertWatermark, watermark);
  },
  async all() {
    return await ctx.runQuery(api.psWrite.allWatermarks, {});
  },
};
```

## 9. Running the tests

```
cd powerschool/sync
node src/write-client.test.mjs      # 403 assertions, exits 1 on any failure
node src/write-client.ts --explain  # grant proof and rendered requests
```

Both are offline. The test suite uses an injected fake fetch and a `node:http`
server bound to `127.0.0.1`; the explain command reads `plugin.xml` from disk and
opens no socket. Neither needs a credential, and neither can reach
`lapf.powerschool.com`.

`--probe-log` is the one command here that does touch the instance. It is a GET,
it reads at most one row, it goes through the read harness's read-only
chokepoint, and it needs a credential.

What the suite covers, in the order a reviewer should care:

| Section | Claim |
|---|---|
| 1, 2 | The real plugin grant blocks every write, and the parser cannot be fooled by a commented-out or misplaced `<field>` |
| 3, 4 | Disarmed by default. Ten arming states are tried, including `1`, `true`, `yes` and a one-character near miss; only the exact literal works. A disarmed client is handed a fetch that throws if called, and it never calls it |
| 5, 6 | Armed but ungranted still refuses. **Gate 3 fires**: `send()` throws `ProductionHostBlocked` against a production target, and outranks arming. Opening `PS_WRITE_ALLOW_PRODUCTION_HOST` removes the host block and nothing else, so environment variables alone never open the path |
| 7, 8 | DELETE, PATCH, six forbidden tables, an off-base URL and every `Discipline_*` column are all refused |
| 9 | The earned-value lint, tested in both directions and labelled as lint |
| 10, 11, 12, 13 | Log type provenance, column caps, marker forgery, school-local dates |
| 14, 15, 16 | The conflict rule, every branch: write, noop, conflict on edit, conflict on discipline promotion, conflict on wrong provenance, abort on delete, abort on stale read, abort on future read, abort on tampered watermark, abort on a projected read, and create idempotency |
| 17 | Retraction is an edit, never a delete |
| 18 | Wire format against a real local HTTP server: verbs, paths, headers, body envelope, token reuse, and that a conflict reaches no socket |
| 19, 20, 21, 22 | 405 handling; the request ceiling, including that two attempts whose fetch threw still exhaust it; the loopback hatch; and that no secret is ever rendered or logged |
| 23 | Cross-check against the sibling piece's proposed `plugin-v2.xml`, found in either location it has occupied, skipped rather than failed if absent |
| 24 | **Regression for the gate 2 bypass.** The reviewer's exact attack, plus a decoy file named `plugin.xml` at another path, plus an in-memory open grant, plus the version pin, all against `lapf.powerschool.com` with every environment gate open. Zero sockets |
| 25 | The watermark is stored, not assumed: it survives a new store over the same file, the client persists it itself, an update reads it back by `appEntryId`, an unknown id aborts, and a create whose DCID never came back records an unaddressable row that the next update refuses to guess at |
| 26 | **Regression for the origin bypass.** Nine prefix-sharing targets on a loopback-bound client with every environment gate open, four more on a production-bound client, the path pin, and a positive control that the honest loopback request still passes. Also asserts that gates 2 and 3 ran against the wire URL rather than the base, which is the half of the defect a URL-shape test alone would miss. Zero sockets |
| 26b | What preflight judges is what the wire carries: a body writing another table, a `Discipline_*` column added after rendering, an undeclared column, a declared column missing from the body, a URL naming a different table, six malformed bodies, and two time-of-check/time-of-use getters that flip to production after the gates have looked |
| 26c | A `302` on a mutating request is refused, not followed, with a control proving default `fetch` does follow it and an assertion that the decoy server received nothing |
| 27 | `Subtype` and `Consequence` resolved from GEN by name: free strings and bare numbers refused, wrong category refused, ambiguity refused, another school's row refused, stale reads refused, and a subtype resolved under one log type refused on an entry filed under another |
