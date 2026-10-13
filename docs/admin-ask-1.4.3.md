# Administrator request: Wildcat Hub Sync 1.4.3

Prepared 2026-10-13 for Lawrence and the PowerSchool administrator. Read only.
No write access anywhere in this request.

1.4.2 is installed and working. This is the **next** request, and it is not
urgent: nothing is broken without it. It lets the Reflection Room list say
which room each student is pulled from, straight from PowerSchool.

**File to install:** `powerschool/out/wildcat-hub-sync-1.4.3.zip`
(build it with `npm run build:plugin` in `powerschool/sync`).

---

## The ask

**One new read only field: `Sections.Room`.**

| | 1.4.2, installed now | 1.4.3 |
|---|---|---|
| Field lines | 164 | **165** |
| Access level | all ViewOnly | **all ViewOnly, zero FullAccess** |
| PowerQueries | unchanged | **unchanged** |
| Tables | 27 | **27** (Sections is already granted) |

### Why

The owner asked for room numbers on the daily Reflection Room list and its
pull slips, so a runner knows which door to go to: the class before lunch
for middle school, Power-Up for high school. PowerSchool already holds each
class's room. Today the Hub cannot read it, so an administrator types each
teacher's room by hand on the Teachers tab. That works because most
teachers keep one room all day, but it goes stale when a room changes, and
it is wrong for a teacher who teaches one period somewhere else. With this
field the Hub uses PowerSchool's room for each class and keeps the typed
room only as a fallback.

### What is deliberately NOT requested

- **Nothing else on `Sections`, and no other table.** One column.
- **No named query change.** The Hub reads the room from the table endpoint
  (`id` and `room`, this term's sections only), so nothing that runs today
  depends on this field. While it is not granted, PowerSchool answers 403
  and the sync carries on exactly as it does now.
- **Any write access at all.** Every one of the 165 lines is `ViewOnly`.

---

## The field was verified to exist before it was requested

`Sections.Room` answered **403** on 2026-10-13. The table endpoint tells the
two failures apart:

| Response | Meaning |
|---|---|
| `400 not a valid column for table X` | The column does not exist. |
| `403 lacks sufficient permission` | It exists. Only the grant is missing. |

A 403 means it exists, so this upload will not be rejected for an invalid
column the way 1.1.0 was.

---

## What the administrator clicks

Sign in to `lapf.powerschool.com` as an administrator.

1. **System > System Settings > Plugin Management Configuration.**
2. Find **Wildcat Hub Sync**. **Untick Enable.** The sync stops here.
3. **Install**, choose `wildcat-hub-sync-1.4.3.zip`, then **Import**.
   This is an upgrade, not a fresh install.
4. On the access request screen, confirm it reads **165 lines, all view only,
   zero full access**, and that the one new line is **SECTIONS / ROOM**.
   **If any line says full access, stop and tell us.**
5. **Approve** the access request.
6. Back on the plugin list, **tick Enable.**

Step 6 is easy to miss. Installed and enabled are separate states.

### Do not do these

- **Do not click Delete, and do not uninstall then reinstall.** The client id
  and secret survive a version upgrade. They do not survive a delete.
- **Do not click Regenerate Client ID and Secret.**

---

## When to do it

Between **19:10 and 12:50 UTC**, roughly 12:10 in the afternoon to 05:50 the
next morning in Los Angeles. The syncs run at 13:00 and 19:00 UTC. After
school is ideal: the Reflection Room list for the day is already made.

No user sees an outage. If the window overlaps a sync run, that run fails
silently, so confirm recovery as below rather than by looking at the
dashboard.

---

## Verify afterwards

1. Run a sync: **Wildcat Cash > Sync PowerSchool > Sync now**, or wait for
   the next scheduled one.
2. Read its summary:

   ```
   npx convex run --prod syncLog:latest
   ```

   Expect `sectionRooms: "granted"` and `sectionRoomsFound` near the number
   of sections this term. Before the install it says `"not-granted"`, which
   is the 403 and is expected. `"error"` means the read failed for another
   reason, named in `sectionRoomsError`; the roster is written either way.
3. The next morning's Reflection Room list shows the rooms. Hovering over a
   room says "Room from PowerSchool" where PowerSchool supplied it.

Nothing else depends on this field. If it ever has to go, a 1.4.4 without
that one line takes it away, and the Hub goes back to the rooms typed on the
Teachers tab with no change on our side.
