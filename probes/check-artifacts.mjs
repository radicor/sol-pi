import fs from "node:fs";

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

const lh = (r.activation.EvidencePreservingReducer.costSaved * 100).toFixed(1);
const lhM = html.match(/−([0-9.]+)% cost on long-horizon/);
chk("explainer long-horizon pill", lhM?.[1], lh);

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
