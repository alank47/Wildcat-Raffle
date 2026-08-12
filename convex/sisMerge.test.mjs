// Can a SIS roster sync destroy something a child earned?
//
// This is the test the whole feature exists to satisfy. Students have real
// balances (340 tickets, spendable Wildcat Cash), PowerSchool knows nothing
// about any of it, and a sync that treats "PowerSchool didn't mention it" as
// "zero" spends someone's money silently.
//
// The adversarial cases matter more than the happy path: a sync payload that
// explicitly carries zeroes is exactly what a buggy or malicious upstream
// would send, and it must not win.
import { mergeStudent, sisFieldsFor, EARNED_FIELDS } from "./sisMerge.ts";

let pass = 0, fail = 0;
const check = (l, c, d = "") => {
  if (c) { pass++; console.log(`  PASS  ${l}`); }
  else { fail++; console.log(`  FAIL  ${l}${d ? `  (${d})` : ""}`); }
};

/** A real student mid-year, with things worth losing. */
const RICH = {
  studentNumber: "11414",
  firstName: "Ana", lastName: "Rodriguez", grade: "9",
  pbisTickets: 340, attendanceTickets: 51, academicTickets: 80,
  bigRaffleQualified: ["week1", "week2", "week3"],
  weeksQualified: 3,
  wildcatCashBalance: 1250, wildcatCashEarned: 2000, wildcatCashSpent: 750,
  wildcatCashDeducted: 0, wildcatCashRewardsRedeemed: 4,
  wildcatCashTransactions: [{ amount: 100 }, { amount: -50 }],
  cashBalance: 12, cashTransactions: [{ amount: 12 }],
};

console.log("\nThe sync cannot write earned value");
{
  // The hostile case: upstream sends zeroes for everything a child earned.
  const hostile = {
    firstName: "Ana", lastName: "Rodriguez", grade: "10",
    pbisTickets: 0, attendanceTickets: 0, academicTickets: 0,
    bigRaffleQualified: [], weeksQualified: 0,
    wildcatCashBalance: 0, wildcatCashEarned: 0, wildcatCashSpent: 0,
    wildcatCashDeducted: 0, wildcatCashRewardsRedeemed: 0,
    wildcatCashTransactions: [], cashBalance: 0, cashTransactions: [],
  };
  const patch = mergeStudent(RICH, hostile);
  const touched = EARNED_FIELDS.filter((f) => f in patch);
  check("a payload full of zeroes writes NO earned field", touched.length === 0, `touched ${touched}`);
  check("the legitimate grade change still applies", patch.grade === "10");
  check("nothing else sneaks in", Object.keys(patch).join() === "grade", Object.keys(patch).join());
}

console.log("\nEach earned field individually");
for (const field of EARNED_FIELDS) {
  const patch = mergeStudent(RICH, { [field]: 0, firstName: "Ana", lastName: "Rodriguez" });
  check(`${field} survives`, !(field in patch));
}

console.log("\nOrdinary roster updates still work");
{
  check("name change applies", mergeStudent(RICH, { firstName: "Anna", lastName: "Rodriguez" }).firstName === "Anna");
  check("grade promotion applies", mergeStudent(RICH, { grade: "10" }).grade === "10");
  check("email is normalized on the way in",
    mergeStudent(RICH, { email: "  AR11414@WestbrookAcademy.org " }).email === "ar11414@westbrookacademy.org");
  check("an unchanged roster produces an EMPTY patch (no pointless writes)",
    Object.keys(mergeStudent(RICH, { firstName: "Ana", lastName: "Rodriguez", grade: "9" })).length === 0);
}

console.log("\nMissing and malformed upstream data");
{
  check("absent fields are not written as blanks",
    Object.keys(mergeStudent(RICH, {})).length === 0);
  check("an empty-string name does not erase a real one",
    !("firstName" in mergeStudent(RICH, { firstName: "" })));
  check("an unrecognized school value is dropped, not guessed",
    !("school" in sisFieldsFor({ school: "elementary" })));
  check("a recognized school value passes through",
    sisFieldsFor({ school: "highschool" }).school === "highschool");
  check("an empty email does not overwrite an address",
    !("email" in mergeStudent({ ...RICH, email: "ar11414@westbrookacademy.org" }, { email: "" })));
}

console.log("\nThe allowlist is closed");
{
  // The whole point of an allowlist: a field nobody anticipated cannot be written.
  const patch = mergeStudent(RICH, { springCarnivalTickets: 0, secretAdminFlag: true, role: "admin" });
  check("an unanticipated new field is NOT written", Object.keys(patch).length === 0, Object.keys(patch).join());
  check("EARNED_FIELDS and SIS_OWNED_FIELDS do not overlap",
    !EARNED_FIELDS.some((f) => ["firstName","lastName","grade","email","school"].includes(f)));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
