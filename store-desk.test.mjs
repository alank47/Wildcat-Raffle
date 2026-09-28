// The staff side of the first real sale: the Rewards Store and Receipts screens.
//
// Asked for 2026-09-27, and built onto the screens that already existed ("you
// have a store screen. remember? the one we built."):
//   - the campus and one-per-student settings on the reward form;
//   - an admin switch to open, close or schedule the student store;
//   - "a printable pdf of who purchased the pass after the store closes";
//   - cancel is admins only.
// And the things a live sale breaks on a screen that only learned about
// purchases on a reload: a desk showing the 7am list all day, and an admin edit
// from an old tab putting sold passes back on the shelf.
//
// Run: npm test
import { readFileSync } from "node:fs";

const read = (f) => readFileSync(new URL("./" + f, import.meta.url), "utf8");
const script = read("script.js");
const html = read("index.html");
const css = read("styles.css");
const views = read("convex/views_app.ts");
let pass = 0, fail = 0;
const check = (n, c, why) => {
  c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${why ? "  (" + why + ")" : ""}`));
};
const lift = (name, src = script) => {
  const i = src.indexOf("function " + name + "(");
  if (i < 0) throw new Error("not found: " + name);
  let d = 0, k = src.indexOf("{", i);
  for (; k < src.length; k++) { if (src[k] === "{") d++; else if (src[k] === "}") { d--; if (d === 0) break; } }
  return src.slice(i, k + 1);
};

// The real browser modules, loaded the way index.html loads them.
const sandbox = {};
new Function("globalThis", read("wildcat-merge.js").replace(/typeof globalThis !== 'undefined' \? globalThis : this/, "globalThis"))(sandbox);
new Function("globalThis", read("wildcat-store.js").replace(/typeof globalThis !== 'undefined' \? globalThis : this/, "globalThis"))(sandbox);
const WS = sandbox.WildcatStore, WM = sandbox.WildcatMerge;
check("the store and merge modules load", !!(WS && WM && WS.rewardCampusOf && WM.mergeById));

console.log("\nTHE REWARD FORM'S NEW SETTINGS\n");
{
  const r = WS.normalizeReward({ id: "p", name: "Power-Up Pass (Middle School)", cost: 1500, stock: 75,
    studentPurchasable: true, campus: "Middle", limitPerStudent: 1, stockSetAt: "2026-09-28T20:00:00Z" }, 0, {});
  check("a saved reward keeps 'students can buy this'", r.studentPurchasable === true);
  check("the campus, as its normalised word", r.campus === "middle");
  check("the limit", r.limitPerStudent === 1);
  check("and when a person last set the stock", r.stockSetAt === "2026-09-28T20:00:00Z");
  const old = WS.normalizeReward({ id: "x", name: "Old", cost: 1 }, 0, {});
  check("a reward from before these existed is staff-only, everyone, no limit",
    old.studentPurchasable === false && old.campus === "all" && old.limitPerStudent === null && old.stockSetAt === null);
  check("a campus typo is KEPT as written, so the server refuses it rather than this 'fixing' it",
    WS.normalizeReward({ id: "t", name: "T", cost: 1, campus: "Middle School" }, 0, {}).campus === "Middle School");

  // STOCK IS ONLY STAMPED WHEN THE EDIT CARRIES IT.
  const typo = WS.applyRewardEdit(r, { description: "fixed typo" }, Date.parse("2026-09-29T16:00:00Z"), { name: "A" });
  check("an edit without stock leaves stock and its stamp alone",
    typo.stock === 75 && typo.stockSetAt === "2026-09-28T20:00:00Z");
  const restock = WS.applyRewardEdit(r, { stock: 100 }, Date.parse("2026-09-29T16:00:00Z"), { name: "A" });
  check("an edit that sets stock stamps it as a person's decision",
    restock.stock === 100 && restock.stockSetAt === "2026-09-29T16:00:00.000Z");
  const moved = WS.applyRewardEdit(r, { studentPurchasable: false, campus: "high", limitPerStudent: null }, 0, {});
  check("the three settings can be changed by an edit",
    moved.studentPurchasable === false && moved.campus === "high" && moved.limitPerStudent === null);

  const bad = (patch) => !WS.validateReward(Object.assign({ name: "X", cost: 10 }, patch)).ok;
  check("a campus that is not one of the three is refused", bad({ campus: "ms" }));
  check("a limit of 0, 1.5 or words is refused", bad({ limitPerStudent: 0 }) && bad({ limitPerStudent: 1.5 })
    && bad({ limitPerStudent: NaN }));
  check("blank limit and the three campuses are fine",
    !bad({ limitPerStudent: null }) && !bad({ campus: "all" }) && !bad({ campus: "middle" }) && !bad({ campus: "high" }));

  check("both forms have the three fields",
    ["new", "edit"].every((p) => html.includes(`id="${p}RewardStudentPurchasable"`)
      && html.includes(`id="${p}RewardCampus"`) && html.includes(`id="${p}RewardLimit"`)));
  check("the campus choices are everyone, middle and high",
    /<option value="all">Everyone<\/option>\s*<option value="middle">Middle School only/.test(html)
    && /<option value="high">High School only/.test(html));
}

console.log("\nAN EDIT FROM AN OLD TAB CANNOT RESTOCK A PASS\n");
{
  const open = lift("openEditRewardModal");
  check("the edit form re-reads the catalogue before it fills in",
    open.indexOf("await storePullWithin(") < open.indexOf("wildcatCashRewards.find("));
  check("and remembers the stock number it showed",
    /window\.currentEditRewardStockShown = reward\.stock == null \? '' : String\(reward\.stock\);/.test(open));
  const save = lift("saveRewardEdit");
  check("saving re-reads it again, since purchases kept landing",
    save.indexOf("await storePullWithin(") > -1
    && save.indexOf("await storePullWithin(") < save.indexOf("await applyRewardEditFromForm("));
  check("and leaves stock OUT of the edit when the box was not changed",
    /stockNow === stockShown\) \{\s*delete patch\.stock;/.test(lift("applyRewardEditFromForm")));
  check("a new reward's stock is stamped as set by a person",
    /stockSetAt: new Date\(\)\.toISOString\(\) \}, patch\)/.test(lift("addNewReward")));
}

console.log("\nTHE OFFICE CANNOT SELL AROUND THE RULES\n");
{
  const purchaseReward = new Function("students", "wildcatCashRewards", "cashReceipts", "window",
    "recordCashTransaction", "addToAuditLog", "currentUser",
    lift("purchaseReward") + "\nreturn purchaseReward;");
  const mk = (rewards, receipts) => {
    const moved = [];
    const kidsList = [{ id: "7001", firstName: "Ana", lastName: "Reyes", grade: "7", wildcatCashBalance: 5000 }];
    const fn = purchaseReward(kidsList, rewards, receipts, { WildcatStore: WS },
      (req) => { moved.push(req); return { id: "tx" + moved.length }; }, () => {}, { name: "Desk" });
    return { fn, moved, receipts, rewards };
  };
  const pass1 = { id: "pup_ms", name: "Power-Up Pass (Middle School)", cost: 1500, stock: 75,
    available: true, studentPurchasable: true, campus: "middle", limitPerStudent: 1 };
  const t = mk([pass1], []);
  const r = t.fn("7001", "pup_ms", 1, { channel: "staff" });
  check("a student-store pass cannot be sold at the office", r.ok === false && /student store/.test(r.reason));
  check("and nothing moved", t.moved.length === 0 && t.receipts.length === 0 && pass1.stock === 75);

  const lunch = { id: "lunch", name: "Lunch with Teacher", cost: 1000, stock: 5, available: true,
    studentPurchasable: false, campus: "high", limitPerStudent: 1 };
  const t2 = mk([lunch], []);
  const wrong = t2.fn("7001", "lunch", 1, { channel: "staff" });
  check("a staff-sold item still keeps its campus rule", wrong.ok === false && /High School/.test(wrong.reason));
  const lunch7 = { ...lunch, campus: "all" };
  const t3 = mk([lunch7], [{ id: "WC-1", studentId: "7001", rewardId: "lunch", status: "fulfilled", quantity: 1 }]);
  check("and its one-per-student rule, counting receipts this tab holds",
    /already has one/.test(t3.fn("7001", "lunch", 1, { channel: "staff" }).reason || ""));
  const t4 = mk([{ ...lunch7 }], []);
  const ok = t4.fn("7001", "lunch", 1, { channel: "staff" });
  check("an allowed staff sale still works", ok.ok === true && t4.moved.length === 1 && t4.rewards[0].stock === 4);
  check("and stamps its stock as set by a person", typeof t4.rewards[0].stockSetAt === "string");

  const card = script.slice(script.indexOf("function updateRewardsStore()"), script.indexOf("function updateRedemptionHistory()"));
  check("the card says where a student-store item is bought, instead of a sell button",
    /const purchaseBtn = selfServe\s*\?\s*''/.test(card)
    && /const selfServeNote = selfServe\s*\?\s*`<p class="reward-selfserve-note">Students buy this on their Chromebook<\/p>`/.test(card));
  check("and shows who may buy it", /Middle School only/.test(card) && /High School only/.test(card) && /per student/.test(card));
}

console.log("\nTHE RECEIPTS DESK\n");
{
  // The merge: newest copy wins, rows only this tab has are kept.
  let wildcatCashRewards = [{ id: "pup_ms", name: "Pass", cost: 1500, stock: 75, updatedAt: "2026-09-29T13:00:00Z" }];
  let cashReceipts = [
    { id: "WC-A", status: "issued", purchasedAt: "2026-09-29T14:00:00Z", updatedAt: null },
    { id: "WC-LOCAL", status: "issued", purchasedAt: "2026-09-29T14:30:00Z", updatedAt: null },
    { id: "WC-B", status: "fulfilled", purchasedAt: "2026-09-29T14:10:00Z", updatedAt: "2026-09-29T15:00:00Z" },
  ];
  const merge = new Function("window", "getRewards", "setRewards", "getReceipts", "setReceipts",
    lift("mergeStoreLists")
      .replace(/wildcatCashRewards = /, "setRewards(").replace(/window\.WildcatMerge\.mergeById\(normalized, wildcatCashRewards\);/, "window.WildcatMerge.mergeById(normalized, getRewards()));")
      .replace(/cashReceipts = window\.WildcatMerge\.mergeById\(serverReceipts, cashReceipts\)/, "setReceipts(window.WildcatMerge.mergeById(serverReceipts, getReceipts())")
      .replace(/\.sort\(\(a, b\) => new Date\(a\.purchasedAt\) - new Date\(b\.purchasedAt\)\);/, ".sort((a, b) => new Date(a.purchasedAt) - new Date(b.purchasedAt)));")
    + "\nreturn mergeStoreLists;")({ WildcatStore: WS, WildcatMerge: WM },
      () => wildcatCashRewards, (v) => { wildcatCashRewards = v; },
      () => cashReceipts, (v) => { cashReceipts = v; });
  merge(
    [{ id: "pup_ms", name: "Pass", cost: 1500, stock: 40, updatedAt: "2026-09-29T15:30:00Z" }],
    [
      { id: "WC-A", status: "fulfilled", purchasedAt: "2026-09-29T14:00:00Z", updatedAt: "2026-09-29T15:10:00Z", fulfilledBy: "Desk 2" },
      { id: "WC-B", status: "issued", purchasedAt: "2026-09-29T14:10:00Z", updatedAt: null },
      { id: "WC-NEW", status: "issued", purchasedAt: "2026-09-29T15:20:00Z", updatedAt: null },
    ]);
  const byId = Object.fromEntries(cashReceipts.map((r) => [r.id, r]));
  check("a purchase a child made a minute ago appears at the desk", !!byId["WC-NEW"]);
  check("a handover at another desk shows here", byId["WC-A"].status === "fulfilled" && byId["WC-A"].fulfilledBy === "Desk 2");
  check("this desk's own handover, not yet saved, is not undone by an older copy", byId["WC-B"].status === "fulfilled");
  check("a receipt only this tab has is kept", !!byId["WC-LOCAL"]);
  check("the list stays in purchase order", cashReceipts.map((r) => r.id).join(",") === "WC-A,WC-B,WC-LOCAL,WC-NEW");
  check("the catalogue takes the server's newer stock", wildcatCashRewards[0].stock === 40);

  const fulfil = lift("fulfillReceipt");
  check("a handover re-reads the receipts first, so two desks cannot hand over one pass",
    fulfil.indexOf("await storePullWithin(") > -1 && fulfil.indexOf("await storePullWithin(") < fulfil.indexOf("cashReceipts.findIndex("));
  const cancel = lift("cancelReceipt");
  check("cancel is refused to anyone but an admin, before anything else happens",
    /^function cancelReceipt\(receiptId\) \{\s*(\/\/[^\n]*\n\s*)*if \(!correctionIsAdmin\(\)\)/.test(cancel));
  check("and re-reads the receipts before deciding", cancel.indexOf("await storePullWithin(") < cancel.indexOf("cashReceipts.findIndex("));
  check("the Cancel button is only drawn for an admin",
    /const canCancelHere = correctionIsAdmin\(\);/.test(script) && /\(canCancelHere\s*\?\s*`<button[^`]*cancelReceipt/.test(script));

  const tabs = script.slice(script.indexOf("} else if (tabName === 'rewardsStore') {"), script.indexOf("} else if (tabName === 'studentAccounts') {"));
  check("opening either store tab re-reads both lists",
    /openStoreTab\('rewardsStore'\)/.test(tabs) && /openStoreTab\('receipts'\)/.test(tabs));
  const timer = lift("startStoreDeskRefresh");
  check("the desk keeps refreshing while it is on screen", /setInterval\(/.test(timer) && /STORE_DESK_REFRESH_MS/.test(timer));
  check("stops itself once neither tab is showing", /if \(!onRewards && !onReceipts\) \{\s*clearInterval\(_storeDeskTimer\);/.test(timer));
  check("and does nothing in a hidden tab", /if \(document\.hidden\) return;/.test(timer));
  check("the reads are one list each, not a reload",
    /legacyData:loadSlice',\s*\{ doc: 'secondary', collection: 'wildcatCashRewards' \}/.test(script)
    && /legacyData:loadSlice',\s*\{ doc: 'secondary', collection: 'cashReceipts' \}/.test(script));
}

console.log("\nTHE STUDENT STORE SWITCH\n");
{
  const render = lift("renderStoreSwitch");
  check("staff see whether it is open", /Student store is OPEN/.test(render) && /Student store is CLOSED/.test(render));
  check("with the time it opens or closes", /opens ' \+ escapeHtml\(fmtStoreTime\(st\.opensAt\)\)/.test(render)
    && /until ' \+ escapeHtml\(fmtStoreTime\(st\.closesAt\)\)/.test(render));
  check("and what students are being told", /Students see:/.test(render));
  check("only an admin gets the buttons", /const admin = correctionIsAdmin\(\);/.test(render)
    && /if \(admin\) \{\s*buttons =/.test(render) && /if \(admin && _storeSwitchFormOpen\)/.test(render));
  check("the buttons ask first", /await showConfirm\(action === 'open'/.test(lift("storeSwitchAction"))
    && /await showConfirm\('Save this schedule/.test(lift("saveStoreSchedule")));
  check("and the server is asked through the admin-only mutation",
    /'studentStore:setStore', \{ change: action \}/.test(script) && /'studentStore:setStore', \{\s*change: 'schedule'/.test(script));
  check("the panel sits on the Rewards Store screen", /<div id="storeSwitchPanel" class="store-switch" hidden><\/div>/.test(html)
    && html.indexOf('id="storeSwitchPanel"') > html.indexOf('id="rewardsStoreTab"')
    && html.indexOf('id="storeSwitchPanel"') < html.indexOf('id="receiptsTab"'));
  check("and hiding it actually hides it", /\.store-switch\[hidden\] \{ display: none !important; \}/.test(css));
}

console.log("\nA STUDENT'S PAGE NOTICES THE STORE OPENING\n");
{
  // For THIS student: a dry-run tester sees it open while everyone else does not.
  check("the cheap poll carries whether the store is open, and its look, for this student",
    /const me = await requireStudentSelf\(ctx\);/.test(views) && /const store = await storeSignal\(ctx, me\);/.test(views)
    && /storeOpen: store\.open,/.test(views) && /storeLook: store\.look,/.test(views));
  const poll = lift("wpPollPassOnce");
  check("the portal redraws when it changes",
    /nextStore !== wpStoreOpenSeen\) \{\s*wpStoreOpenSeen = nextStore;\s*await loadStudentPortal\(\);/.test(poll));
  check("compared against what was DRAWN, set when the store loads",
    /wpStoreOpenSeen = _wpStore\.storeOpen;/.test(script));
  check("and forgotten on sign-out, so the next child on a shared machine starts clean",
    /wpSyncVersion = null;\s*wpStoreOpenSeen = null;/.test(script));
}

console.log("\nTHE PURCHASE LIST\n");
{
  const build = new Function(lift("buildPurchaseListPages") + "\nreturn buildPurchaseListPages;")();
  const students = [
    { id: "7001", firstName: "Ana", lastName: "Reyes", grade: "7", studentNumber: "7001" },
    { id: "6001", firstName: "Ben", lastName: "Zamora", grade: "6", studentNumber: "6001" },
    { id: "7002", firstName: "Cara", lastName: "Alvarez", grade: "7", studentNumber: "7002" },
    { id: "9001", firstName: "Dan", lastName: "Ortiz", grade: "10", studentNumber: "9001" },
  ];
  const rewards = [{ id: "pup_ms", name: "Power-Up Pass (Middle School)" }, { id: "pup_hs", name: "Power-Up Pass (High School)" }];
  const rc = (id, studentId, rewardId, extra) => Object.assign({ id, studentId, rewardId, status: "issued",
    quantity: 1, channel: "student", purchasedAt: "2026-09-29T14:00:00Z" }, extra || {});
  const receipts = [
    rc("WC-AAA", "7001", "pup_ms"),
    rc("WC-BBB", "6001", "pup_ms", { status: "fulfilled" }),
    rc("WC-CCC", "7002", "pup_ms", { channel: "staff" }),
    rc("WC-XXX", "7003", "pup_ms", { status: "cancelled" }),
    rc("WC-HHH", "9001", "pup_hs"),
    rc("WC-GONE", "8888", "pup_hs", { studentName: "Eli Quinn Moss", studentGrade: "11" }),
    rc("WC-OTHER", "7001", "reward1"),
  ];
  const pages = build(receipts, rewards, students, ["pup_ms", "pup_hs"]);
  check("one page per item, in the order asked", pages.length === 2 && pages[0].rewardName === "Power-Up Pass (Middle School)");
  const ms = pages[0];
  check("a cancelled pass is left off the list", !ms.rows.some((r) => r.receipt === "WC-XXX") && ms.rows.length === 3);
  check("and counted, so nobody wonders where it went", ms.cancelled === 1);
  check("sorted by grade, then surname", ms.rows.map((r) => r.last).join(",") === "Zamora,Alvarez,Reyes");
  check("with the student number from the roster", ms.rows[0].studentNumber === "6001");
  check("and whether it has been collected", ms.rows.find((r) => r.receipt === "WC-BBB").status === "Collected"
    && ms.rows.find((r) => r.receipt === "WC-AAA").status === "Awaiting pickup");
  check("an office sale is marked as one", ms.rows.find((r) => r.receipt === "WC-CCC").byStaff === true);
  check("another item's receipts do not leak onto the page", !pages.some((p) => p.rows.some((r) => r.receipt === "WC-OTHER")));
  const gone = pages[1].rows.find((r) => r.receipt === "WC-GONE");
  check("a student no longer on the roster still prints, from the receipt's own name",
    gone && gone.last === "Moss" && gone.first === "Eli Quinn" && gone.grade === "11");
  check("an item nobody bought yet is an empty page, not a missing one",
    build(receipts, rewards, students, ["nothing"])[0].rows.length === 0);

  const teethless = new Function(lift("buildPurchaseListPages").replace("r.status !== 'cancelled'", "true")
    + "\nreturn buildPurchaseListPages;")();
  check("TEETH: without the cancelled filter a refunded pass WOULD print",
    teethless(receipts, rewards, students, ["pup_ms"])[0].rows.some((r) => r.receipt === "WC-XXX"));

  check("the Receipts screen has the button", /onclick="openPurchaseListSheet\(\)"/.test(html)
    && html.indexOf("openPurchaseListSheet()") > html.indexOf('id="receiptsTab"'));
  const open = lift("openPurchaseListSheet");
  check("it re-reads the receipts before building the list", open.indexOf("await storePullWithin(") < open.indexOf("purchaseListChoices()"));
  check("and starts from the student-store items still on sale", /c\.selfServe && !c\.retired/.test(open));
  check("printing prints the sheet and nothing else",
    /@media print \{\s*body\.wc-printing > \*:not\(#wcPrintSheet\) \{ display: none !important; \}/.test(css));
  check("one item per page", /body\.wc-printing \.print-page \{ break-after: page; page-break-after: always;/.test(css));
  check("the on-screen buttons do not print", /body\.wc-printing \.print-toolbar \{ display: none !important; \}/.test(css));
  check("and it says how to get a PDF", /Save as PDF/.test(lift("renderPurchaseListSheet")));
  const z = Number((css.match(/\.print-sheet \{[^}]*z-index: (\d+)/) || [])[1]);
  const dialogZ = Number((css.match(/\.wc-dialog-backdrop \{[^}]*z-index: (\d+)/) || [])[1]);
  check("the sheet sits above the modals but below the dialog, so a confirm can open over it",
    z > 10000 && z < dialogZ, `${z} vs ${dialogZ}`);
  check("everything printed is escaped", (lift("renderPurchaseListSheet").match(/escapeHtml\(r\.(last|first|grade|studentNumber|receipt|status)\)/g) || []).length === 6);
}

console.log("\nWHAT THE REVIEW FOUND (2026-09-28), EACH PINNED\n");
{
  // A save that was already running put the OLD receipts and catalogue back
  // over a refresh, undoing a handover, a cancel or an edit made meanwhile.
  check("a save no longer puts back an old receipts list",
    !/cashReceipts = mergedSecondary\.cashReceipts;/.test(script));
  check("or an old catalogue", !/wildcatCashRewards = mergedSecondary\.wildcatCashRewards;/.test(script));

  const save = lift("saveRewardEdit");
  check("one reward save at a time", /if \(_rewardSaveInFlight\) return;/.test(save));
  check("what it needs is read BEFORE it waits",
    save.indexOf("const stockShown = window.currentEditRewardStockShown;") < save.indexOf("await storePullWithin(")
    && save.indexOf("readRewardForm('edit')") < save.indexOf("await storePullWithin("));
  check("and a form closed or switched meanwhile is not saved",
    /if \(window\.currentEditRewardId !== editingId\) return;/.test(save));
  check("an unknown 'shown' stock counts as unchanged, the safe side",
    /if \(stockShown === undefined \|\| stockNow === stockShown\) \{\s*delete patch\.stock;/.test(lift("applyRewardEditFromForm")));

  check("the 20-second refresh leaves an open schedule form alone",
    /if \(onRewards && !_storeSwitchFormOpen\) refreshStoreSwitch\(\);/.test(lift("startStoreDeskRefresh")));
  const sched = lift("saveStoreSchedule");
  check("the messages are read before the confirm, like the times",
    sched.indexOf("const reason = val('storeReason')") < sched.indexOf("await showConfirm("));
  check("an opening time already past says it opens the store NOW",
    /THIS OPENS THE STORE NOW/.test(sched) && /Date\.parse\(opensAt\) <= Date\.now\(\) \+ 60000/.test(sched));
  check("'Open now' says what happens to the schedule",
    /This replaces the scheduled opening/.test(lift("storeSwitchAction")) && /It will still close at/.test(lift("storeSwitchAction")));

  const cancel = lift("cancelReceipt");
  check("cancel decides on a fresh copy AFTER the reason prompt",
    cancel.indexOf("await showPrompt(") < cancel.lastIndexOf("await storePullWithin(")
    && /const recheck = window\.WildcatStore\.canCancel\(cashReceipts\[idxNow\]\);/.test(cancel)
    && /cashReceipts\[idxNow\] = res\.receipt;/.test(cancel) && !/cashReceipts\[idx\] = res\.receipt;/.test(cancel));
  check("retire finds the reward again after its confirm",
    /const at = wildcatCashRewards\.findIndex\(r => r\.id === rewardId\);/.test(lift("retireRewardById")));
  check("the purchase preview counts receipts, so it agrees with the purchase",
    /canPurchase\(\{ student, reward, quantity: qty, receipts: cashReceipts \}\)/.test(script));
  check("the print picks are by position, not an id pasted into an attribute",
    /onchange="togglePurchaseListPickAt\(' \+ i \+ '\)"/.test(lift("renderPurchaseListSheet"))
    && !/togglePurchaseListPick\(\\'/.test(lift("renderPurchaseListSheet")));

  const testers = lift("saveStoreTesters");
  check("dry-run testers are admin-only, checked, confirmed and saved through the switch",
    /correctionIsAdmin\(\)/.test(testers) && /\^\\d\{3,10\}\$/.test(testers)
    && /await showConfirm\(/.test(testers) && /'studentStore:setStore',\s*\{ change: 'testers', testers: list \}/.test(testers));
  check("and the panel says who can buy, and until when", /Dry run:<\/strong> student/.test(lift("renderStoreSwitch")));
}

console.log("\nTHE SECOND REVIEW (2026-09-28)\n");
{
  const render = lift("renderStoreSwitch");
  check("a pending opening can be called off from the screen",
    /!st\.open && st\.opensAt[\s\S]{0,300}Cancel the scheduled opening/.test(render));
  check("what the admin typed survives a redraw",
    /el\.dataset\.touched === '1'\) typed\[id\] = el\.value;/.test(render)
    && /if \(el\) \{ el\.value = typed\[id\];/.test(render));
  const sched = lift("saveStoreSchedule");
  check("a closing time already past is refused in words, before the server",
    /That closing time has already passed/.test(sched));
  check("so is closing before a kept opening", /The store has to open before it closes/.test(sched)
    && /const effOpens = opensAt \|\| st0\.opensAt \|\| null;/.test(sched));
  check("a future opening saved while the sale is on says it CLOSES the store now",
    /THIS CLOSES THE STORE NOW, until/.test(sched) && /const closesNow = !!\(opensAt && !opensNow && st0\.open\);/.test(sched));
  check("more than 10 testers is refused on the screen", /list\.length > 10/.test(lift("saveStoreTesters")));
  check("and the testers prompt says a cancel does not restock",
    /a cancel does NOT put an item back in stock/.test(lift("saveStoreTesters")));
  check("a print-list click means the box it was on, not a list rebuilt since",
    /const c = _purchaseListChoicesShown\[i\];/.test(lift("togglePurchaseListPickAt"))
    && /_purchaseListChoicesShown = choices;/.test(lift("renderPurchaseListSheet")));
}

console.log("\nTHE TWO NEW SETTINGS ON THE FORM (2026-09-28)\n");
{
  check("both forms have 'let the other campus see it' and the buyer message",
    ["new", "edit"].every((p) => html.includes(`id="${p}RewardShowOtherCampus"`)
      && new RegExp(`<textarea id="${p}RewardMessage"[^>]*maxlength="500"`).test(html)));
  const read = lift("readRewardForm");
  check("the form reads both", /showOtherCampus: !!\(seeIt && seeIt\.checked\)/.test(read)
    && /purchaseMessage: message \? String\(message\.value \|\| ''\) : ''/.test(read));
  const fill = lift("fillRewardStoreFields");
  check("and fills both back in when editing", /seeIt\.checked = r\.showOtherCampus === true/.test(fill)
    && /message\.value = r\.purchaseMessage \|\| ''/.test(fill));

  const r = WS.normalizeReward({ id: "p", name: "P", cost: 1, showOtherCampus: true,
    purchaseMessage: "  Gym, Oct 1\nat lunch  " }, 0, {});
  check("a saved reward keeps both", r.showOtherCampus === true && r.purchaseMessage === "Gym, Oct 1\nat lunch");
  const old = WS.normalizeReward({ id: "x", name: "X", cost: 1 }, 0, {});
  check("an older reward has neither", old.showOtherCampus === false && old.purchaseMessage === null);
  const cleared = WS.applyRewardEdit(r, { showOtherCampus: false, purchaseMessage: "   " }, 0, {});
  check("both can be turned off by an edit", cleared.showOtherCampus === false && cleared.purchaseMessage === null);
  const kept = WS.applyRewardEdit(r, { description: "x" }, 0, {});
  check("an edit that does not mention them leaves them alone",
    kept.showOtherCampus === true && kept.purchaseMessage === "Gym, Oct 1\nat lunch");
  check("a message over 500 characters is refused",
    !WS.validateReward({ name: "X", cost: 1, purchaseMessage: "y".repeat(501) }).ok
    && WS.validateReward({ name: "X", cost: 1, purchaseMessage: "y".repeat(500) }).ok);
  const card = script.slice(script.indexOf("function updateRewardsStore()"), script.indexOf("function updateRedemptionHistory()"));
  check("the item's card says when the other campus can see it, and when it has a message",
    /'Other campus can see it'/.test(card) && /'Has a buyer message'/.test(card));
}

console.log("\nTHE FORM HELPS (review, 2026-09-28)\n");
{
  const sync = lift("syncRewardStoreFields");
  check("'let the other campus see it' is greyed out and cleared for an Everyone item",
    /seeIt\.disabled = everyone;\s*if \(everyone\) seeIt\.checked = false;/.test(sync));
  check("and never saved as on for one", /campus\.value !== 'all',/.test(lift("readRewardForm")));
  check("the message box counts to 500, and says when a paste was cut off",
    /n \+ ' \/ 500'/.test(sync) && /anything past it was cut off/.test(sync)
    && ["new", "edit"].every((p) => html.includes(`id="${p}RewardMessageCount"`)
      && html.includes(`oninput="syncRewardStoreFields('${p}')"`)
      && html.includes(`onchange="syncRewardStoreFields('${p}')"`)));
  check("the add form starts in step", /syncRewardStoreFields\('new'\);/.test(lift("showAddRewardModal")));
  const card = script.slice(script.indexOf("function updateRewardsStore()"), script.indexOf("function updateRedemptionHistory()"));
  check("the item's card shows the buyer message itself, escaped",
    /Buyers are told:<\/span> \$\{escapeHtml\(reward\.purchaseMessage\)\.replace/.test(card));
}

console.log("\nTHE LOOK SWITCH ON THE PANEL (2026-09-28)\n");
{
  const render = lift("renderStoreSwitch");
  check("the panel says which look students get", /the Wildcat Digital Store \(the shop with the clerk\)/.test(render)
    && /the plain list/.test(render));
  check("with a one-click switch, for admins only", /\(admin \? ' <button[^']*store-look-btn" onclick="storeLookAction/.test(render));
  const act = lift("storeLookAction");
  check("which asks first and goes through the admin-only mutation",
    /correctionIsAdmin\(\)/.test(act) && /await showConfirm\(/.test(act)
    && /'studentStore:setStore',\s*\{ change: 'look', look: look \}/.test(act));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
