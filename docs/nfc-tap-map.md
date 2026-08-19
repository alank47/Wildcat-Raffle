# NFC tap map

How a student tapping a phone on a wall becomes a record, and what that record
is honestly worth.

---

## The one physical fact everything follows from

**A tag holds a URL. Nothing else.**

```
NFC tag on the wall  ->  https://wildcatraffle.com/tap/?tap=restroom-2
```

iOS 14+ reads tags in the background and opens that link with no app installed.
Android Chrome does the same. This is why the design is a URL and not an app
payload: the Web NFC API (`NDEFReader`) exists only in Chrome on Android, and
depending on it would exclude every iPhone.

So a tap is a **web request to a known URL, from a signed-in browser**. Every
capability and every limit below comes from that sentence.

## What a tap proves, and what it does not

| Claim | True? |
|---|---|
| Somebody opened this URL | Yes |
| At this time | Yes |
| While signed in as this student | Yes, if the session is live |
| **A body was physically in that room** | **No** |

The URL is static and printed on a wall. It can be photographed, bookmarked,
texted to a friend, or typed. **A tap is a deterrent and a paper trail, not
proof of presence.** Anyone told otherwise will be embarrassed by the first
student who works it out.

What closes most of the gap, all in software, all partial:

- a tap only counts against an **approved, open** pass
- **destination must be tapped before origin**, so the classroom tag cannot be
  tapped on the way out to close a trip that never happened
- every tap is attributed to the signed-in student and **visible to the teacher**
- **refused taps are recorded too**, so a student probing the system leaves a
  trail rather than nothing

Real proof of presence needs rotating or powered tags, which is a hardware
budget decision nobody has made.

---

## The map

### Locations

One row per physical tag. `slug` is what is encoded on the tag and printed on
its label, so it is human chosen and stable: changing it means re-encoding the
sticker on the wall.

| Field | Meaning |
|---|---|
| `slug` | `restroom-2`, `room-12`, `office`, `nurse` |
| `name` | "Restroom, 2nd floor" |
| `kind` | classroom / restroom / office / nurse / other |
| `active` | a peeled-off or retired tag stops working without deleting its history |

### The flow, end to end

```
  STUDENT                TEACHER               TAG                 STATE
  -------                -------               ---                 -----
  taps "Hall Pass"                                                requested
  on their card
                         sees the request
                         approves      ------------------------>  active
                                                                  timer starts

  walks out, taps  ------------------->  restroom-2               out
                                                                  destination
                                                                  recorded

  comes back, taps ------------------->  room-12                  returned
                                         (origin only)            timer stops
```

**The timer starts at approval, not at the first tap.** A student approved and
still in the room is out of class as far as the record goes. But a request
nobody answered has no elapsed time at all, or every ignored request would read
as a truancy.

### Every tap outcome

| Situation | Result | Why |
|---|---|---|
| Approved pass, taps destination | **Accepted**, state `out` | The normal first leg |
| Out, taps origin | **Accepted**, state `returned` | Only the origin closes a pass |
| Active, taps origin first | **Refused** | Would close a trip that never happened |
| Out, taps a third location | **Refused**, still recorded | A real event, but it does not end the trip |
| No open pass | **Refused** | "Ask your teacher first" |
| Request not yet approved | **Refused** | Names the reason, not silence |
| Unknown or retired tag | **Refused** | A dead sticker is not a dead end |

Every one of those is written to `tapEvents`, accepted or not. **A refused tap
is the interesting one.** Recording only successes would erase exactly the
behaviour this exists to notice.

---

## Beyond hall passes

The same tap primitive covers the other check-ins with no new mechanism, only
new location kinds and a different thing to write down.

| Use | Tag | What it should record | Status |
|---|---|---|---|
| Restroom trip | `restroom-N` | Destination leg of a hall pass | **Built** |
| Classroom return | `room-N` | Closes the pass, stops the timer | **Built** |
| Office visit | `office` | Same shape as a restroom trip | Built, needs a tag |
| Nurse visit | `nurse` | Same, but health context may need narrower visibility | Needs a decision |
| Attendance / period check-in | `room-N` | A tap with NO open pass, which today is refused | **Not built** |
| Lunch line | `cafeteria` | Lunch ID scan, a different flow entirely | Not built |

**Attendance is the one that does not fit yet.** A tap with no open pass is
currently refused, which is right for hall passes and wrong for "I have arrived
in first period". That needs a second tap intent, decided by the location kind
rather than by the student, and it is a design decision rather than a code
change.

---

## What blocks all of it

**Student sign-in does not work yet.** Every tap must be attributed to a
student, and today a student cannot sign in:

- 209 of 646 enrolled students have no email address in PowerSchool
- 9 more carry a retired domain, 1 a misspelled one
- the roster read requires a live session

Until that is solved, taps cannot be attributed, and an unattributed tap is a
timestamp on a wall.

Everything above is built and tested against that assumption, so when sign-in
lands the tap surface works rather than needing rewriting.

## Practical notes for whoever mounts the tags

- **NTAG213 or better**, and a URL fits comfortably.
- **Lock the tag read-only after encoding.** An unlocked tag can be rewritten by
  any phone that touches it, including to point somewhere hostile.
- Mount at phone height, away from metal, which detunes the antenna.
- Print the slug on the label. When one stops working, the first question is
  which one it is.
- Retire with `active: false`. Never delete a location: its tap history refers
  to it, and deleting it orphans a term of records.
