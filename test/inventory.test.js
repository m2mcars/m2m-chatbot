#!/usr/bin/env node
/* Deterministic unit tests for the inventory selection/ordering and request routing.
   These exercise the SAME pure functions used at runtime in index.html (extracted below),
   so a pass here proves the behavior without relying on chat/model variance.
   Run: node test/inventory.test.js */
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

function grab(re, label) {
  const m = src.match(re);
  if (!m) throw new Error("Could not extract " + label + " from index.html");
  return m[0];
}

// Pull the pure-function block (it ends by assigning module.exports) and load it.
const pureBlock = grab(
  /const TYPE_TO_BODIES=[\s\S]*?module\.exports=\{[^}]*\};\}/,
  "pure inventory functions"
);
const mod = { exports: {} };
new Function("module", "exports", pureBlock)(mod, mod.exports);
const { selectVehicles, parseShowMarker, vehicleShowLine, critKey, pageVehicles, classifyRequest } = mod.exports;

// Build a realistic inventory for classifyRequest's make/model vocabulary,
// plus a synthetic, deliberately price-scrambled set to prove sorting.
const inv = [
  // CARS (Sedan/Sports) - scrambled prices
  { mk: "Toyota", mo: "Camry SE", pr: 15995, body: "Sedan" },
  { mk: "Toyota", mo: "Camry LE", pr: 12995, body: "Sedan" },
  { mk: "Cadillac", mo: "CTS Luxury", pr: 11995, body: "Sedan" },
  { mk: "Ford", mo: "Mustang GT 5.0L", pr: 28750, body: "Sports" },
  { mk: "Chevy", mo: "Camaro 2LT", pr: 23500, body: "Sports" },
  // TRUCKS - the exact regression shape from QA ($24,995 -> $33,500 -> $30,495 -> $49,999)
  { mk: "Chevy", mo: "Silverado LT", pr: 24995, body: "Truck" },
  { mk: "GMC", mo: "Sierra Denali", pr: 33500, body: "Truck" },
  { mk: "Chevy", mo: "Silverado RST", pr: 30495, body: "Truck" },
  { mk: "Ford", mo: "F150 Raptor", pr: 49999, body: "Truck" },
  { mk: "Nissan", mo: "Frontier SV", pr: 19500, body: "Truck" },
  { mk: "Nissan", mo: "Frontier S", pr: 17995, body: "Truck" },
  // SUVS - scrambled
  { mk: "Chevy", mo: "Tahoe LT", pr: 21500, body: "SUV" },
  { mk: "Honda", mo: "CR-V EXL", pr: 22950, body: "SUV" },
  { mk: "Chevy", mo: "Tahoe LS", pr: 17995, body: "SUV" },
  { mk: "Cadillac", mo: "Escalade", pr: 25995, body: "SUV" },
  // VAN
  { mk: "Honda", mo: "Odyssey EX", pr: 18995, body: "Van" },
];

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log("  PASS  " + name); }
  else { failures++; console.log("  FAIL  " + name + (detail ? "  -> " + detail : "")); }
}
function isAscending(list) {
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1].pr > 0 ? list[i - 1].pr : Infinity;
    const b = list[i].pr > 0 ? list[i].pr : Infinity;
    if (b < a) return false;
  }
  return true;
}
function prices(list) { return list.map(v => v.pr).join(", "); }

console.log("\n(a) SELECTION + PRICE-ASCENDING SORT across categories and make/model");

const cars = selectVehicles(inv, { type: "car" });
check("cars: price ascending", isAscending(cars), prices(cars));
check("cars: only sedans/coupes/sports", cars.every(v => v.body === "Sedan" || v.body === "Sports"));

const trucks = selectVehicles(inv, { type: "truck" });
check("trucks: price ascending (the QA regression case)", isAscending(trucks), prices(trucks));
check("trucks: only trucks", trucks.every(v => v.body === "Truck"));
check("trucks: cheapest first is the $17,995 Frontier", trucks[0] && trucks[0].pr === 17995, prices(trucks));

const suvs = selectVehicles(inv, { type: "suv" });
check("suvs: price ascending", isAscending(suvs), prices(suvs));
check("suvs: only suvs", suvs.every(v => v.body === "SUV"));

const silverados = selectVehicles(inv, { model: "silverado" });
check("make/model (Silverado): price ascending", isAscending(silverados), prices(silverados));
check("make/model (Silverado): only silverados", silverados.every(v => /silverado/i.test(v.mo)));
check("make/model (Silverado): cheaper one leads ($24,995 before $30,495)",
  silverados.length === 2 && silverados[0].pr === 24995 && silverados[1].pr === 30495, prices(silverados));

const frontiers = selectVehicles(inv, { model: "frontier" });
check("make/model (Frontier): $17,995 before $19,500 (QA inversion case)",
  frontiers.length === 2 && frontiers[0].pr === 17995 && frontiers[1].pr === 19500, prices(frontiers));

const toyotas = selectVehicles(inv, { make: "toyota" });
check("make (Toyota): price ascending", isAscending(toyotas), prices(toyotas));
check("make (Toyota): only toyotas", toyotas.every(v => /toyota/i.test(v.mk)));

const carsUnder16k = selectVehicles(inv, { type: "car", max: 16000 });
check("car + max=16000: all within budget", carsUnder16k.every(v => v.pr <= 16000), prices(carsUnder16k));
check("car + max=16000: price ascending", isAscending(carsUnder16k), prices(carsUnder16k));

const any = selectVehicles(inv, { type: "any" });
check("type=any: returns whole inventory, price ascending", any.length === inv.length && isAscending(any), prices(any));

// "sporty" must reach actual sports/muscle cars, not the cheapest economy
// sedans. type=sports filters to Sports bodies only (e.g. Mustang, Camaro) —
// the capability the SHOW_CARS marker now exposes to the model.
const sports = selectVehicles(inv, { type: "sports" });
check("type=sports: only Sports-body cars", sports.length > 0 && sports.every(v => v.body === "Sports"), prices(sports));
check("type=sports: excludes economy sedans", !sports.some(v => v.body === "Sedan"), sports.map(v => v.mo).join(", "));
check("type=sports: price ascending", isAscending(sports), prices(sports));
check("type=sports: differs from type=car (sedans dropped)",
  selectVehicles(inv, { type: "car" }).some(v => v.body === "Sedan") && !sports.some(v => v.body === "Sedan"));

console.log("\n(b) marker parsing feeds selection correctly");
const crit = parseShowMarker("SHOW_CARS: type=truck | make=any | model=Silverado | max=none");
check("parseShowMarker: type", crit.type === "truck");
check("parseShowMarker: make=any -> null", crit.make === null);
check("parseShowMarker: model", crit.model === "Silverado");
check("parseShowMarker: max=none -> null", crit.max === null);
const crit2 = parseShowMarker("SHOW_CARS: type=car | make=Toyota | model=Camry | max=17000");
check("parseShowMarker: numeric max", crit2.max === 17000);
const crit3 = parseShowMarker("SHOW_CARS: type=sports | make=any | model=any | max=none | min=none | loc=any");
check("parseShowMarker: type=sports passes through", crit3.type === "sports");
check("parseShowMarker: type=sports feeds selection to Sports only",
  selectVehicles(inv, crit3).every(v => v.body === "Sports"));

console.log("\n(c) ROUTING: specific/superlative -> show, vague -> ask");
const showCases = ["cheapest car", "cheapest truck you have", "most affordable SUV",
  "a Camry under $17k", "2020 or newer Silverado", "an SUV under 20k", "show me trucks under 30000"];
const askCases = ["a good car", "I need a truck", "something reliable", "an SUV", "what do you have"];
showCases.forEach(t => check('show: "' + t + '"', classifyRequest(t, inv).action === "show", JSON.stringify(classifyRequest(t, inv).signals)));
askCases.forEach(t => check('ask:  "' + t + '"', classifyRequest(t, inv).action === "ask", JSON.stringify(classifyRequest(t, inv).signals)));

console.log("\n(d) rendered line is plain text (no emoji/cards) and includes price + taxes/fees");
const line = vehicleShowLine({ yr: 2015, mk: "Cadillac", mo: "CTS Luxury", pr: 11995, cl: "Gray", lo: "Talladega", mi: 119976 });
check("vehicleShowLine: has 'plus taxes and fees'", /plus taxes and fees/.test(line), line);
check("vehicleShowLine: no emoji/pin", !/[📍⭐🚗💰]/.test(line), line);

console.log("\n(e) STYLE/ENGINE MAPPING + NO-MATCH (never a silent cheapest dump)");
// Style categories must reach actual sports/muscle cars.
["sporty", "muscle", "performance", "sport"].forEach(term => {
  const r = selectVehicles(inv, { type: term });
  check(`style term "${term}" -> Sports cars only`, r.length > 0 && r.every(v => v.body === "Sports"), r.map(v => v.mo).join(", "));
});
// Engine type (V6/V8) is NOT in the inventory data: a marker that tries to
// filter by it must yield NO matches (so the caller shows an honest no-match),
// never a silently price-sorted full list.
["v6", "v8", "fourcylinder", "diesel"].forEach(term => {
  const r = selectVehicles(inv, { type: term });
  check(`unsupported engine/type "${term}" -> 0 matches, not the cheap default`, r.length === 0, prices(r));
});
check("no-match does NOT fall back to the full inventory", selectVehicles(inv, { type: "v6" }).length !== inv.length);
check("type=any still returns everything (not treated as unknown)", selectVehicles(inv, { type: "any" }).length === inv.length);

console.log("\n(f) PAGINATION: 'show more' advances, then reports end-of-list");
const sportsAll = selectVehicles(inv, { type: "sports" }); // 2 in this inv: Camaro 23500, Mustang 28750
check("sports pool has the expected 2 cars", sportsAll.length === 2, prices(sportsAll));
const big = selectVehicles(inv, { type: "truck" }); // 6 trucks -> needs 2 pages at size 4
check("truck pool spans more than one page", big.length > 4, prices(big));
const p1 = pageVehicles(big, 0, 4);
check("page 1: first 4, more remain", p1.items.length === 4 && p1.hasMore === true && p1.nextOffset === 4);
const p2 = pageVehicles(big, p1.nextOffset, 4);
check("page 2: the NEXT vehicles, not a repeat", p2.items.length === big.length - 4 && p2.items.every(v => !p1.items.includes(v)), prices(p2.items));
check("page 2: no more pages left", p2.hasMore === false);
const p3 = pageVehicles(big, p2.nextOffset, 4);
check("paging past the end returns empty + end flag (say 'that is everything')", p3.items.length === 0 && p3.end === true);
check("fresh empty query is NOT flagged as end-of-list (it is a no-match)", pageVehicles([], 0, 4).end === false);

// critKey: same search repeats (=> paginate), changed search restarts (=> page 0).
const kA = critKey(parseShowMarker("SHOW_CARS: type=truck | make=any | model=any | max=none | min=none | loc=any"));
const kA2 = critKey(parseShowMarker("SHOW_CARS: type=truck | make=any | model=any | max=none | min=none | loc=any"));
const kB = critKey(parseShowMarker("SHOW_CARS: type=suv | make=any | model=any | max=none | min=none | loc=any"));
check("critKey: identical search -> identical key (more = paginate)", kA === kA2);
check("critKey: different search -> different key (restart at page 1)", kA !== kB);

console.log("\n" + (failures ? "FAILED: " + failures + " check(s)" : "ALL CHECKS PASSED") + "\n");
process.exit(failures ? 1 : 0);
