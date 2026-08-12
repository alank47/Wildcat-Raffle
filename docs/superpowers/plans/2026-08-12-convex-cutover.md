# Convex Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the Wildcat Hub app's student, teacher and settings storage from a single Firestore document to Convex, so the SIS roster the app already syncs actually appears in the UI.

**Architecture:** The app keeps its in-memory shape exactly. Only the transport changes. `loadData()` and `saveData()` in `script.js` are the sole network surface for app data, so two new Convex functions (`appData:load`, `appData:save`) replace one Firestore read and one Firestore transaction. The cutover is staged: read first, then dual write, then Firestore is dropped. Every stage is independently revertible by flipping one constant.

**Tech Stack:** Convex (queries, mutations, HTTP API via plain `fetch`), vanilla JS in `script.js`, Node's built-in test runner via hand-rolled `check()` assertions in `*.test.mjs`.

## Global Constraints

- **Wildcat Cash is 6,616,500 and must be exactly that at every checkpoint.** Verified with `npm run drift`. If a step changes it, stop and revert.
- **Earned value is an allowlist, never a denylist.** The 13 fields in `convex/sisMerge.ts` `EARNED_FIELDS` are the definition. Never widen it to make a test pass.
- **A stale browser tab must not be able to blank a field it does not know about.** This already wiped 38 staff emails once. The save path merges per field, never whole-document replace.
- **No em dashes** in any file, comment, doc, or commit message.
- **The repo is PUBLIC.** Client IDs may ship. Client secrets and deploy keys may never enter a file.
- **Bump BOTH `?v=` strings in `index.html`** after touching `script.js`. A stale tab silently runs old code.
- **No `git push` to main without the full suite green:** `npm test` plus `node powerschool/sync/src/expansion-probe.ts --selftest`.
- **Never run `npx convex codegen` or `npx convex dev`** casually; `convex deploy` targets production on this project. Use `npx convex run` for verification.

## Current State, measured 2026-08-12

| Store | Students | Read by |
|---|---:|---|
| Firestore `raffle_data/main` | 446 | the app UI |
| Convex `students` | 734 | auth, SIS sync, teacher/student views |
| SIS roster (current term) | 646 enrolled | source of truth |

Convex is a **superset**: it holds the 446 legacy students with their balances plus the SIS additions. `wildcatCashBalance` reconciles at 6,616,500 on both sides today, so the cutover does not move money, it changes which store the UI reads.

734 minus 646 is 88 students who are in Convex but not on the current roster. They are prior year students and are retained deliberately (`archivedAt`), because a transferred student still has a balance.

## File Structure

| File | Responsibility |
|---|---|
| `convex/appData.ts` | **New.** The only two functions the app calls: `load` (query) and `save` (mutation). Owns the Firestore-document-shaped read model and the merge rules for writes. |
| `convex/appDataShape.ts` | **New.** Pure functions with no `ctx`: converting a Convex student row to the app's shape and back, and the per-field merge rule. Split out so it is testable without a database, the same reason `identityRules.ts` is split from `identity.ts`. |
| `convex/appDataShape.test.mjs` | **New.** Tests for the pure conversion and merge functions, including the stale-tab case. |
| `convex/schema.ts` | Modify. Add an `appSettings` singleton table for the 20 non entity fields. |
| `script.js` | Modify in three places only: `initFirebase()` (line 26), `loadData()` (line 1850), `saveData()` (line 2758). |
| `index.html` | Modify. Cache buster only. |
| `docs/convex-cutover.md` | **New.** Runbook: how to verify each stage, and how to revert. |

---

### Task 1: The pure shape and merge rules

No database, no network. This is where the anti-clobber rule lives, and it is the one piece that must be right before anything touches the app.

**Files:**
- Create: `convex/appDataShape.ts`
- Test: `convex/appDataShape.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `toAppStudent(row: Doc<"students">): AppStudent` where `AppStudent` has `id: string` (the app's key, from `legacyId` or `studentNumber`), `name: string`, `grade`, `school`, and all 13 earned fields.
  - `mergeIncomingStudent(existing, incoming): Partial<Doc<"students">>` returning ONLY the fields that changed.
  - `EARNED_FIELDS` re-exported from `sisMerge.ts`, not redefined.

- [ ] **Step 1: Write the failing test**

```javascript
// convex/appDataShape.test.mjs
import { toAppStudent, mergeIncomingStudent } from "./appDataShape.ts";

let pass = 0, fail = 0;
function check(label, ok, detail = "") {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? `  (${detail})` : ""}`); }
}

console.log("\nConvex row to app shape");
{
  const row = {
    legacyId: "s-123", studentNumber: "11095", firstName: "Ada", lastName: "Lovelace",
    grade: "11", pbisTickets: 3, attendanceTickets: 0, academicTickets: 1,
    bigRaffleQualified: [1, 2], wildcatCashBalance: 15000, cashBalance: 15000,
  };
  const app = toAppStudent(row);
  check("id prefers legacyId", app.id === "s-123");
  check("name is joined", app.name === "Ada Lovelace");
  check("earned value survives", app.wildcatCashBalance === 15000);
  check("week numbers stay numbers", app.bigRaffleQualified[0] === 1);
}
{
  const app = toAppStudent({ studentNumber: "12036", firstName: "New", lastName: "Student",
    pbisTickets: 0, attendanceTickets: 0, academicTickets: 0, bigRaffleQualified: [] });
  check("a SIS student with no legacyId falls back to studentNumber", app.id === "12036");
}

console.log("\nThe stale tab rule");
{
  // A tab loaded before the SIS sync filled in email must not blank it.
  const existing = { firstName: "Ada", lastName: "Lovelace", email: "al11095@westbrookacademy.org", pbisTickets: 3 };
  const incoming = { firstName: "Ada", lastName: "Lovelace", email: "", pbisTickets: 4 };
  const patch = mergeIncomingStudent(existing, incoming);
  check("a blank incoming value never overwrites a present one", !("email" in patch), JSON.stringify(patch));
  check("a real change still applies", patch.pbisTickets === 4);
  check("unchanged fields are not in the patch", !("firstName" in patch));
}
{
  const existing = { firstName: "Ada", lastName: "Lovelace", email: "old@westbrookacademy.org", pbisTickets: 0 };
  const incoming = { firstName: "Ada", lastName: "Lovelace", email: "new@westbrookacademy.org", pbisTickets: 0 };
  const patch = mergeIncomingStudent(existing, incoming);
  check("a non blank change to a present field DOES apply", patch.email === "new@westbrookacademy.org");
}
{
  const existing = { firstName: "A", lastName: "B", pbisTickets: 5, wildcatCashBalance: 15000 };
  const incoming = { firstName: "A", lastName: "B", pbisTickets: 5, wildcatCashBalance: 0 };
  const patch = mergeIncomingStudent(existing, incoming);
  check("a balance CAN be set to zero deliberately", patch.wildcatCashBalance === 0,
    "zero is a real balance; only undefined and empty string are 'absent'");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node convex/appDataShape.test.mjs`
Expected: FAIL, "Cannot find module './appDataShape.ts'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// convex/appDataShape.ts
import { EARNED_FIELDS } from "./sisMerge.ts";
export { EARNED_FIELDS };

/**
 * A value that means "I do not know about this field" rather than "set it to
 * empty". undefined and "" are absence. ZERO IS NOT: a balance of 0 is a real
 * balance a child can have, and treating it as absence would make a spent-down
 * account un-zeroable.
 */
function isAbsent(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

export type AppStudent = Record<string, unknown> & { id: string; name: string };

export function toAppStudent(row: Record<string, any>): AppStudent {
  return {
    id: String(row.legacyId ?? row.studentNumber ?? ""),
    studentNumber: row.studentNumber,
    name: `${row.firstName ?? ""} ${row.lastName ?? ""}`.trim(),
    firstName: row.firstName,
    lastName: row.lastName,
    grade: row.grade,
    school: row.school,
    email: row.email,
    pbisTickets: row.pbisTickets ?? 0,
    attendanceTickets: row.attendanceTickets ?? 0,
    academicTickets: row.academicTickets ?? 0,
    bigRaffleQualified: row.bigRaffleQualified ?? [],
    weeksQualified: row.weeksQualified,
    wildcatCashBalance: row.wildcatCashBalance,
    wildcatCashEarned: row.wildcatCashEarned,
    wildcatCashSpent: row.wildcatCashSpent,
    wildcatCashDeducted: row.wildcatCashDeducted,
    wildcatCashRewardsRedeemed: row.wildcatCashRewardsRedeemed,
    wildcatCashTransactions: row.wildcatCashTransactions,
    cashBalance: row.cashBalance,
    cashTransactions: row.cashTransactions,
    archivedAt: row.archivedAt,
  };
}

/**
 * Returns ONLY changed fields, and refuses to blank a field the caller does
 * not know about.
 *
 * This is the rule that a whole-document write does not have, and its absence
 * is what let one stale tab wipe 38 staff emails: the tab sent email:"" for
 * every record because it had loaded before the backfill, and a replace
 * faithfully stored the blank.
 */
export function mergeIncomingStudent(
  existing: Record<string, any>,
  incoming: Record<string, any>,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (isAbsent(value) && !isAbsent(existing[key])) continue; // never blank a known value
    if (JSON.stringify(existing[key]) === JSON.stringify(value)) continue; // unchanged
    patch[key] = value;
  }
  return patch;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node convex/appDataShape.test.mjs`
Expected: PASS, 8 passed 0 failed

- [ ] **Step 5: Wire it into the suite and commit**

Add `node convex/appDataShape.test.mjs &&` to the `test` script in `package.json`, before `node wildcat-auth.test.mjs`.

Run: `npm test`
Expected: the new suite appears, total rises, 0 failed.

```bash
git add convex/appDataShape.ts convex/appDataShape.test.mjs package.json
git commit -m "Add the app data shape and the rule that a stale tab cannot blank a field"
```

---

### Task 2: `appData:load`

**Files:**
- Create: `convex/appData.ts`
- Modify: `convex/schema.ts` (add `appSettings`)

**Interfaces:**
- Consumes: `toAppStudent` from Task 1.
- Produces: `api.appData.load` returning `{ students: AppStudent[], teachers: AppTeacher[], settings: Record<string, unknown>, serverTime: string }`.

- [ ] **Step 1: Add the settings table**

In `convex/schema.ts`, alongside the existing tables:

```typescript
  // The 20 non entity fields that used to ride along in the Firestore
  // document: currentWeek, cycleDuration, pbisSubcategories, and so on. One
  // row, keyed by a constant, because they are a singleton and modelling them
  // as a table of one is cheaper than twenty separate appState keys.
  appSettings: defineTable({
    key: v.string(), // always "main"
    value: v.any(),
    updatedAt: v.string(),
  }).index("by_key", ["key"]),
```

- [ ] **Step 2: Write the load query**

```typescript
// convex/appData.ts
import { query } from "./_generated/server";
import { ConvexError } from "convex/values";
import { toAppStudent } from "./appDataShape";
import { requireStaff } from "./identity";

/**
 * Everything the app used to read from raffle_data/main, in the same shape.
 *
 * Staff only. The browser never touches a table; it calls this. The 88 students
 * who are archived (no longer on the SIS roster) are RETURNED, because a
 * transferred student still has a balance and hiding them would make that
 * balance unreachable. The app decides what to display.
 */
export const load = query({
  args: {},
  handler: async (ctx) => {
    await requireStaff(ctx);

    const [studentRows, teacherRows, settingsRow] = await Promise.all([
      ctx.db.query("students").collect(),
      ctx.db.query("teachers").collect(),
      ctx.db.query("appSettings").withIndex("by_key", (q) => q.eq("key", "main")).unique(),
    ]);

    return {
      students: studentRows.map(toAppStudent),
      teachers: teacherRows.map((t) => ({
        id: String(t.legacyId ?? t._id),
        name: t.name,
        email: t.email,
        username: t.username,
        role: t.role,
        ticketsAwarded: t.ticketsAwarded ?? 0,
      })),
      settings: (settingsRow?.value as Record<string, unknown>) ?? {},
      serverTime: new Date().toISOString(),
    };
  },
});
```

- [ ] **Step 3: Deploy and verify against real data**

```bash
export CONVEX_DEPLOY_KEY=$(env -u OP_SERVICE_ACCOUNT_TOKEN op read 'op://Employee/Westbrook WildCats Hub/Convex wildcat-hub-ci Deploy Key')
npx convex deploy
npx convex run appData:load '{}' | head -40
```

Expected: a refusal, because `npx convex run` is unauthenticated and `requireStaff` throws. That is the correct result and proves the gate. To see data, temporarily comment the `requireStaff` line, re-run, confirm 734 students, then UNCOMMENT IT before committing.

- [ ] **Step 4: Confirm the count and the money**

Run: `npx convex run migrate:studentTotals '{}'`
Expected: `count: 734`, `wildcatCashBalance: 6616500`. Unchanged by this task, which adds no writes.

- [ ] **Step 5: Commit**

```bash
git add convex/appData.ts convex/schema.ts
git commit -m "Add appData:load, the read side of the Convex cutover"
```

---

### Task 3: `appData:save`

**Files:**
- Modify: `convex/appData.ts`
- Modify: `convex/appDataShape.test.mjs` (add merge cases exercised by the mutation)

**Interfaces:**
- Consumes: `mergeIncomingStudent` from Task 1.
- Produces: `api.appData.save` taking `{ students?, teachers?, settings? }` and returning `{ studentsChanged: number, teachersChanged: number, settingsChanged: boolean }`.

- [ ] **Step 1: Write the mutation**

```typescript
import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { mergeIncomingStudent } from "./appDataShape";

/**
 * The write side. Transactional by construction: Convex runs the whole handler
 * atomically, which is what the Firestore runTransaction was hand-rolling.
 *
 * PER FIELD, NOT PER DOCUMENT. The Firestore version replaced the entire
 * document, so a tab that had loaded stale data wrote its stale view over
 * everything, and that is exactly how 38 staff emails were lost. Here every
 * student is merged field by field and a blank never overwrites a known value.
 */
export const save = mutation({
  args: {
    students: v.optional(v.array(v.any())),
    teachers: v.optional(v.array(v.any())),
    settings: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    await requireStaff(ctx);
    let studentsChanged = 0;

    if (args.students) {
      const existing = await ctx.db.query("students").collect();
      const byKey = new Map<string, (typeof existing)[number]>();
      for (const row of existing) {
        if (row.legacyId) byKey.set(row.legacyId, row);
        if (row.studentNumber) byKey.set(row.studentNumber, row);
      }
      for (const incoming of args.students) {
        const key = String(incoming.id ?? incoming.studentNumber ?? "");
        const row = byKey.get(key);
        if (!row) continue; // never CREATE from the browser; the SIS owns the roster
        const patch = mergeIncomingStudent(row, {
          pbisTickets: incoming.pbisTickets,
          attendanceTickets: incoming.attendanceTickets,
          academicTickets: incoming.academicTickets,
          bigRaffleQualified: incoming.bigRaffleQualified,
          weeksQualified: incoming.weeksQualified,
          wildcatCashBalance: incoming.wildcatCashBalance,
          wildcatCashEarned: incoming.wildcatCashEarned,
          wildcatCashSpent: incoming.wildcatCashSpent,
          wildcatCashDeducted: incoming.wildcatCashDeducted,
          wildcatCashRewardsRedeemed: incoming.wildcatCashRewardsRedeemed,
          wildcatCashTransactions: incoming.wildcatCashTransactions,
          cashBalance: incoming.cashBalance,
          cashTransactions: incoming.cashTransactions,
        });
        if (Object.keys(patch).length > 0) {
          await ctx.db.patch(row._id, patch);
          studentsChanged++;
        }
      }
    }

    let teachersChanged = 0;
    if (args.teachers) {
      const existing = await ctx.db.query("teachers").collect();
      const byId = new Map(existing.map((t) => [String(t.legacyId ?? t._id), t]));
      for (const incoming of args.teachers) {
        const row = byId.get(String(incoming.id ?? ""));
        if (!row) continue;
        const patch = mergeIncomingStudent(row, {
          name: incoming.name,
          email: incoming.email,
          username: incoming.username,
          role: incoming.role,
          ticketsAwarded: incoming.ticketsAwarded,
        });
        if (Object.keys(patch).length > 0) {
          await ctx.db.patch(row._id, patch);
          teachersChanged++;
        }
      }
    }

    let settingsChanged = false;
    if (args.settings !== undefined) {
      const row = await ctx.db
        .query("appSettings")
        .withIndex("by_key", (q) => q.eq("key", "main"))
        .unique();
      const updatedAt = new Date().toISOString();
      if (row) await ctx.db.patch(row._id, { value: args.settings, updatedAt });
      else await ctx.db.insert("appSettings", { key: "main", value: args.settings, updatedAt });
      settingsChanged = true;
    }

    return { studentsChanged, teachersChanged, settingsChanged };
  },
});
```

- [ ] **Step 2: Deploy and prove the guard with a real hostile payload**

```bash
npx convex deploy
npx convex run migrate:studentTotals '{}'   # record the BEFORE numbers
```

Temporarily comment `requireStaff` in `save` only, then:

```bash
# a stale tab: sends blanks for fields it never loaded
npx convex run appData:save '{"students":[{"id":"<a real legacyId>","email":"","wildcatCashBalance":null}]}'
npx convex run migrate:studentTotals '{}'
```

Expected: `studentsChanged: 0`, and `wildcatCashBalance` still 6616500. Restore `requireStaff` immediately.

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: 0 failed.

- [ ] **Step 4: Commit**

```bash
git add convex/appData.ts convex/appDataShape.test.mjs
git commit -m "Add appData:save, merging per field so a stale tab cannot blank a value"
```

---

### Task 4: Read from Convex in the app

The first stage the user can see. Writes still go to Firestore, so this is revertible by flipping one constant.

**Files:**
- Modify: `script.js` around `loadData()` line 1850
- Modify: `index.html` cache busters

**Interfaces:**
- Consumes: `api.appData.load`.
- Produces: nothing new. `students` and `teachers` are filled exactly as before.

- [ ] **Step 1: Add the source flag and the Convex reader**

Near the top of `script.js`, beside the existing config:

```javascript
        // Which store the app READS app data from. Writes are controlled
        // separately by DATA_WRITE below, so the two can be moved one at a
        // time and either can be reverted without touching the other.
        const DATA_SOURCE = 'convex';   // 'convex' | 'firestore'
        const DATA_WRITE  = 'firestore'; // 'both' | 'convex' | 'firestore'

        async function loadFromConvex() {
            // convexQuery/convexMutation, NOT callConvex. Verified against
            // wildcat-auth.js:94 and :123. Both take (path, args, idToken) and
            // the token comes from the live session, so an expired session
            // fails loudly here rather than returning an empty roster.
            const session = window.WildcatAuth.getSession();
            if (!session) throw new Error('Not signed in.');
            const result = await window.WildcatAuth.convexQuery(
                'appData:load', {}, session.idToken,
            );
            return {
                students: result.students || [],
                teachers: result.teachers || [],
                ...(result.settings || {}),
            };
        }
```

- [ ] **Step 2: Branch inside loadData()**

At the point in `loadData()` where the Firestore document is fetched, add ahead of it:

```javascript
                if (DATA_SOURCE === 'convex') {
                    try {
                        const mainData = await loadFromConvex();
                        applyLoadedData(mainData);   // the existing code path, unchanged
                        return;
                    } catch (err) {
                        console.error('[data] Convex load failed, falling back to Firestore:', err.message);
                        // fall through deliberately: a failed cutover must not
                        // leave a teacher staring at an empty roster.
                    }
                }
```

- [ ] **Step 3: Bump the cache busters**

In `index.html`, change both `?v=` strings on `wildcat-auth.js` and `script.js` to today's date plus a letter, for example `?v=20260812c`.

- [ ] **Step 4: Verify in a browser**

Open the site, sign in as staff, and confirm the roster shows **646** students rather than 446. Check the browser console for `[data] Convex load failed`, which means it silently fell back.

- [ ] **Step 5: Commit**

```bash
git add script.js index.html
git commit -m "Read app data from Convex, with a Firestore fallback"
```

---

### Task 5: Write to Convex, then drop Firestore

**Files:**
- Modify: `script.js` around `saveData()` line 2758
- Create: `docs/convex-cutover.md`

- [ ] **Step 1: Dual write**

Set `DATA_WRITE = 'both'`. In `saveData()`, after the existing Firestore transaction completes successfully, add:

```javascript
                if (DATA_WRITE === 'both' || DATA_WRITE === 'convex') {
                    try {
                        const session = window.WildcatAuth.getSession();
                        if (!session) throw new Error('Not signed in.');
                        await window.WildcatAuth.convexMutation('appData:save', {
                            students: studentsToSave,
                            teachers: teachersToSave,
                            settings: { currentWeek, cycleDuration, pbisSubcategories,
                                academicSubcategories, kickboardSettings, emailJSConfig,
                                passSettings, schoolBranding, referralIdCounter,
                                autoWeekEnabled, lastAutoResetDate, lastWeekResetTime,
                                weekResetDay, weekResetHour, currentCycle, cycleHistory,
                                cycleStartTimestamp, lastPowerSchoolSync },
                        }, session.idToken);
                    } catch (err) {
                        console.error('[data] Convex save failed:', err.message);
                    }
                }
```

- [ ] **Step 2: Award one ticket in the UI and verify both stores agree**

```bash
npm run drift
```

Expected: student totals move by the same amount on both sides. `wildcatCashBalance` differs by exactly the award, or is unchanged if a ticket was awarded rather than cash.

- [ ] **Step 3: Run for one full day, then cut the Firestore write**

Set `DATA_WRITE = 'convex'` and remove the Firestore `runTransaction` block. Leave `initFirebase()` in place for one more deploy so a revert is a one line change.

- [ ] **Step 4: Deploy the Firestore rules**

The rules in `firestore.rules` have never been deployed and the database is world readable and world writable. Once nothing reads it, deploy them.

```bash
npx firebase deploy --only firestore:rules
```

- [ ] **Step 5: Write the runbook and commit**

`docs/convex-cutover.md` must cover: what each stage did, the two constants and their meanings, how to revert each stage, and how to confirm the money is intact.

```bash
git add script.js docs/convex-cutover.md firestore.rules
git commit -m "Write app data to Convex and retire the Firestore document"
```

---

## Self-Review

**Spec coverage:** Read path (Tasks 2, 4), write path (Tasks 3, 5), settings (Tasks 2, 3), the stale tab hazard (Task 1, with the test that reproduces the 38 email wipe), balance preservation (checkpoints in Tasks 2, 3, 5), Firestore decommission (Task 5). The 88 archived students are explicitly returned rather than silently dropped.

**Placeholder scan:** No TBDs. Every code step carries real code. The one deliberate blank is `<a real legacyId>` in Task 3 Step 2, which cannot be filled in advance because it is per environment; the surrounding text says where to get it.

**Type consistency:** `toAppStudent` and `mergeIncomingStudent` are named identically in Tasks 1, 2 and 3. `AppStudent.id` is a string everywhere. `DATA_SOURCE` and `DATA_WRITE` keep the same names and values in Tasks 4 and 5.

**Both assumed dependencies were verified before this plan was saved, not assumed:**

- `requireStaff` exists at `convex/identity.ts:48`, takes `QueryCtx | MutationCtx`, and throws `ConvexError` for a non staff token or a staff address with no teacher record. Tasks 2 and 3 use it as written.
- `callConvex` does **NOT** exist. The real helpers are `convexQuery` (`wildcat-auth.js:94`) and `convexMutation` (`:123`), both `(path, args, idToken)`. Tasks 4 and 5 were corrected to use them. This is exactly the kind of name drift the self-review is for, and it would have failed at runtime in a browser rather than at build time.

**One risk this plan does not remove:** `requireStaff` refuses a staff member with no `teachers` row. After the cutover, that refusal blocks the whole app rather than one endpoint. Task 4's fallback to Firestore covers it for one deploy; before Task 5 removes that fallback, confirm all 40 staff have a `teachers` row with a matching Entra email (`npx convex run seed:staffAuthReadiness '{}'`).
