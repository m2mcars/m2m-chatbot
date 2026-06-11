#!/usr/bin/env node
/* Deterministic tests for the conversation-flow gating:
   Fix 1 — vehicle presentation lines never include a location name unless the
            customer asked about location (loc= marker / showLoc flag).
   Fix 2 — restricted vehicles (price >= $30,000 or performance keyword) can
            never reach a booking; lead notes are tagged for staff.
   Fix 3 — bookings require payment intent plus name and phone.
   These exercise the SAME pure functions used at runtime in index.html.
   Run: node test/gating.test.js */
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const m = src.match(/const TYPE_TO_BODIES=[\s\S]*?module\.exports=\{[^}]*\};\}/);
if (!m) throw new Error("Could not extract pure functions from index.html");
const mod = { exports: {} };
new Function("module", "exports", m[0])(mod, mod.exports);
const {
  isRestricted, isCashIntent, bookingGate, escalateNoteFor, vehicleShowLine,
  selectVehicles, parseShowMarker, classifyRequest,
  RESTRICTED_KW, RESTRICTED_PRICE, SCHED_PROMISE_RE, matchVehicleFromText,
} = mod.exports;

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log("  PASS  " + name); }
  else { failures++; console.log("  FAIL  " + name + (detail ? "  -> " + detail : "")); }
}

const contact = { name: "Jordan Smith", phone: "(205) 555-1234" };
const plain = { yr: 2019, mk: "Toyota", mo: "Camry SE", pr: 14995, cl: "White", lo: "Lincoln", mi: 144090, body: "Sedan" };
const pricey = { yr: 2020, mk: "Chevy", mo: "Silverado RST Black Widow 4WD", pr: 35500, cl: "Grey", lo: "Lincoln", mi: 132573, body: "Truck" };

console.log("\n(FIX 2a) restricted definition: price threshold and every keyword class");
check("restricted at exactly $" + RESTRICTED_PRICE.toLocaleString(), isRestricted({ mo: "Tahoe LT", pr: RESTRICTED_PRICE }) === true);
check("$29,999 with a clean model name is NOT restricted", isRestricted({ mo: "Tahoe LT", pr: 29999 }) === false);
RESTRICTED_KW.forEach(k =>
  check("restricted by keyword '" + k + "' even under $30k",
    isRestricted({ mo: "2019 Test " + k.toUpperCase() + " Edition", pr: 15000 }) === true));

console.log("\n(GATE RULE) payment method x vehicle status");
check("restricted + finance blocks booking (by price)", bookingGate(pricey, "finance", contact) === "restricted");
check("restricted + finance blocks booking (by keyword)", bookingGate({ mo: "Mustang GT 5.0L", pr: 28750 }, "finance", contact) === "restricted");
check("restricted + CASH schedules directly (nothing to pre-qualify)", bookingGate(pricey, "cash", contact) === null);
check("restricted + trade-in with cash difference schedules directly",
  bookingGate(pricey, "trade-in-cash", contact) === null && bookingGate(pricey, "trade-in + cash", contact) === null);
check("restricted + trade-in with financed difference blocks",
  bookingGate(pricey, "trade-in-finance", contact) === "restricted" && bookingGate(pricey, "trade-in + finance", contact) === "restricted");
check("restricted + bare trade-in (financing undetermined) blocks", bookingGate(pricey, "trade-in", contact) === "restricted");
check("restricted + unknown intent asks for intent first", bookingGate(pricey, null, contact) === "no_intent");
check("customer insisting on financed restricted cannot bypass: gate ignores contact completeness",
  bookingGate(pricey, "finance", contact) === "restricted" && bookingGate(pricey, "finance", {}) === "restricted");
check("standard vehicle + cash books normally", bookingGate(plain, "cash", contact) === null);
check("standard vehicle + finance books normally", bookingGate(plain, "finance", contact) === null);
check("isCashIntent: cash-like vs finance-like",
  isCashIntent("cash") && isCashIntent("CASH") && isCashIntent("trade-in + cash") && isCashIntent("trade-in-cash") &&
  !isCashIntent("finance") && !isCashIntent("trade-in") && !isCashIntent("trade-in-finance") && !isCashIntent(null));

console.log("\n(FIX 2c) lead notification carries the restricted tag");
check("restricted_prequal reason produces tagged note",
  /^\[RESTRICTED VEHICLE PRE-QUAL\]/.test(escalateNoteFor("restricted_prequal", true)),
  escalateNoteFor("restricted_prequal", true));
check("any escalation for a restricted vehicle is tagged",
  /^\[RESTRICTED VEHICLE PRE-QUAL\]/.test(escalateNoteFor("link_sent", true)));
check("non-restricted note is unchanged",
  escalateNoteFor("link_sent", false) === "Customer was sent the finance application link. Follow up after they submit.",
  escalateNoteFor("link_sent", false));

console.log("\n(FIX 3) booking requires intent plus name and phone");
check("no intent -> blocked", bookingGate(plain, null, contact) === "no_intent");
check("no name -> blocked", bookingGate(plain, "cash", { phone: "(205) 555-1234" }) === "no_contact");
check("no phone -> blocked", bookingGate(plain, "finance", { name: "Jordan" }) === "no_contact");
check("no contact at all -> blocked", bookingGate(plain, "cash", null) === "no_contact");
check("no vehicle -> blocked", bookingGate(null, "cash", contact) === "no_vehicle");
check("happy path cash reaches booking", bookingGate(plain, "cash", contact) === null);
check("happy path finance reaches booking", bookingGate(plain, "finance", contact) === null);
check("happy path trade-in reaches booking", bookingGate(plain, "trade-in", contact) === null);

console.log("\n(FIX 1) presentation lines omit location unless the customer asked");
const LOC_NAMES = ["Lincoln", "Talladega", "Sylacauga", "Anniston"];
const hasLocName = s => LOC_NAMES.some(n => new RegExp(n, "i").test(s));
const presentInv = [
  plain,
  { yr: 2015, mk: "Cadillac", mo: "CTS Luxury 2.0L", pr: 11995, cl: "Gray", lo: "Talladega", mi: 119976, body: "Sedan" },
  { yr: 2015, mk: "Chevy", mo: "Tahoe LT", pr: 17995, cl: "Gold", lo: "Sylacauga", mi: 138200, body: "SUV" },
  { yr: 2019, mk: "Jeep", mo: "Wrangler Unlimited Sahara", pr: 25500, cl: "White", lo: "Anniston", mi: 107223, body: "SUV" },
  { yr: 2019, mk: "Nissan", mo: "Frontier SV", pr: 19500, cl: "Blue", lo: "280", mi: 90000, body: "Truck" },
];
presentInv.forEach(v =>
  check("line hides location (lo=" + v.lo + ")", !hasLocName(vehicleShowLine(v)), vehicleShowLine(v)));
check("hidden-location line keeps 'plus taxes and fees'", /plus taxes and fees/.test(vehicleShowLine(plain)), vehicleShowLine(plain));
check("location shown when the customer asked", /, Lincoln/.test(vehicleShowLine(plain, true)), vehicleShowLine(plain, true));
check("'280' renders as Sylacauga when shown", /, Sylacauga/.test(vehicleShowLine({ ...plain, lo: "280" }, true)));

console.log("\n(FIX 1) loc= marker parsing and location filtering");
check("loc=any -> null", parseShowMarker("SHOW_CARS: type=truck | make=any | model=any | max=none | loc=any").loc === null);
check("loc=Lincoln parsed", parseShowMarker("SHOW_CARS: type=truck | make=any | model=any | max=none | loc=Lincoln").loc === "Lincoln");
check("marker without loc field still parses (loc null)", parseShowMarker("SHOW_CARS: type=car | make=Toyota | model=Camry | max=17000").loc === null);
const lincolnOnly = selectVehicles(presentInv, { loc: "lincoln" });
check("selectVehicles filters by location", lincolnOnly.length === 1 && lincolnOnly[0].lo === "Lincoln", JSON.stringify(lincolnOnly.map(v => v.lo)));
const sylBy280 = selectVehicles(presentInv, { loc: "Sylacauga" });
check("loc filter treats '280' as Sylacauga", sylBy280.length === 2 && sylBy280.every(v => v.lo === "Sylacauga" || v.lo === "280"), JSON.stringify(sylBy280.map(v => v.lo)));

console.log("\n(FIX 1) routing: location-filtered requests show immediately with loc set");
const r1 = classifyRequest("what trucks do you have in Lincoln", presentInv);
check("'trucks in Lincoln' -> show", r1.action === "show", JSON.stringify(r1.signals));
check("'trucks in Lincoln' -> criteria.loc=Lincoln", r1.criteria.loc === "Lincoln", JSON.stringify(r1.criteria));
const r2 = classifyRequest("what do you have at sylacauga", presentInv);
check("'what do you have at sylacauga' -> show with loc", r2.action === "show" && r2.criteria.loc === "Sylacauga", JSON.stringify(r2.criteria));
const r3 = classifyRequest("I need a truck", presentInv);
check("plain broad request still asks, no loc", r3.action === "ask" && r3.criteria.loc === null, JSON.stringify(r3));

console.log("\n(FILTERS) price floor and show-command routing");
check("marker min parsed", parseShowMarker("SHOW_CARS: type=truck | make=any | model=any | max=none | min=30000 | loc=any").min === 30000);
check("marker min=none -> null", parseShowMarker("SHOW_CARS: type=truck | make=any | model=any | max=none | min=none | loc=any").min === null);
const minInv = [
  { mk: "Nissan", mo: "Frontier SV", pr: 19500, lo: "Lincoln", body: "Truck" },
  { mk: "Gmc", mo: "Sierra 1500 Elevation", pr: 34995, lo: "Anniston", body: "Truck" },
  { mk: "Gmc", mo: "Sierra 1500 Denali 6.2L", pr: 36500, lo: "Lincoln", body: "Truck" },
];
const over30 = selectVehicles(minInv, { type: "truck", min: 30000 });
check("min filter keeps only trucks >= $30k, sorted ascending",
  over30.length === 2 && over30[0].pr === 34995 && over30[1].pr === 36500, JSON.stringify(over30.map(v => v.pr)));
const r4 = classifyRequest("show me trucks over $30,000", minInv);
check("'trucks over $30,000' -> show with min=30000", r4.action === "show" && r4.criteria.min === 30000, JSON.stringify(r4.criteria));
const r5 = classifyRequest("show me your trucks", minInv);
check("'show me your trucks' -> show (command, not a question)", r5.action === "show", JSON.stringify(r5.signals));
const r6 = classifyRequest("I need a truck", minInv);
check("'I need a truck' still asks first", r6.action === "ask", JSON.stringify(r6.signals));

console.log("\n(DEAD-END REGRESSION) a scheduling promise always routes through the booking gate");
// Exact reply from the QA transcript that previously dead-ended with no calendar.
check("transcript promise phrase detected",
  SCHED_PROMISE_RE.test("Perfect Al, let me grab the available times for your test drive at our Anniston location!"));
check("'get your test drive scheduled' detected", SCHED_PROMISE_RE.test("Now let me get your test drive scheduled"));
check("'pulling up the times' detected", SCHED_PROMISE_RE.test("Pulling up the times for you now!"));
check("plain reply is not a scheduling promise", !SCHED_PROMISE_RE.test("That one is a great pick, it has low miles for the year."));
// The transcript vehicle is restricted by price, so the gate resolves the promise to the pre-qual redirect, never a booking.
const transcriptTruck = { s: "555001", yr: 2022, mk: "Gmc", mo: "SIERRA 1500 ELEVATION DURMAX DIESEL", pr: 34995, cl: "Silver", lo: "Anniston", mi: 115974, body: "Truck" };
check("transcript truck ($34,995) is restricted -> redirect, not booking",
  bookingGate(transcriptTruck, "trade-in", contact) === "restricted");

console.log("\n(DEAD-END REGRESSION) deterministic pick capture from the customer's own message");
const shownTrucks = [
  { s: "111", yr: 2013, mk: "Gmc", mo: "SIERRA 3500HD CREW CAB FLATBED", pr: 21500, lo: "Talladega" },
  { s: "222", yr: 2018, mk: "Gmc", mo: "SIERRA 1500 CREW CAB SLT 4WD", pr: 24995, lo: "Lincoln" },
  transcriptTruck,
  { s: "444", yr: 2020, mk: "Gmc", mo: "SIERRA 1500 DENALI 6.2L 4WD", pr: 36500, lo: "Lincoln" },
];
const picked = matchVehicleFromText("i want 2022 Gmc SIERRA 1500 ELEVATION DURMAX DIESEL — $34,995 plus taxes and fees, Silver, Anniston, 115,974 miles", shownTrucks);
check("transcript pick message resolves to exactly the 2022 Sierra", picked && picked.s === "555001", JSON.stringify(picked));
check("stock-number reference resolves", matchVehicleFromText("let's do stock 222 please", shownTrucks)?.s === "222");
check("ambiguous mention of two vehicles resolves to none",
  matchVehicleFromText("is the 2022 sierra nicer than the 2020 sierra?", shownTrucks) === null);
check("unrelated message resolves to none", matchVehicleFromText("do you have any vans?", shownTrucks) === null);

console.log("\n" + (failures ? "FAILED: " + failures + " check(s)" : "ALL CHECKS PASSED") + "\n");
process.exit(failures ? 1 : 0);
