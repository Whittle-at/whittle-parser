// 23.10: Veri kalitesi raporu → results/quality-report.md (her crawl'dan sonra, workflow'da).
// Amaç: "deneyim yanlış", "saat yok" gibi sezgileri her gün ölçülebilir sayıya çevirmek.
// İlan METNİ rapora girmez (repo public) – sadece alan değerleri, şirket adı ve ilan linki.
// Kullanım: node quality-audit.js [results/whittle-import-YYYY-MM-DD-combined.json]
const fs = require('fs');
const path = require('path');

const file = process.argv[2] || fs.readdirSync('results').filter(f => /^whittle-import-\d{4}-\d{2}-\d{2}-combined\.json$/.test(f)).sort().map(f => path.join('results', f)).pop();
if(!file || !fs.existsSync(file)){ console.log('quality-audit: combined dosyası yok, atlandı'); process.exit(0); }
const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
const items = Array.isArray(raw) ? raw : (raw.items || []);
const N = items.length || 1;
const pct = (a, b = N) => b ? Math.round(a / b * 100) + ' %' : '–';
const co = it => it.companyName || it._company || '?';
const est = (it, k) => Array.isArray(it.estimated) && it.estimated.includes(k);
const known = (it, k) => it[k] != null && it[k] !== '' && !est(it, k);

// Saat: sitedeki parseHours ile aynı kalıp (kısaltılmış)
const HRS_RE = /(\d{1,2}(?:[,.]\d)?)\s*(?:(?:-|–|bis|to)\s*\d{1,2}(?:[,.]\d)?)?\s*(?:wochenstunden|wochenstd|stunden\s*(?:\/|pro|je|in der|die|per|a)\s*woche|std\.?\s*(?:\/|pro|je)?\s*(?:woche|wo\.)|h\s*\/\s*(?:woche|wo\.?|week|wk)|hours?\s*(?:per|\/|a)\s*week)/i;
const hasHours = it => (Array.isArray(it.hrs) && Number(it.hrs[0]) > 0) || HRS_RE.test((it._hoursText || '') + ' ' + (it._salaryText || '') + ' ' + (it._rawText || ''));
const MONEY_RE = /(?:€|\beur(?:o)?\b)\s*(?:brutto|gross|ab|from)?\s*\d|\d[\d.,\s]*\s*(?:€|\beur(?:o)?\b)/i;
const hasSalaryText = it => MONEY_RE.test(it._salaryText || '');
const euroInText = it => /€|\bEUR\b|\bEuro\b/i.test((it._salaryText || '') + ' ' + (it._rawText || ''));

const fields = ['deg', 'de', 'en', 'exp'];
const cov = Object.fromEntries(fields.map(k => [k, { known: 0, evidence: 0 }]));
let sal = 0, eur = 0, hrs = 0, emp = 0, shortText = 0, time = 0, nonLehre = 0;
// 25.10: "Arbeitszeit bekannt" = Stundenzahl ODER Voll-/Teilzeit/geringfügig (Lehre zählt nicht mit – für Studierende irrelevant)
const TIME_EMP = new Set(['vollzeit', 'teilzeit', 'geringfuegig']);
const per = {};
for(const it of items){
  for(const k of fields){ if(known(it, k)) cov[k].known++; if(it.evidence && it.evidence[k]) cov[k].evidence++; }
  const s = hasSalaryText(it), e = euroInText(it), h = hasHours(it), L = (it._rawText || '').length;
  const isLehre = Array.isArray(it.emp) && it.emp.includes('lehre');
  if(!isLehre){ nonLehre++; if(h || (Array.isArray(it.emp) && it.emp.some(x => TIME_EMP.has(x)))) time++; }
  if(s) sal++; if(e) eur++; if(h) hrs++; if(Array.isArray(it.emp) && it.emp.length && !est(it, 'emp')) emp++; if(L < 600) shortText++;
  const c = co(it); per[c] = per[c] || { n: 0, sal: 0, hrs: 0, len: 0, exp: 0 };
  per[c].n++; if(s) per[c].sal++; if(h) per[c].hrs++; per[c].len += L; if(known(it, 'exp')) per[c].exp++;
}

// Rastgele 25 ilanlık elle kontrol listesi (her gün farklı, ama aynı gün aynı)
let seed = Number(String(file).replace(/\D/g, '').slice(-8)) || 1;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const sample = items.slice().sort(() => rnd() - 0.5).slice(0, 25);
const LV = ['–', 'A2', 'B1', 'B2', 'C1'], EXP = ['keine', '1–2 J.', '3–5 J.', '5+ J.'], DEG = ['–', 'Matura/Lehre', 'Bachelor lfd.', 'Bachelor', 'Master'];
const show = (it, k, arr) => it[k] == null || it[k] === '' ? '?' : (est(it, k) ? '~' : '') + (arr[Number(it[k])] ?? it[k]) + (it.evidence && it.evidence[k] ? '' : '*');

const rows = Object.entries(per).filter(([, v]) => v.n >= 5)
  .map(([c, v]) => ({ c, n: v.n, sal: v.sal / v.n, hrs: v.hrs / v.n, len: Math.round(v.len / v.n), exp: v.exp / v.n }));
const worst = (key) => rows.slice().sort((a, b) => a[key] - b[key] || b.n - a.n).slice(0, 12);

const md = [
  `# Veri kalitesi – ${path.basename(file)}`, '',
  `${items.length} ilan · ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`, '',
  '## Kapsama', '',
  '| Alan | Değer var | Kural kanıtı (evidence) var |', '|---|---|---|',
  ...fields.map(k => `| ${{ deg: 'Abschluss', de: 'Deutsch', en: 'Englisch', exp: 'Erfahrung' }[k]} | ${pct(cov[k].known)} | ${pct(cov[k].evidence)} |`),
  `| Maaş cümlesi bulundu | ${pct(sal)} | metinde € geçen: ${pct(eur)} |`,
  `| Wochenstunden (Zahl) | ${pct(hrs)} | |`,
  `| Arbeitszeit bekannt (Zahl oder Voll-/Teilzeit, ohne Lehre) | ${pct(time, nonLehre)} | |`,
  `| Beschäftigungsart (emp) | ${pct(emp)} | |`,
  `| Kısa metin (<600 karakter, fetcher detay sayfasını açmıyor olabilir) | ${pct(shortText)} | |`, '',
  '## En kötü şirketler (≥5 ilan)', '',
  '**Maaş:**', '', '| Şirket | İlan | Maaş | Ort. metin |', '|---|---|---|---|',
  ...worst('sal').map(r => `| ${r.c} | ${r.n} | ${pct(r.sal * 100, 100)} | ${r.len} |`), '',
  '**Saat:**', '', '| Şirket | İlan | Saat | Ort. metin |', '|---|---|---|---|',
  ...worst('hrs').map(r => `| ${r.c} | ${r.n} | ${pct(r.hrs * 100, 100)} | ${r.len} |`), '',
  '## Elle kontrol listesi (25 rastgele ilan)', '',
  'İlanı aç, alanları kontrol et. `~` = tahmini (şablondan), `*` = kural kanıtı yok (AI), `?` = bilinmiyor.', '',
  '| İlan | Şirket | Deutsch | Englisch | Erfahrung | Abschluss | Saat |', '|---|---|---|---|---|---|---|',
  ...sample.map(it => `| [${String(it.title || '').replace(/\|/g, '/').slice(0, 60)}](${it.externalUrl || ''}) | ${co(it)} | ${show(it, 'de', LV)} | ${show(it, 'en', LV)} | ${show(it, 'exp', EXP)} | ${show(it, 'deg', DEG)} | ${hasHours(it) ? '✓' : '–'} |`),
  '',
];
fs.writeFileSync('results/quality-report.md', md.join('\n'));
console.log(`quality-audit: ${items.length} ilan · maaş ${pct(sal)} · saat ${pct(hrs)} · exp bilinen ${pct(cov.exp.known)} → results/quality-report.md`);
