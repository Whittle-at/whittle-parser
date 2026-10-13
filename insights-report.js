// insights-report.js — "Listing Insights" örnek raporu (03.10)
//
// Bir işverene "senin ilanların piyasada nerede duruyor" raporu üretir — LOI görüşmelerinde göstermek için.
// Sadece herkese açık ilanlardan çıkan istatistik; başka şirket İSMİ geçmez (sadece piyasa ortalaması).
//
// Kullanım:  node insights-report.js "KPMG"            → results/insights-kpmg.md
//            node insights-report.js "KPMG" 2026-10-03 → o günün dosyasıyla
const fs = require('fs');
const path = require('path');
const { buildMarketStats, monthlyFullTime, langRank } = require('./market-stats');
const { CATEGORIES } = (() => { try { return require('./ai-fields'); } catch (e) { return {}; } })();

const name = process.argv[2];
if (!name) { console.log('Kullanım: node insights-report.js "Şirket adı" [YYYY-AA-GG]'); process.exit(1); }
const outDir = path.join(__dirname, 'results');
const files = fs.readdirSync(outDir).filter(f => /^whittle-import-\d{4}-\d{2}-\d{2}-combined\.json$/.test(f)).sort();
const want = process.argv[3] ? `whittle-import-${process.argv[3]}-combined.json` : files[files.length - 1];
const load = f => JSON.parse(fs.readFileSync(path.join(outDir, f), 'utf8'));
const today = load(want), items = today.items || [], date = want.slice(15, 25);

const low = name.toLowerCase();
const mine = items.filter(it => String(it.companyName || '').toLowerCase() === low);
const mine2 = mine.length ? mine : items.filter(it => String(it.companyName || '').toLowerCase().includes(low));
if (!mine2.length) { console.log(`"${name}" için ${date} tarihli dosyada ilan yok.`); process.exit(1); }
const coName = mine2[0].companyName;
const M = buildMarketStats(items, CATEGORIES || {});

// İlanların açık kalma süresi: tüm geçmiş combined dosyalarında ilk ve son görüldüğü gün.
const seen = new Map(); // url → {first, last, co, cat}
for (const f of files.filter(f => f <= want)) {
  const d = f.slice(15, 25);
  let data; try { data = load(f); } catch (e) { continue; }
  for (const it of data.items || []) {
    if (!it.externalUrl) continue;
    const r = seen.get(it.externalUrl) || { first: d, last: d, co: it.companyName, cat: it.aiCat };
    r.last = d; if (it.aiCat) r.cat = it.aiCat; seen.set(it.externalUrl, r);
  }
}
const days = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);
const closed = [...seen.values()].filter(r => r.last < date && r.first > files[0].slice(15, 25)); // ilk gün zaten açık olanlar hariç
const avg = a => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null;
const closedMine = closed.filter(r => r.co === coName).map(r => days(r.first, r.last) + 1);
const pc = v => v == null ? '–' : Math.round(v * 100) + ' %';
const eur = v => v == null ? '–' : '€ ' + Math.round(v).toLocaleString('de-AT');

// Kategori bazında karşılaştırma (şirketin en çok ilanı olan 3 alanı)
const catCount = {}; mine2.forEach(it => { if (it.aiCat && it.aiCat !== 'none') catCount[it.aiCat] = (catCount[it.aiCat] || 0) + 1; });
const topCats = Object.entries(catCount).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k);
const statsOf = arr => {
  const n = arr.length, sal = arr.map(it => monthlyFullTime(it._salaryText)).filter(Boolean).sort((a, b) => a - b);
  const text = it => String(it._adText || it._rawText || '').toLowerCase();
  const de = arr.filter(it => langRank(text(it), 'deutsch|german') >= 4).length / n;
  const expArr = arr.filter(it => it.exp != null), exp = expArr.length ? expArr.filter(it => Number(it.exp) >= 1).length / expArr.length : null;
  return { n, de, exp, med: sal.length ? sal[sal.length >> 1] : null, salN: sal.length };
};

const L = [];
L.push(`# Listing Insights — ${coName}`, '', `Stand: ${date} · Quelle: öffentliche Stellenanzeigen auf Karriereseiten von ~100 Arbeitgebern in Österreich, ausgewertet von Whittle (whittle.at).`, '');
L.push(`## Überblick`, '', `- Aktive Anzeigen: **${mine2.length}** (davon für Studierende/Einsteiger: ${mine2.filter(it => /praktik|intern|trainee|werkstudent|student|junior|graduate/i.test(it.title || '')).length})`);
if (closedMine.length >= 3 && days(files[0].slice(15, 25), date) >= 21) L.push(`- Durchschnittliche Laufzeit geschlossener Anzeigen: **${avg(closedMine)} Tage** (Markt: ${avg(closed.map(r => days(r.first, r.last) + 1))} Tage)`);
L.push('');
for (const cat of topCats) {
  const label = (CATEGORIES && CATEGORIES[cat]) || cat;
  const a = statsOf(mine2.filter(it => it.aiCat === cat)), m = statsOf(items.filter(it => it.aiCat === cat && it.companyName !== coName));
  const mc = M.cats[cat] || {};
  L.push(`## ${label}`, '', `${a.n} Anzeigen von ${coName} · ${m.n} vergleichbare Anzeigen anderer Arbeitgeber`, '');
  L.push('| | ' + coName + ' | Markt |', '| --- | --- | --- |');
  L.push(`| Median-Gehalt (Vollzeit, brutto/Monat) | ${a.salN >= 2 ? eur(a.med) : '–'} | ${eur(m.med)}${mc.sal && mc.sal.p25 ? ` (mittlere Hälfte ${eur(mc.sal.p25)}–${eur(mc.sal.p75)})` : ''} |`);
  L.push(`| Deutsch B2+ verlangt | ${pc(a.de)} | ${pc(m.de)} |`);
  L.push(`| Berufserfahrung verlangt | ${pc(a.exp)} | ${pc(m.exp)} |`);
  if (mc.sk) L.push(`| Häufigste Anforderungen im Markt | | ${Object.keys(mc.sk).slice(0, 5).join(', ')} |`);
  L.push('');
}
L.push('## Was das bedeutet', '', '- [Hier 2–3 Sätze: z. B. "Ihre Praktika zahlen 8 % unter dem Markt, verlangen aber häufiger Deutsch C1 – das verkleinert den Bewerberpool."]', '');
L.push('_Methodik: Gehälter auf Vollzeit (38,5 h) umgerechnet; nur Anzeigen mit Gehaltsangabe. Keine Daten über Bewerber:innen, keine Namen anderer Arbeitgeber._');

const md = L.join('\n') + '\n';
const out = path.join(outDir, `insights-${coName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}.md`);
fs.writeFileSync(out, md);
console.log(md);
console.log(`→ ${out}`);
