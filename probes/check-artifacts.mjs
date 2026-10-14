import fs from "node:fs";
import { rustcLog } from "../src/tasks/corpus.js";

const r = JSON.parse(fs.readFileSync("research-results.json", "utf8"));
const rows = new Map(r.table.map((t) => [t.id, t]));
const base = rows.get("pi-baseline");
let ok = true;

const chk = (label, got, want) => {
  if (String(got) !== String(want)) {
    ok = false;
    console.log(`MISMATCH ${label}: artifact=${got} json=${want}`);
  }
};

const esc = (s) => s.replace(/[.*+?^$|[\](){}]/g, "\\$&");

// README row layout: id  score  traffic  cost  solved/total  tokEff  vsBase
const md = fs.readFileSync("README.md", "utf8");
for (const [id, t] of rows) {
  const re = new RegExp(
    `^${esc(id)}\\s+([0-9.]+)\\s+([0-9.]+)\\s+([0-9.]+)\\s+([0-9]+)/([0-9]+)\\s+([0-9.]+)\\s+(\\S+).*$`,
    "m",
  );
  const m = md.match(re);
  if (!m) {
    ok = false;
    console.log("MISSING README row: " + id);
    continue;
  }
  chk(`${id} score`, m[1], t.aggregateScore.toFixed(3));
  chk(`${id} traffic`, m[2], (t.tokenTraffic / 1e6).toFixed(4));
  chk(`${id} cost`, m[3], t.cost.toFixed(2));
  chk(`${id} solved`, `${m[4]}/${m[5]}`, `${t.solved}/${t.total}`);
  chk(`${id} tokEff`, m[6], t.tokenEfficiency.toFixed(4));
  const want = id === "pi-baseline" ? "--" : (((base.cost - t.cost) / base.cost * 100).toFixed(1) + "%");
  chk(`${id} vsBase`, m[7], want);
}

// Explainer row layout: <tr><td>id</td><td>traffic</td><td>cost</td><td>score</td><td>vs</td></tr>
// The table's vs. column is unsigned by design; the bar chart carries the minus.
const html = fs.readFileSync("sol-pi-explainer.html", "utf8");
for (const [id, t] of rows) {
  const re = new RegExp(
    `<tr(?:\\s[^>]*)?><td>${esc(id)}</td><td>([0-9.]+)</td><td>([0-9.]+)</td><td>([0-9.]+)</td>(?:<td[^>]*>([^<]*)</td>)?</tr>`,
  );
  const m = html.match(re);
  if (!m) {
    ok = false;
    console.log("MISSING explainer row: " + id);
    continue;
  }
  chk(`explainer ${id} traffic`, m[1], (t.tokenTraffic / 1e6).toFixed(4));
  chk(`explainer ${id} cost`, m[2], t.cost.toFixed(2));
  chk(`explainer ${id} score`, m[3], t.aggregateScore.toFixed(3));
  if (id !== "pi-baseline") {
    // The table's vs. column is unsigned; only a negative saving carries a sign,
    // rendered with the typographic minus.
    const p = (base.cost - t.cost) / base.cost * 100;
    chk(`explainer ${id} vsBase`, m[4], p < 0 ? `−${Math.abs(p).toFixed(1)}%` : `${p.toFixed(1)}%`);
  }
}

const headPct = ((base.cost - rows.get("+evidence-reducer").cost) / base.cost * 100).toFixed(1);
const headM = html.match(/−([0-9.]+)%<\/div><div class="k">prototype token cost/);
chk("explainer headline", headM?.[1], headPct);

// Mechanism-card pills: each card must quote its own mechanism's measured figures.
// The ObservationPack card must not carry the Reducer's long-horizon saving (the
// N-2 mislabel class), and the compact card's traffic pill must track the search table.
const card = (cls) => {
  const start = html.indexOf(`class="mech ${cls}"`);
  const end = html.indexOf('class="mech ', start + 1);
  return html.slice(start, end === -1 ? html.length : end);
};
const lhPct = (name) => (r.activation[name].costSaved * 100).toFixed(1);
const oc = rows.get("+online-compact");
chk(
  "explainer compact traffic pill",
  card("m2").match(/prototype: −([0-9.]+)% traffic/)?.[1],
  (((base.tokenTraffic - oc.tokenTraffic) / base.tokenTraffic) * 100).toFixed(1),
);
chk(
  "explainer ObservationPack long-horizon pill",
  card("m3").match(/−([0-9.]+)% cost on long-horizon/)?.[1],
  lhPct("ObservationPack"),
);
chk(
  "explainer Reducer long-horizon pill",
  card("m4").match(/−([0-9.]+)% cost on long-horizon/)?.[1],
  lhPct("EvidencePreservingReducer"),
);

// The honest-differences extractor bullet must quote the measured coverage gap
// from the JSON and the corpus, so the limitation cannot drift into a hedge.
const gap = r.activation.reducerUnrecognisedFormat;
if (!gap) {
  ok = false;
  console.log("MISSING activation.reducerUnrecognisedFormat in research-results.json");
} else {
  const fbM = md.match(/(\d+) unrecognised-format fallbacks/);
  chk("README gap fallbacks", fbM?.[1], gap.stats.unrecognisedFormatFallbacks);
  const csM = md.match(/saves \*\*exactly ([0-9.]+)\*\*\s+cost/);
  chk("README gap costSaved", csM?.[1], gap.costSaved);
  const bytesM = md.match(/([0-9,]+)-byte rustc warnings log/);
  chk("README gap log bytes", bytesM?.[1], rustcLog().length.toLocaleString("en-US"));
}

// Every non-baseline candidate appears once in the bar chart, at the right value
const barStart = html.indexOf("Cost saved vs. baseline");
const barEnd = html.indexOf("Cross-model transfer");
const barBlock = html.slice(barStart, barEnd);
const barIds = [...barBlock.matchAll(/<div class="lbl">([^<]+)<\/div>/g)].map((m) => m[1]);
const expected = [...rows.keys()].filter((id) => id !== "pi-baseline").sort();
if (JSON.stringify([...barIds].sort()) !== JSON.stringify(expected)) {
  ok = false;
  console.log(`MISMATCH explainer bars: got ${JSON.stringify(barIds)} expected ${JSON.stringify(expected)}`);
}
for (const id of barIds) {
  const t = rows.get(id);
  const p = Math.abs((base.cost - t.cost) / base.cost * 100).toFixed(1);
  const re = new RegExp(`<div class="lbl">${esc(id)}</div>[\\s\\S]*?−${p}%</div>`);
  if (!re.test(barBlock)) {
    ok = false;
    console.log(`MISMATCH explainer bar ${id}: expected −${p}%`);
  }
}

console.log(
  ok
    ? `OK: README + explainer match research-results.json (${rows.size} rows, ${barIds.length} bars)`
    : "DIVERGED",
);
process.exitCode = ok ? 0 : 1;
