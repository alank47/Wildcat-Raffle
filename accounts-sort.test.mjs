// Student Accounts can be sorted by balance. Run: npm test
//
// Asked for 2026-09-25: "In accounts for Wildcat Cash, can you give me a
// filter that allows me to sort by Balances highest to lowest?" Name A-Z stays
// the default so the screen opens as it always has.
import { readFileSync } from "node:fs";

const script = readFileSync(new URL("./script.js", import.meta.url), "utf8");
const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
let pass = 0, fail = 0;
const check = (n, c, why) => {
  c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${why ? "  (" + why + ")" : ""}`));
};
const lift = (name) => {
  const i = script.indexOf("function " + name + "(");
  let d = 0, k = script.indexOf("{", i);
  for (; k < script.length; k++) { if (script[k] === "{") d++; else if (script[k] === "}") { d--; if (d === 0) break; } }
  return script.slice(i, k + 1);
};
const sort = new Function(lift("sortStudentAccounts") + "\nreturn sortStudentAccounts;")();
const kids = () => [
  { firstName: "Ana", lastName: "Zeta", wildcatCashBalance: 300 },
  { firstName: "Ben", lastName: "Alpha", wildcatCashBalance: 1500 },
  { firstName: "Cal", lastName: "Mid", wildcatCashBalance: -100 },
  { firstName: "Dee", lastName: "Beta", wildcatCashBalance: 300 },
  { firstName: "Eve", lastName: "Null", wildcatCashBalance: undefined },
];
const names = (l) => l.map((s) => s.firstName).join(",");

console.log("\nTHE ORDER\n");
check("default: by last name, A to Z (as it always was)", names(sort(kids(), "name")) === "Ben,Dee,Cal,Eve,Ana");
check("balance highest to lowest", names(sort(kids(), "balanceDesc")) === "Ben,Dee,Ana,Eve,Cal", names(sort(kids(), "balanceDesc")));
check("balance lowest to highest (a negative balance first)", names(sort(kids(), "balanceAsc")) === "Cal,Eve,Dee,Ana,Ben");
check("equal balances stay in name order, so the list never reshuffles", names(sort(kids(), "balanceDesc")).includes("Dee,Ana"));
check("a missing balance counts as $0, not as 'sort anywhere'", sort(kids(), "balanceDesc").findIndex((s) => s.firstName === "Eve") === 3);
check("an unknown choice falls back to name", names(sort(kids(), "banana")) === "Ben,Dee,Cal,Eve,Ana");
// TEETH: comparing balances as TEXT puts "300" above "1500".
const asText = new Function(lift("sortStudentAccounts").replace("(bal(b) - bal(a))", "String(bal(b)).localeCompare(String(bal(a)))")
  + "\nreturn sortStudentAccounts;")();
check("TEETH: comparing balances as text would get it wrong", names(asText(kids(), "balanceDesc")) !== "Ben,Dee,Ana,Eve,Cal");

console.log("\nTHE SCREEN\n");
check("a Sort by menu on the Accounts screen", /id="accountSort" onchange="filterStudentAccounts\(\)"/.test(html));
check("with the three choices, name first (the default)",
  /<option value="name">Name \(A–Z\)<\/option>\s*<option value="balanceDesc">Balance: highest to lowest<\/option>\s*<option value="balanceAsc">Balance: lowest to highest<\/option>/.test(html));
check("the screen uses it, after the class, grade and search filters",
  /sortStudentAccounts\(list, document\.getElementById\('accountSort'\)\?\.value \|\| 'name'\);/.test(script));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
