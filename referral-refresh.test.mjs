// Seeing a colleague's referral without reloading the page.
//
// REPORTED TWICE. "I created a referral in Jazmin's account, logged in on my
// own account on another computer, and could not see it." Then again on
// 2026-09-08 with Leo C. Both times the referral WAS on the server -- checked
// -- and both times the reader's tab never asked for it again.
//
// Referrals reach a tab once, at page load. The background auto-refresh is
// gated on AUTO_REFRESH_DELAY, five minutes of INACTIVITY, so an admin who
// opens Open Referrals, does not see it, and clicks around looking harder
// resets that timer on every click. The harder you looked, the longer it took.
//
// The dangerous fix is a refresh that REPLACES the local array: that discards
// a referral still sitting in this tab's save queue. So the merge is a union,
// and most of these assertions are about what it must never throw away.
//
// Run: npm test

import { readFileSync } from "node:fs";

const disc = readFileSync(new URL("./wildcat-discipline.js", import.meta.url), "utf8");
new Function(disc)();
const D = globalThis.WildcatDiscipline;

const script = readFileSync(new URL("./script.js", import.meta.url), "utf8");
const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}`)); };
const R = (id, updatedAt, extra) => Object.assign({ id, updatedAt, status: "open" }, extra || {});
const ids = (a) => a.map((r) => r.id);

console.log("\n-- the reported bug: a colleague's referral arrives --");
{
  const mine = [R("REF11", "2026-09-01")];
  const server = [R("REF11", "2026-09-01"), R("REF-260908-9DGPFAW", "2026-09-08T23:07")];
  const m = D.mergeReferrals(mine, server);
  check("the new referral is now in the list", ids(m.referrals).includes("REF-260908-9DGPFAW"));
  check("counted as added, so the screen can say so", m.added === 1);
  check("nothing counted as updated", m.updated === 0);
  check("changed is true", m.changed === true);
}

console.log("\n-- NOTHING LOCAL IS DISCARDED --");
{
  // The referral this teacher just filed, still in the save queue. A refresh
  // that replaced the array would destroy it mid-write.
  const mine = [R("LOCAL-1", "2026-09-08T23:30")];
  const m = D.mergeReferrals(mine, []);
  check("a referral absent from the server survives", ids(m.referrals).includes("LOCAL-1"));
  check("an empty server is not read as a deletion", m.referrals.length === 1);
  check("and nothing is reported as new", m.added === 0 && m.changed === false);

  const m2 = D.mergeReferrals(mine, [R("OTHER", "2026-09-08T23:00")]);
  check("it survives alongside an incoming one", ids(m2.referrals).sort().join() === "LOCAL-1,OTHER");
}

console.log("\n-- the later edit wins, in both directions --");
{
  const newerLocal = D.mergeReferrals([R("A", "2026-09-08T10:00")], [R("A", "2026-09-08T09:00")]);
  check("a stale server copy does not overwrite a local edit",
    newerLocal.referrals[0].updatedAt === "2026-09-08T10:00");
  check("and that is not reported as an update", newerLocal.updated === 0);

  const newerServer = D.mergeReferrals([R("A", "2026-09-08T09:00")], [R("A", "2026-09-08T10:00")]);
  check("a colleague's newer edit does land", newerServer.referrals[0].updatedAt === "2026-09-08T10:00");
  check("and is counted as updated", newerServer.updated === 1);

  const same = D.mergeReferrals([R("A", "2026-09-08T10:00")], [R("A", "2026-09-08T10:00")]);
  check("identical timestamps change nothing", same.updated === 0 && same.changed === false);
}

console.log("\n-- submittedAt stands in when updatedAt is absent --");
{
  const m = D.mergeReferrals(
    [{ id: "A", submittedAt: "2026-09-08T09:00", status: "open" }],
    [{ id: "A", submittedAt: "2026-09-08T11:00", status: "closed" }]);
  check("an older referral without updatedAt still compares", m.referrals[0].status === "closed");
}

console.log("\n-- no duplicates, whatever the input --");
{
  const m = D.mergeReferrals(
    [R("A", "1"), R("B", "1")],
    [R("B", "2"), R("C", "1"), R("A", "2")]);
  check("each id appears once", ids(m.referrals).length === new Set(ids(m.referrals)).size);
  check("all three ids are present", ids(m.referrals).sort().join() === "A,B,C");
}

console.log("\n-- referrals with no id are not collapsed into each other --");
{
  // Two id-less rows are two different referrals about two different children.
  // Keying them both to "" would silently destroy one.
  const m = D.mergeReferrals(
    [{ studentName: "x", updatedAt: "1" }, { studentName: "y", updatedAt: "1" }], []);
  check("both survive", m.referrals.length === 2);
}

console.log("\n-- bad input does not throw --");
{
  check("null local", D.mergeReferrals(null, [R("A", "1")]).referrals.length === 1);
  check("null server", D.mergeReferrals([R("A", "1")], null).referrals.length === 1);
  check("both null", D.mergeReferrals(null, null).referrals.length === 0);
  check("non-arrays", D.mergeReferrals("nope", 7).referrals.length === 0);
}

console.log("\n-- wired to the screen --");
{
  check("opening Open Referrals pulls from the server",
    /subtab === 'review'\)[\s\S]{0,300}pullReferralsAndRedraw\(false\)/.test(script));
  check("so does opening Closed Referrals",
    /subtab === 'closed'\)[\s\S]{0,300}pullReferralsAndRedraw\(false\)/.test(script));
  // Drawing only after the network answers makes the tab look broken on a
  // slow connection.
  check("the table is drawn BEFORE the pull, not after",
    script.indexOf("updateReferralReviewTable();\n                pullReferralsAndRedraw") !== -1);
  check("there is a Refresh button", /onclick="pullReferralsAndRedraw\(true\)"/.test(html));
  check("and a line saying when it last checked", /id="referralRefreshNote"/.test(html));
  check("the pull fetches ONLY the referrals document, not everything",
    /loadLegacyDocsFromConvex\(\['referrals'\]\)/.test(script));
  check("it uses the tested merge rather than assigning the response",
    /WildcatDiscipline\.mergeReferrals\(behaviorReferrals, rows\)/.test(script));
  check("a failed read is not treated as an empty server",
    /res\.failed && res\.failed\.indexOf\('referrals'\) !== -1/.test(script));
  check("concurrent pulls are guarded", /_referralPullBusy/.test(script));
  check("a username session is skipped quietly, not reported as an error",
    /skipped: 'no-session'/.test(script));
}

console.log("\n-- the permission rule is untouched --");
{
  // The pull must not become a way around scoping: a teacher pulls the same
  // document, and visibleReferrals still filters it to their own.
  const all = [R("MINE", "1", { filedByEmail: "t@x.org" }), R("THEIRS", "1", { filedByEmail: "o@x.org" })];
  const teacher = { email: "t@x.org", role: "teacher" };
  check("a teacher still sees only their own after a pull",
    ids(D.visibleReferrals(all, teacher)).join() === "MINE");
  ["admin", "superadmin", "pbis"].forEach((role) =>
    check(`${role} sees every teacher's referrals`,
      D.visibleReferrals(all, { email: "a@x.org", role }).length === 2));
  check("role matching is case-insensitive",
    D.visibleReferrals(all, { email: "a@x.org", role: "PBIS" }).length === 2);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
