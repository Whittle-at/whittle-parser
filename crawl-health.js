// crawl-health.js — günlük tarama sağlık raporu (03.10)
//
// merge-results.js'ten sonra çalışır. Bugünkü combined dosyasını son günlerinkiyle karşılaştırır ve
// "bozulmuş olabilir" şirketleri bulur:
//   • bugün 0 ilan getiren ama son göründüğü gün ilanı olan şirketler
//   • ilan sayısı birden %60'tan fazla düşenler (önceden en az 10 ilan)
//   • ilanlarının %30'undan fazlasında metin boş/çok kısa olanlar (okuyucu metni alamıyor)
// Çıktı:
//   1) results/crawl-health.md (repoya commit'leniyor)
//   2) GitHub Actions çalıştırma sayfasındaki özet (GITHUB_STEP_SUMMARY)
//   3) Sorun varsa GitHub'da "Crawl sağlık raporu" adlı TEK bir issue açılır / yorum eklenir →
//      GitHub sana e-posta bildirimi gönderir. Sorun yoksa hiçbir şey gönderilmez.
// Hiçbir şey siteye gitmez; rapor sadece senin için.
const fs = require('fs');
const path = require('path');

const outDir = path.join(__dirname, 'results');
const dateStr = process.argv[2] || new Date().toISOString().slice(0, 10);
const load = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } };
const combinedFiles = fs.readdirSync(outDir).filter(f => /^whittle-import-\d{4}-\d{2}-\d{2}-combined\.json$/.test(f)).sort();
const todayFile = `whittle-import-${dateStr}-combined.json`;
const today = load(path.join(outDir, todayFile));
if (!today) { console.log(`ℹ️  ${todayFile} yok — sağlık raporu atlandı.`); process.exit(0); }

// Son 6 günün dosyaları: tarayıcı şirketleri 2 günde bir taranıyor, o yüzden "son göründüğü gün"e bakılıyor.
const prevFiles = combinedFiles.filter(f => f < todayFile).slice(-6).reverse();
const prevs = prevFiles.map(f => ({ date: f.slice(15, 25), data: load(path.join(outDir, f)) })).filter(x => x.data);
// 06.10: "son görülen gün" yerine son 6 günün EN İYİ günüyle karşılaştırılıyor. Eskiden bir şirket bir gün 0'a düşüp
// ertesi gün de 0 gelince (RBI, Uni Wien 03.10'dan beri) "önceden de 0'dı" sayılıp rapordan kayboluyordu.
const lastSeen = name => {
  let best = null;
  for (const p of prevs) { const c = (p.data.perCompany || []).find(x => x.name === name && !x.retired); if (c && (!best || (c.rawCount || 0) > (best.rawCount || 0))) best = { date: p.date, ...c }; }
  return best;
};

const items = today.items || [];
const byCo = new Map();
for (const it of items) {
  const k = it.companyName || '?', r = byCo.get(k) || { n: 0, short: 0 };
  r.n++; if (String(it._rawText || '').trim().length < 150) r.short++;
  byCo.set(k, r);
}

const zero = [], drop = [], shortText = [];
// 06.10: "mode": "office" şirketleri 06.10'dan itibaren bilerek filtreleniyor — o tarihten önceki (filtresiz) sayılarla karşılaştırma yapılmıyor.
const officeCos = new Set(); for (const f of ['companies.json', 'problem-companies.json']) { try { JSON.parse(fs.readFileSync(path.join(__dirname, f), 'utf8')).forEach(c => { if (c.mode === 'office') officeCos.add(c.name); }); } catch (e) {} }
for (const c of today.perCompany || []) {
  if (c.retired) continue; // 05.10: listeden çıkarılan şirket (eski ilanlarını kapatmak için duruyor)
  let prev = lastSeen(c.name);
  if (prev && officeCos.has(c.name) && prev.date < '2026-10-06') prev = null;
  const raw = c.rawCount || 0;
  if (raw === 0 && prev && (prev.rawCount || 0) > 0) zero.push(`${c.name}: bugün 0 (son 6 günün en iyisi ${prev.date}: ${prev.rawCount})`);
  else if (prev && (prev.rawCount || 0) >= 10 && raw < prev.rawCount * 0.4) drop.push(`${c.name}: ${prev.rawCount} → ${raw} (en iyi gün ${prev.date})`);
}
for (const [name, r] of byCo) if (r.n >= 5 && r.short / r.n > 0.3) shortText.push(`${name}: ${r.short}/${r.n} ilanda metin boş ya da çok kısa`);

const prevTotal = prevs[0] ? (prevs[0].data.items || []).length : null;
const lines = [
  `# Crawl sağlık raporu — ${dateStr}`, '',
  `Toplam ilan: **${items.length}**${prevTotal != null ? ` (önceki dosya ${prevs[0].date}: ${prevTotal})` : ''} · taranan şirket: ${(today.perCompany || []).length}`, '',
];
const section = (title, arr) => { lines.push(`## ${title} (${arr.length})`, ''); lines.push(...(arr.length ? arr.map(x => `- ${x}`) : ['- yok'])); lines.push(''); };
section('Bugün 0 ilan getiren (önceden ilanı vardı)', zero);
section('İlan sayısı sert düşen', drop);
section('Metni okunamayan', shortText);
lines.push('_0 ilan getiren şirketlerin ilanları sitede kapanmıyor; sadece yenileri gelmiyor._');
const md = lines.join('\n');
fs.writeFileSync(path.join(outDir, 'crawl-health.md'), md + '\n');
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
const problems = zero.length + drop.length + shortText.length;
console.log(`🩺 Sağlık raporu: ${problems} sorun (0 ilan: ${zero.length}, sert düşüş: ${drop.length}, kısa metin: ${shortText.length}) → results/crawl-health.md`);

// GitHub issue (e-posta bildirimi için). Token yoksa ya da sorun yoksa atlanıyor.
(async () => {
  const token = process.env.GITHUB_TOKEN, repo = process.env.GITHUB_REPOSITORY;
  if (!problems || !token || !repo) return;
  const api = (p, opt = {}) => fetch(`https://api.github.com/repos/${repo}${p}`, { ...opt, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' } });
  try {
    const TITLE = 'Crawl sağlık raporu';
    const list = await (await api(`/issues?state=open&per_page=50`)).json();
    const open = Array.isArray(list) ? list.find(i => i.title === TITLE && !i.pull_request) : null;
    const res = open
      ? await api(`/issues/${open.number}/comments`, { method: 'POST', body: JSON.stringify({ body: md }) })
      : await api(`/issues`, { method: 'POST', body: JSON.stringify({ title: TITLE, body: md }) });
    console.log(res.ok ? `📬 GitHub issue ${open ? 'yorumu eklendi' : 'açıldı'}.` : `⚠️  GitHub issue yazılamadı: HTTP ${res.status}`);
  } catch (e) { console.log(`⚠️  GitHub issue yazılamadı: ${e.message}`); }
})();
