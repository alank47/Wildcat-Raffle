import { internalQuery } from "./_generated/server";
import { v } from "convex/values";

/**
 * WHO IS THIS PERSON, AND DO THEY HAVE AN ACCOUNT?
 *
 * A keeper rather than a probe, which is why it lives here and not in
 * legacyPurge.ts with the one-shot measurements.
 *
 * THE QUESTION IT ANSWERS came up four times in a week -- Claudia Lopez, Leo
 * Contreras, Paola Tapia, Ariana Nieves -- and every time the honest answer
 * needed THREE places checked, because "has an account" is three different
 * facts that get confused with each other:
 *
 *   teachers        a Wildcat Hub staff account. Missing here is why somebody
 *                   signs in and sees nothing.
 *   students        a student record. The table holds stale rows -- 757 for a
 *                   school of 618 -- so having a record and being enrolled are
 *                   different questions, and this checks psRoster for the
 *                   second one.
 *   entraDirectory  a Microsoft account at the school. Somebody can be real,
 *                   employed, and signing in successfully, and simply never
 *                   have been added to this app. This is also where their
 *                   official address lives, which beats guessing a spelling --
 *                   Ariana Nieves turned out to be arianan@, which is not what
 *                   anyone would have guessed first.
 *
 * NARROW ON PURPOSE. The pre-existing seed:listStaffForMatching returns every
 * colleague's name and role, which is a lot of other people's records to pull
 * onto a terminal to answer a question about one person. This returns only the
 * matches.
 *
 * Run it:
 *
 *   npx convex run staffLookup:findAccount '{"q":"nieves"}' --prod
 *
 * Search on a SURNAME first. A first name matches several people and a surname
 * usually does not; a zero-result surname with a first-name hit is the shape
 * that means "this person is not here under the name you were given".
 *
 * internalQuery, so it needs the deploy key and no browser can reach it. That
 * is deliberate: it reads across staff, students and the staff directory at
 * once, which is a combination no screen in the app has any business making.
 */
/** One person, across all three places an account can live. */
export const findAccount = internalQuery({
  args: { q: v.string() },
  handler: async (ctx, { q }) => {
    const needle = String(q ?? "").trim().toLowerCase();
    if (needle.length < 3) return { error: "Give at least three characters." };

    const staff = await ctx.db.query("teachers").collect();
    const staffHits = (staff as any[])
      .filter((t) => String(t.name ?? "").toLowerCase().includes(needle))
      .map((t) => ({
        kind: "staff",
        name: t.name,
        role: t.role ?? "(none)",
        email: t.email ?? null,
        canSignIn: Boolean(String(t.email ?? "").includes("@")),
        archived: t.archived === true,
        legacyId: t.legacyId ?? null,
      }));

    const students = await ctx.db.query("students").collect();
    const studentHits = (students as any[])
      .filter((s) => {
        const full = `${s.firstName ?? ""} ${s.lastName ?? ""}`.toLowerCase();
        const rev = `${s.lastName ?? ""}, ${s.firstName ?? ""}`.toLowerCase();
        return full.includes(needle) || rev.includes(needle);
      })
      .map((s) => ({
        kind: "student",
        name: `${s.firstName ?? ""} ${s.lastName ?? ""}`.trim(),
        grade: s.grade ?? null,
        studentNumber: s.studentNumber ?? null,
        email: s.email ?? null,
        canSignIn: Boolean(String(s.email ?? "").includes("@")),
        archived: s.archived === true,
      }));

    // Is the student actually still enrolled? The students table holds stale
    // rows -- 757 for a school of 618 -- so "has a record" and "is here" are
    // different questions.
    const enrolled: Record<string, boolean> = {};
    for (const h of studentHits) {
      const n = String(h.studentNumber ?? "").trim();
      if (!n) continue;
      const rows = await ctx.db.query("psRoster")
        .withIndex("by_studentNumber", (qq) => qq.eq("studentNumber", n)).take(1);
      enrolled[n] = rows.length > 0;
    }

    // THE DIRECTORY IS THE THIRD PLACE TO LOOK, and for a colleague it is the
    // first that matters: a person can be real, have a working Microsoft
    // account, and simply never have been added to this app. Their official
    // address lives here, which is better than guessing at a spelling.
    const dir = await ctx.db.query("entraDirectory").collect();
    const dirHits = (dir as any[])
      .filter((d) => String(d.searchText ?? "").includes(needle))
      .map((d) => ({
        name: d.name,
        email: d.email,
        jobTitle: d.jobTitle ?? null,
        department: d.department ?? null,
        // Already in the app, or in the directory only?
        inHub: (staff as any[]).some(
          (t) => String(t.email ?? "").toLowerCase() === String(d.email ?? "").toLowerCase()),
      }));

    return {
      query: needle,
      staffMatches: staffHits.length,
      studentMatches: studentHits.length,
      directoryMatches: dirHits.length,
      directory: dirHits,
      staff: staffHits,
      students: studentHits.map((h) => ({
        ...h,
        inPowerSchoolNow: h.studentNumber ? enrolled[String(h.studentNumber)] === true : false,
      })),
    };
  },
});
