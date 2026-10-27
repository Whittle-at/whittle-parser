// merge-results.js
// Aynı günün otomatik taraması (results/whittle-import-<tarih>.json, companies.json'dan) ile
// elle çalıştırılan problem şirket taraması (results/whittle-import-<tarih>-problem.json,
// problem-companies.json'dan) sonuçlarını TEK bir dosyada birleştirir, Whittle admin panelindeki
// "Toplu İçe Aktar" kutusuna tek seferde yapıştırılabilecek hale getirir.
//
// Kullanım:
//   node merge-results.js            -> bugünün tarihini kullanır
//   node merge-results.js 2026-09-24 -> belirli bir tarihi kullanır
//
// Çıktı: results/whittle-import-<tarih>-combined.json (dosyanın TAMAMINI admin panele yapıştır)

const fs = require('fs');
const path = require('path');
const learning = require('./ai-learning');

const dateStr = process.argv[2] || new Date().toISOString().slice(0, 10);
const outDir = path.join(__dirname, 'results');

const mainFile = path.join(outDir, `whittle-import-${dateStr}.json`);
const problemFile = path.join(outDir, `whittle-import-${dateStr}-problem.json`);

function loadIfExists(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.log(`⚠️  ${path.basename(file)} okunamadı/bozuk JSON, atlanıyor (${e.message})`);
    return null;
  }
}

// ---- 0. adım (26.09): GitHub Actions paralel parçaları (shard) birleştir ----
// Günlük crawl 4 paralel işe bölünüyor; her iş whittle-import-<tarih>-shardK.json, kendi AI cache
// kopyasını (ai-soft-cache-shardK.json) ve kota dosyasını (ai-budget-<tarih>-shardK.json) yazıyor.
// Burada hepsi tek bir ana dosyaya / cache'e / kota dosyasına toplanıyor ve parça dosyaları siliniyor —
// sonrası (problem şirketlerle birleştirme) eskisi gibi çalışıyor.
(function consolidateShards(){
  if (!fs.existsSync(outDir)) return;
  const files = fs.readdirSync(outDir);
  const shardRe = new RegExp(`^whittle-import-${dateStr}-shard\\d+\\.json$`);
  const shardFiles = files.filter(f => shardRe.test(f)).sort();
  if (shardFiles.length) {
    const parts = shardFiles.map(f => loadIfExists(path.join(outDir, f))).filter(Boolean);
    const merged = {
      date: dateStr,
      totalCompanies: parts.reduce((n, p) => n + (p.totalCompanies || 0), 0),
      completedCompanies: parts.reduce((n, p) => n + (p.completedCompanies || 0), 0),
      perCompany: parts.flatMap(p => p.perCompany || []),
      items: parts.flatMap(p => p.items || []),
      excludedItems: parts.flatMap(p => p.excludedItems || []),
    };
    merged.totalItems = merged.items.length;
    fs.writeFileSync(mainFile, JSON.stringify(merged, null, 2));
    shardFiles.forEach(f => fs.unlinkSync(path.join(outDir, f)));
    console.log(`🧩 ${shardFiles.length} parça birleştirildi → ${path.basename(mainFile)} (${merged.items.length} ilan, ${merged.completedCompanies}/${merged.totalCompanies} şirket)`);
  }
  // AI cache parçaları: her parça ana cache'in tam kopyası + kendi yeni kayıtları. İlan bazında birleştir.
  const cacheFile = path.join(outDir, 'ai-soft-cache.json');
  const cacheParts = files.filter(f => /^ai-soft-cache-shard\d+\.json$/.test(f));
  if (cacheParts.length) {
    const cache = loadIfExists(cacheFile) || {};
    for (const f of cacheParts) {
      const part = loadIfExists(path.join(outDir, f)) || {};
      for (const [key, val] of Object.entries(part)) {
        cache[key] = (val && typeof val === 'object' && !Array.isArray(val) && cache[key] && typeof cache[key] === 'object')
          ? { ...cache[key], ...val } : val;
      }
      fs.unlinkSync(path.join(outDir, f));
    }
    fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
    console.log(`🤖 ${cacheParts.length} AI cache parçası birleştirildi (${Object.keys(cache).length} kayıt).`);
  }
  // Kota parçaları: günün toplamı tek dosyaya — akşam elle yapılan problem taraması kalan kotayı buradan görüyor.
  const budgetRe = new RegExp(`^ai-budget-${dateStr}-shard\\d+\\.json$`);
  const budgetParts = files.filter(f => budgetRe.test(f));
  if (budgetParts.length) {
    const budgetFile = path.join(outDir, `ai-budget-${dateStr}.json`);
    const prev = loadIfExists(budgetFile) || { used: 0 };
    const used = (prev.used || 0) + budgetParts.reduce((n, f) => n + ((loadIfExists(path.join(outDir, f)) || {}).used || 0), 0);
    fs.writeFileSync(budgetFile, JSON.stringify({ used, max: require('./ai-fields').DAILY_AI_LIMIT }));
    budgetParts.forEach(f => fs.unlinkSync(path.join(outDir, f)));
    console.log(`🤖 Bugünkü AI kullanımı: ${used}/${require('./ai-fields').DAILY_AI_LIMIT}.`);
  }
  // 28.09: öğrenme raporu — birleşmiş cache'ten (hangi ifadeler kurala dönüştü, hangileri yaklaşıyor).
  try {
    const fullCache = loadIfExists(cacheFile) || {};
    fs.writeFileSync(path.join(outDir, 'ai-learning-report.md'), learning.learningReport(fullCache, dateStr));
    const rules = learning.buildLearnedRules(fullCache);
    console.log(`🧠 Öğrenilmiş kural: ${Object.values(rules).reduce((n, l) => n + l.length, 0)} → results/ai-learning-report.md`);
  } catch (e) { console.log(`⚠️  Öğrenme raporu yazılamadı: ${e.message}`); }
  // 28.09: Kota sadece BUGÜN için lazım — eski günlerin ai-budget dosyaları repoda birikmesin.
  files.filter(f => /^ai-budget-\d{4}-\d{2}-\d{2}(-shard\d+)?\.json$/.test(f) && !f.startsWith(`ai-budget-${dateStr}`))
    .forEach(f => { try { fs.unlinkSync(path.join(outDir, f)); } catch (e) {} });
})();

const main = loadIfExists(mainFile);
const problem = loadIfExists(problemFile);

if (!main && !problem) {
  console.log(`❌ ${dateStr} için ne "${path.basename(mainFile)}" ne de "${path.basename(problemFile)}" bulunamadı.`);
  console.log(`   Kullanım: node merge-results.js [YYYY-MM-DD]`);
  process.exit(1);
}

if (main) console.log(`✅ Otomatik tarama bulundu: ${main.items?.length || 0} ilan (${main.completedCompanies}/${main.totalCompanies} şirket)`);
else console.log(`ℹ️  Otomatik tarama dosyası ("${path.basename(mainFile)}") bulunamadı — sadece elle taranan şirketlerle devam ediliyor.`);

if (problem) console.log(`✅ Elle taranan problem şirketler bulundu: ${problem.items?.length || 0} ilan (${problem.completedCompanies}/${problem.totalCompanies} şirket)`);
else console.log(`ℹ️  Problem şirket dosyası ("${path.basename(problemFile)}") bulunamadı — sadece otomatik taramayla devam ediliyor.`);

// externalUrl'e göre dedupe (aynı ilan iki dosyada da olabilir — mesela bir şirket bir ara
// listeye eklenip sonra tekrar problem listesine taşınmışsa, ya da iki taramanın tarihi
// çakışıp aynı şirket iki kez taranmışsa).
const seen = new Set();
const combinedItems = [];
for (const src of [main, problem]) {
  if (!src || !Array.isArray(src.items)) continue;
  for (const item of src.items) {
    const key = item.externalUrl || `${item.companyName}|${item.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    combinedItems.push(item);
  }
}

// EKLENDİ (26.09): perCompany da taşınıyor. Whittle import'u bunu kullanarak "bugün başarıyla
// taranmış ama artık görünmeyen" ilanları şirket bazında kapatıyor. Crawl'ı başarısız olan ya da
// 0 ilan dönen şirketin ilanlarına DOKUNULMUYOR (ör. EY zaman aşımına düşerse tüm ilanları kapanmasın).
// Bu yüzden admin paneline ARTIK SADECE "items"ı değil, DOSYANIN TAMAMINI yapıştır.
const perCompany = [];
for (const src of [main, problem]) {
  if (src && Array.isArray(src.perCompany)) perCompany.push(...src.perCompany);
}

// 05.10: "mode": "office" şirketleri — önbellekten/eski taramadan gelen mağaza ilanları da burada atılıyor (AI'dan önce).
// RETIRED: listeden çıkarılan şirketler. perCompany'ye count>0 / 0 ilanla ekleniyor → site import'u eski ilanlarını
// kapatıyor (güvenlik freni yüzünden 2 taramada). ~10.10'dan sonra bu listeyi boşaltabilirsin.
const RETIRED = ['ONLY Stores Austria', 'JYSK Austria', "McDonald's Österreich", 'Ankerbrot', 'Läderach Österreich', 'Motel One', 'Alfies', 'IKEA Austria', 'Continental Austria', 'Wiener Gesundheitsverbund', 'Kinderfreunde', 'Caritas Wien', "L'Oréal Österreich" /* 08.10: liste sayfası JobDetail linki vermiyor */];
{
  const cfg = [];
  for (const f of ['companies.json', 'problem-companies.json']) { try { cfg.push(...JSON.parse(fs.readFileSync(path.join(__dirname, f), 'utf8'))); } catch (e) {} }
  const officeCos = new Set(cfg.filter(c => c && c.mode === 'office').map(c => c.name));
  // 05.10: işveren tipi her zaman şirket listesinden (önbellekten gelen eski değerler de düzelsin).
  const typeOf = new Map(cfg.filter(c => c && c.employerType).map(c => [c.name, c.employerType]));
  combinedItems.forEach(it => { const t = typeOf.get(it._company); if (t) it.employerType = t; });
  const { officeTitle } = require('./ai-fields');
  const coOf = it => it._company || it.companyName;
  const before = combinedItems.length;
  const kept = combinedItems.filter(it => !RETIRED.includes(coOf(it)) && !(officeCos.has(coOf(it)) && !officeTitle(it.title)));
  if (kept.length !== before) console.log(`🏬 mode=office / çıkarılan şirket filtresi: ${before - kept.length} mağaza/depo ilanı atıldı.`);
  combinedItems.length = 0; combinedItems.push(...kept);
  for (const name of RETIRED) if (!perCompany.some(c => c.name === name)) perCompany.push({ name, count: 1, rawCount: 0, ok: true, retired: true });
}

// 27.10 (Dakika): elenen ilan linkleri de combined'a (sadece link + tarih). Bunlar olmadan parser ertesi gün her elenen
// ilanı (senior, başka şehir, ilan olmayan sayfa) baştan açıyordu — tarayıcı taramasında açılan sayfaların çoğu buydu.
const excludedItems = [];
{
  const seenEx = new Set(combinedItems.map(it => it._srcLink).filter(Boolean));
  for (const src of [main, problem]) for (const ex of (src && src.excludedItems) || []) {
    if (!ex || !ex._srcLink || !ex._fetchedAt || seenEx.has(ex._srcLink)) continue;
    seenEx.add(ex._srcLink); excludedItems.push({ _srcLink: ex._srcLink, _fetchedAt: ex._fetchedAt });
  }
}
const combined = {
  date: dateStr,
  totalCompanies: (main?.totalCompanies || 0) + (problem?.totalCompanies || 0),
  completedCompanies: (main?.completedCompanies || 0) + (problem?.completedCompanies || 0),
  totalItems: combinedItems.length,
  perCompany,
  items: combinedItems,
  excludedItems,
};

const outFile = path.join(outDir, `whittle-import-${dateStr}-combined.json`);
fs.writeFileSync(outFile, JSON.stringify(combined, null, 2));
console.log(`\n✅ Birleştirildi: ${combinedItems.length} ilan → ${path.basename(outFile)}`);
console.log(`   Dosyanın TAMAMINI kopyala, Whittle admin panelindeki "Toplu İçe Aktar" kutusuna yapıştır`);
console.log(`   (sadece "items" yapıştırırsan ilanlar yine eklenir/güncellenir ama otomatik kapatma çalışmaz).`);

// =====================================================================================
// 28.09: AI TOPLU ÇAĞRI (Anthropic Message Batches API — normal fiyatın %50'si).
// Paralel tarama parçaları AI'yı kendileri çağırmıyor; eksik alanları results/ai-queue-<tarih>-shardK.json
// kuyruğuna yazıyor. Burada tüm kuyruk birleştirilip önceliğe göre (önce zorunlu şartları eksik olanlar)
// günlük kotaya kadar TEK bir batch olarak gönderiliyor, sonuç beklenip cache'e ve bugünkü combined
// dosyasına işleniyor. Batch 45 dk içinde bitmezse kimliği results/ai-pending-batch.json'a yazılıyor;
// ertesi gün önce o sonuçlar toplanıyor (Anthropic sonuçları 29 gün saklıyor, kayıp yok).
// =====================================================================================
const aiFields = require('./ai-fields');
const API = 'https://api.anthropic.com/v1/messages/batches';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const apiHeaders = () => ({ 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' });

// 03.10: AYLIK BÜTÇE — crawl AI'sı ayda en fazla CRAWL_MONTH_USD (toplam hedef ≤ €10/ay; demo ayrı, $4).
// results/ai-spend-YYYY-MM.json: { usd: gerçekleşen (API'nin döndürdüğü token sayısından), pending: { batchId: tahmin } }.
// Her gün kalan bütçe / ayın kalan günü kadar harcanabiliyor → ay başında yeni ilan dalgası gelse de ay sonuna para kalıyor.
// 05.10: crawl için iki kova, toplam $9 ≈ €8.3/ay (Apply demo'nun $4'ı ayrı, functions/index.js'te):
// alan çıkarımı $7.5 + kategori $1.5. Kategori ucuz (~$0.0005/ilan) ama ilan/ilan-değil ayrımı ve Wien filtresi ona bağlı →
// kendi bütçesi var, birikim varsa öne çekilebiliyor.
// 08.10: + ilan özeti (Apply 1. adım) $1.5; toplam $9.5 ≈ €8.8 kalsın diye alan çıkarımı 7.5 → 6.5.
const CRAWL_MONTH_USD = 6.5, CAT_MONTH_USD = 1.5, BRIEF_MONTH_USD = 1.5;
const BATCH_PRICE = { in: 0.5 / 1e6, out: 2.5 / 1e6 }; // Haiku 4.5, Batch (%50 indirimli)
const spendFile = path.join(outDir, `ai-spend-${dateStr.slice(0, 7)}.json`);
const loadSpend = () => { const x = loadIfExists(spendFile) || {}; return { usd: x.usd || 0, cat: x.cat || 0, brief: x.brief || 0, pending: x.pending || {} }; };
const saveSpend = sp => fs.writeFileSync(spendFile, JSON.stringify({ usd: +sp.usd.toFixed(4), cat: +sp.cat.toFixed(4), brief: +(sp.brief || 0).toFixed(4), pending: sp.pending, cap: CRAWL_MONTH_USD, catCap: CAT_MONTH_USD, briefCap: BRIEF_MONTH_USD }, null, 2));
const pend = (v, k) => typeof v === 'number' ? (k === 'f' ? v : 0) : ((v && v[k]) || 0);
const spentTotal = sp => sp.usd + Object.values(sp.pending).reduce((a, v) => a + pend(v, 'f'), 0);
const spentCat = sp => sp.cat + Object.values(sp.pending).reduce((a, v) => a + pend(v, 'c'), 0);
const spentBrief = sp => (sp.brief || 0) + Object.values(sp.pending).reduce((a, v) => a + pend(v, 'b'), 0);
const estCost = (prompt, outTok) => Math.ceil(String(prompt).length / 3.2 + 40) * BATCH_PRICE.in + outTok * BATCH_PRICE.out;
let lastBatchUsd = 0, lastBatchCatUsd = 0, lastBatchBriefUsd = 0;
async function fetchBatchResults(batch){
  const res = await fetch(batch.results_url, { headers: apiHeaders() });
  if (!res.ok) throw new Error(`results HTTP ${res.status}`);
  const out = {};
  lastBatchUsd = 0; lastBatchCatUsd = 0; lastBatchBriefUsd = 0;
  for (const line of (await res.text()).split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r.result && r.result.type === 'succeeded') {
        const msg = r.result.message;
        const u = (msg && msg.usage) || {};
        const cost = (Number(u.input_tokens) || 0) * BATCH_PRICE.in + (Number(u.output_tokens) || 0) * BATCH_PRICE.out;
        if (/^c/.test(r.custom_id)) lastBatchCatUsd += cost; else if (/^b/.test(r.custom_id)) lastBatchBriefUsd += cost; else lastBatchUsd += cost;
        out[r.custom_id] = (msg && msg.content && msg.content[0] && msg.content[0].text) || '';
      }
    } catch (e) {}
  }
  return out;
}
async function getBatch(id){
  const res = await fetch(`${API}/${id}`, { headers: apiHeaders() });
  if (!res.ok) throw new Error(`batch HTTP ${res.status}`);
  return res.json();
}
// Sonuçları cache'e ve (varsa) bugünkü ilanlara işler. Döner: işlenen istek sayısı.
function applyBatchResults(texts, reqs, cache, items){
  const byUrl = new Map(items.map(it => [it.externalUrl, it]));
  let n = 0;
  for (const [cid, raw] of Object.entries(texts)) {
    const req = reqs[cid];
    if (!req) continue;
    if (req.brief) { // 08.10: ilan özeti
      const br = aiFields.parseBrief(raw);
      if (!br) continue;
      cache[req.url] = { ...(cache[req.url] || {}), brief: br };
      const it = byUrl.get(req.url); if (it) it.aiBrief = br;
      n++; continue;
    }
    if (req.cat) { // alan sınıflandırması isteği
      const cat = aiFields.parseCat(raw);
      if (!cat) continue;
      const loc = aiFields.parseLoc(raw);
      cache[req.url] = { ...(cache[req.url] || {}), cat, loc: loc || null };
      const it = byUrl.get(req.url); if (it) { it.aiCat = cat; applyAiLoc(it, loc); }
      n++; continue;
    }
    const parsed = aiFields.parseAiText(raw, req.keys, req.text);
    if (!parsed) continue;
    cache[req.url] = aiFields.cacheEntryFrom(cache[req.url], parsed, req.company);
    const item = byUrl.get(req.url);
    if (item) {
      const q = parsed._q || {};
      for (const k of req.keys) if (aiFields.isFieldMissing(item, k)) aiFields.applyFieldValue(item, k, parsed[k], true, q[k]);
    }
    n++;
  }
  return n;
}

// Konumu bilinmeyen ("Österreich") ilanda AI'nın okuduğu yer: Avusturya'daysa şehri konum yap, yurt dışıysa işaretle.
const UNKNOWN_LOC = x => !x || /^(österreich|oesterreich|austria|at)$/i.test(String(x).trim());
function applyAiLoc(it, loc){
  if (!loc || !UNKNOWN_LOC(it.sourceNote)) return;
  if (loc.austria) { if (loc.city && !/österreich|austria/i.test(loc.city)) it.sourceNote = loc.city; }
  else if (loc.country) it._foreign = loc.country;
}
async function aiBatchStep(items){
  const queueFiles = fs.readdirSync(outDir).filter(f => new RegExp(`^ai-queue-${dateStr}(-shard\\d+)?\\.json$`).test(f));
  const cacheFile = path.join(outDir, 'ai-soft-cache.json');
  const pendingFile = path.join(outDir, 'ai-pending-batch.json');
  const budgetFile = path.join(outDir, `ai-budget-${dateStr}.json`);
  // Cache'teki sınıflandırmalar (aiCat) anahtar olmasa bile (yerel merge) bugünkü ilanlara işlensin.
  { const c0 = loadIfExists(cacheFile) || {}; items.forEach(it => { const c = it.externalUrl && c0[it.externalUrl]; if (c && c.cat) it.aiCat = c.cat; if (c && c.loc) applyAiLoc(it, c.loc); if (c && c.brief) it.aiBrief = c.brief; }); }
  if (!process.env.ANTHROPIC_API_KEY) {
    if (queueFiles.length) console.log('ℹ️  ANTHROPIC_API_KEY yok — AI kuyruğu bu sefer gönderilmedi (kuyruk dosyaları yarın tekrar oluşur).');
    queueFiles.forEach(f => fs.unlinkSync(path.join(outDir, f)));
    return false;
  }
  const cache = loadIfExists(cacheFile) || {};
  let changed = false;

  // 1) Dünden kalan batch varsa önce onu topla.
  const pending = loadIfExists(pendingFile);
  if (pending && pending.id) {
    try {
      const b = await getBatch(pending.id);
      if (b.processing_status === 'ended') {
        const n = applyBatchResults(await fetchBatchResults(b), pending.reqs, cache, items);
        { const sp = loadSpend(); delete sp.pending[pending.id]; sp.usd += lastBatchUsd; sp.cat += lastBatchCatUsd; sp.brief = (sp.brief || 0) + lastBatchBriefUsd; saveSpend(sp); }
        console.log(`🤖 Bekleyen batch toplandı: ${n} sonuç cache'e işlendi ($${lastBatchUsd.toFixed(3)}).`);
        fs.unlinkSync(pendingFile); changed = true;
      } else {
        console.log(`⏳ Önceki batch (${pending.id}) hâlâ işleniyor — bugün yeni batch gönderilmiyor.`);
        queueFiles.forEach(f => fs.unlinkSync(path.join(outDir, f)));
        if (changed) fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
        return changed;
      }
    } catch (e) { console.log(`⚠️  Bekleyen batch okunamadı (${e.message}) — dosya korunuyor, yarın tekrar denenecek.`); return changed; }
  }

  // 2) Bugünün kuyruğu: tekilleştir, zaten cache'te cevabı olanları çıkar, önceliğe göre sırala, kotayla kes.
  const byUrl = new Map();
  for (const f of queueFiles) {
    for (const q of (loadIfExists(path.join(outDir, f)) || [])) {
      const cached = cache[q.url];
      const keys = q.keys.filter(k => !cached || !(k in cached));
      if (!keys.length) continue;
      const prev = byUrl.get(q.url);
      if (!prev || keys.length > prev.keys.length) byUrl.set(q.url, { ...q, keys });
    }
    fs.unlinkSync(path.join(outDir, f));
  }
  const usedToday = (loadIfExists(budgetFile) || {}).used || 0;
  const room = Math.max(0, aiFields.DAILY_AI_LIMIT - usedToday);
  // 03.10: (1) başlığı açık seri ilanlara kural tabanlı kategori (AI'sız, cache'e _rc ile yazılıyor).
  let ruleN = 0;
  for (const it of items) {
    if (!it.externalUrl) continue;
    const c0 = cache[it.externalUrl];
    if (c0 && 'cat' in c0) continue;
    const rc = aiFields.ruleCat(it.title);
    if (rc) { cache[it.externalUrl] = { ...(c0 || {}), cat: rc, _rc: 1 }; ruleN++; changed = true; }
  }
  if (ruleN) console.log(`🏷️  Kural tabanlı kategori: ${ruleN} ilan (AI'ya gitmedi).`);
  // (2) detay AI'sı sadece öğrenci için önemli ilanlara: lojistik/şoför/sağlık vb. atlanıyor; Praktikum/Trainee,
  //     ofis kategorileri ve Wien öne çekiliyor.
  const itemByUrl = new Map(items.map(it => [it.externalUrl, it]));
  let skipN = 0;
  const sorted = [...byUrl.values()].map(q => {
    const it = itemByUrl.get(q.url), c = cache[q.url];
    const pr = aiFields.fieldAiPriority(q.title, (c && c.cat) || (it && it.aiCat) || null, it && it.sourceNote);
    if (pr === null) { skipN++; return null; }
    return { ...q, priority: q.priority + pr };
  }).filter(Boolean).sort((a, b) => b.priority - a.priority).slice(0, room);
  if (skipN) console.log(`⏭️  Detay AI'sı atlandı (öğrenci için düşük öncelikli kategori): ${skipN} ilan.`);
  // Alan sınıflandırması: cache'te "cat" olmayan bugünkü her ilan (ayrı, çok ucuz kısa istek).
  const catAll = items.filter(it => it.externalUrl && (!(cache[it.externalUrl] && 'cat' in cache[it.externalUrl]) || (UNKNOWN_LOC(it.sourceNote) && !('loc' in cache[it.externalUrl]))))
    .filter((it, i, arr) => arr.findIndex(x => x.externalUrl === it.externalUrl) === i)
    .slice(0, aiFields.CAT_DAILY_LIMIT);
  // Cache'te zaten sınıfı olanlar bugünkü ilanlara hemen işleniyor.
  items.forEach(it => { const c = it.externalUrl && cache[it.externalUrl]; if (c && c.cat) it.aiCat = c.cat; });
  // 03.10: bugünkü para payı = kalan aylık bütçe / ayın kalan günleri. Önce sınıflandırma (ucuz, ilan/ilan-değil
  // ayrımı için önemli), sonra alan çıkarımı öncelik sırasıyla — pay dolunca kalanlar yarına kalıyor.
  const sp = loadSpend();
  const dNow = new Date(dateStr + 'T12:00:00Z');
  const daysLeft = new Date(Date.UTC(dNow.getUTCFullYear(), dNow.getUTCMonth() + 1, 0)).getUTCDate() - dNow.getUTCDate() + 1;
  const left = Math.max(0, CRAWL_MONTH_USD - spentTotal(sp)), catLeft = Math.max(0, CAT_MONTH_USD - spentCat(sp));
  const allow = left / daysLeft;
  // Kategori: birikim varsa günde $0.25'e kadar öne çekilir (≈500 ilan), aylık tavan yine CAT_MONTH_USD.
  const catAllow = Math.min(catLeft, Math.max(catLeft / daysLeft, 0.25));
  let est = 0, estCat = 0;
  const catTodo = [], picked = [];
  for (const it of catAll) { const c = estCost(aiFields.buildCatPrompt(it.title, it.companyName, it._rawText), 20); if (estCat + c > catAllow) break; estCat += c; catTodo.push(it); }
  for (const q of sorted) { const c = estCost(aiFields.buildAiPrompt(q.title, q.text, q.keys), 350); if (est + c > allow) break; est += c; picked.push(q); }
  // 08.10: ilan özeti — sadece öğrenci ilanları (Praktikum/Trainee/Werkstudent…), önce Wien; ilan başına bir kez (cache).
  const briefLeft = Math.max(0, BRIEF_MONTH_USD - spentBrief(sp)), briefAllow = Math.min(briefLeft, Math.max(briefLeft / daysLeft, 0.08));
  let estBrief = 0; const briefTodo = [];
  items.filter(it => it.externalUrl && (it._adText || '').length > 400 && STUDENT_T.test(it.title || '') && !(cache[it.externalUrl] && cache[it.externalUrl].brief))
    .filter((it, i, arr) => arr.findIndex(x => x.externalUrl === it.externalUrl) === i)
    .sort((a, b) => (WIEN_AREA.test(b.sourceNote || '') ? 1 : 0) - (WIEN_AREA.test(a.sourceNote || '') ? 1 : 0))
    .forEach(it => { const c = estCost(aiFields.buildBriefPrompt(it.title, it.companyName, it._adText), 380); if (estBrief + c > briefAllow) return; estBrief += c; briefTodo.push(it); });
  console.log(`💶 AI bütçesi: alanlar $${spentTotal(sp).toFixed(2)}/$${CRAWL_MONTH_USD} (bugün $${est.toFixed(3)}/$${allow.toFixed(3)}), kategori $${spentCat(sp).toFixed(2)}/$${CAT_MONTH_USD} (bugün $${estCat.toFixed(3)}/$${catAllow.toFixed(3)}), özet $${spentBrief(sp).toFixed(2)}/$${BRIEF_MONTH_USD} (bugün ${briefTodo.length} ilan, $${estBrief.toFixed(3)}).`);
  console.log(`🤖 AI kuyruğu: ${byUrl.size} ilan, kota ${room} → ${picked.length} tanesi batch'e gidiyor.`);
  console.log(`🏷️  Sınıflandırma kuyruğu: ${catAll.length} ilan → ${catTodo.length} gönderiliyor.`);
  if (!picked.length && !catTodo.length && !briefTodo.length) { if (changed) fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2)); return changed; }

  const reqs = {};
  const requests = picked.map((q, i) => {
    const cid = `r${i}`;
    reqs[cid] = { url: q.url, keys: q.keys, company: q.company, text: q.text };
    return { custom_id: cid, params: { model: aiFields.AI_MODEL, max_tokens: aiFields.AI_MAX_TOKENS,
      messages: [{ role: 'user', content: aiFields.buildAiPrompt(q.title, q.text, q.keys) }] } };
  });
  catTodo.forEach((it, i) => {
    const cid = `c${i}`;
    reqs[cid] = { url: it.externalUrl, cat: true };
    requests.push({ custom_id: cid, params: { model: aiFields.AI_MODEL, max_tokens: 30,
      messages: [{ role: 'user', content: aiFields.buildCatPrompt(it.title, it.companyName, it._rawText) }] } });
  });
  briefTodo.forEach((it, i) => {
    const cid = `b${i}`;
    reqs[cid] = { url: it.externalUrl, brief: true };
    requests.push({ custom_id: cid, params: { model: aiFields.AI_MODEL, max_tokens: aiFields.BRIEF_MAX_TOKENS,
      messages: [{ role: 'user', content: aiFields.buildBriefPrompt(it.title, it.companyName, it._adText) }] } });
  });
  let batch;
  try {
    const res = await fetch(API, { method: 'POST', headers: apiHeaders(), body: JSON.stringify({ requests }) });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    batch = await res.json();
  } catch (e) { console.log(`⚠️  Batch gönderilemedi: ${e.message}`); if (changed) fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2)); return changed; }
  fs.writeFileSync(budgetFile, JSON.stringify({ used: usedToday + picked.length, max: aiFields.DAILY_AI_LIMIT }));
  { const s2 = loadSpend(); s2.pending[batch.id] = { f: +est.toFixed(4), c: +estCat.toFixed(4), b: +estBrief.toFixed(4) }; saveSpend(s2); }
  console.log(`🤖 Batch gönderildi: ${batch.id} (${picked.length} alan + ${catTodo.length} sınıflandırma + ${briefTodo.length} özet isteği). Sonuç bekleniyor…`);

  // 3) Bekle (en fazla 12 dk — 30.09: 45 dk'lık bekleme her gün boşa Actions dakikası yakıyordu). Bitmezse
  //    kimliği sakla, yarın ilk iş topla (sonuçlar cache'e girer, ilanlara bir gün sonra yansır).
  const deadline = Date.now() + 4 * 60 * 1000; // 01.10: 12 → 4 dk (Actions dakikası); bitmeyen batch ertesi gün toplanıyor
  let b = batch;
  while (b.processing_status !== 'ended' && Date.now() < deadline) {
    await sleep(30000);
    try { b = await getBatch(batch.id); } catch (e) { console.log(`  ⚠️  durum okunamadı: ${e.message}`); }
  }
  if (b.processing_status === 'ended') {
    try {
      const n = applyBatchResults(await fetchBatchResults(b), reqs, cache, items);
      { const s2 = loadSpend(); delete s2.pending[batch.id]; s2.usd += lastBatchUsd; s2.cat += lastBatchCatUsd; s2.brief = (s2.brief || 0) + lastBatchBriefUsd; saveSpend(s2); }
      console.log(`🤖 Batch bitti: ${n}/${requests.length} sonuç işlendi ($${lastBatchUsd.toFixed(3)}).`);
      changed = true;
    } catch (e) {
      console.log(`⚠️  Sonuçlar alınamadı (${e.message}) — yarın tekrar denenecek.`);
      fs.writeFileSync(pendingFile, JSON.stringify({ id: batch.id, submittedAt: new Date().toISOString(), reqs }));
    }
  } else {
    console.log(`⏳ Batch 4 dk'da bitmedi — ${batch.id} yarın toplanacak.`);
    fs.writeFileSync(pendingFile, JSON.stringify({ id: batch.id, submittedAt: new Date().toISOString(), reqs }));
  }
  fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
  return changed;
}

// 28.09: son kalite filtresi — AI "gerçek ilan değil" dediyse (cat=none) ya da ilan açıkça 5+ yıl deneyim
// istiyorsa (exp=3, tahmin değil) öğrenci platformunda gösterilmiyor. Bu ilanlar items'tan çıkınca site
// import'u onları "artık görünmüyor" diye kendiliğinden kapatıyor.
// 30.09: artımlı taramada eski (önbellekten gelen) ilanlar parser'ın yeni filtrelerinden geçmiyor —
// kıdem/çöp başlık kontrolü ve konum temizliği burada da uygulanıyor.
let P = {};
try { P = require('./jobposting-parser-v2.js'); } catch (e) { P = {}; }
// 03.10: WIEN ÖNCELİĞİ — kitle Wien'deki öğrenciler. Tüm Avusturya'dan ofis/IT/mühendislik/hukuk/finans ilanları
// ve Praktikum/Trainee/Werkstudent ilanları kalıyor; Wien dışındaki yerinde-iş ilanları (Zusteller, Lager,
// Filialverkauf, Gastro, Pflege …) çıkarılıyor. Konum bilinmiyorsa ilan kalıyor. false → eski davranış.
const LOCAL_ONLY_OUTSIDE_WIEN = true;
const LOCAL_CATS = /^(TRADES:|RETAIL:(retailsales|gastro|custservice|hotel)|HEALTH:(medical|eldercare|therapy)|EDU:security)/;
const WIEN_AREA = /\b(wien|vienna|1[0-2]\d0|vösendorf|schwechat|klosterneuburg|mödling|brunn am gebirge|perchtoldsdorf|wiener neudorf|gerasdorf|langenzersdorf|purkersdorf|leopoldsdorf|himberg|fischamend)\b/i;
const STUDENT_T = /(praktik|\bintern\b|internship|trainee|werkstudent|working student|studentisch|\bstudent|ferial|graduate|absolvent)/i;
const outsideWienLocal = it => LOCAL_ONLY_OUTSIDE_WIEN && it.aiCat && LOCAL_CATS.test(it.aiCat) && !STUDENT_T.test(it.title || '')
  && it.sourceNote && !UNKNOWN_LOC(it.sourceNote) && !WIEN_AREA.test(it.sourceNote);
function qualityFilter(items){
  const before = items.length;
  const nLocal = items.filter(outsideWienLocal).length;
  if (nLocal) console.log(`📍 Wien dışı yerinde-iş ilanı çıkarıldı: ${nLocal}`);
  items.forEach(it => { if (P.cleanLocation && it.sourceNote) it.sourceNote = P.cleanLocation(it.sourceNote); });
  // 12.10: başlıklarda HTML karakterleri ("Finance &amp; Accounting") — bazı API yolları çözmeden veriyor.
  const ENT = { amp:'&', quot:'"', apos:"'", '#39':"'", lt:'<', gt:'>', nbsp:' ', auml:'ä', ouml:'ö', uuml:'ü', Auml:'Ä', Ouml:'Ö', Uuml:'Ü', szlig:'ß' };
  const decodeEnt = t => String(t).replace(/&(amp|quot|apos|#39|lt|gt|nbsp|[aouAOU]uml|szlig);/g, (m, k) => ENT[k]).replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&');
  items.forEach(it => { if (it.title && /&[#a-z0-9]+;/i.test(it.title)) it.title = decodeEnt(it.title); });
  const keep = items.filter(it => !outsideWienLocal(it) && it.aiCat !== 'none' && !it._foreign && !(it.exp === 3 && !(it.estimated || []).includes('exp'))
    && !(P.guessSeniority && P.guessSeniority(it.title || '') === 'senior')
    && !(P.isJunkTitle && P.isJunkTitle(it.title)));
  // 03.10: Lehre (çırak) ilanları — 15 yaş Pflichtschule mezunlarına yönelik, üniversite öğrencisi için değil.
  const isLehre = it => /^(lehrberuf|lehrling|lehrstelle|lehre\b)|\blehrling(e|s)?\b|\blehrstelle\b/i.test(it.title || '') || (Array.isArray(it.emp) && it.emp.length === 1 && it.emp[0] === 'lehre');
  const nLehre = keep.filter(isLehre).length;
  // 03.10: aynı şirket + aynı başlık birçok şubede (BILLA "Ausbildung Marktmanager:in" ×50) → tek ilan; Wien olan tercih.
  const groups = new Map();
  for (const it of keep) {
    if (isLehre(it)) continue;
    const k = `${it.companyName}|${String(it.title || '').toLowerCase().replace(/\s+/g, ' ').trim()}`;
    const cur = groups.get(k);
    if (!cur || (!WIEN_AREA.test(cur.sourceNote || '') && WIEN_AREA.test(it.sourceNote || ''))) groups.set(k, it);
  }
  const deduped = keep.filter(it => !isLehre(it) && groups.get(`${it.companyName}|${String(it.title || '').toLowerCase().replace(/\s+/g, ' ').trim()}`) === it);
  if (nLehre) console.log(`🧹 Lehre ilanı çıkarıldı: ${nLehre}`);
  if (keep.length - nLehre - deduped.length) console.log(`🧹 Aynı başlıklı şube kopyası birleştirildi: ${keep.length - nLehre - deduped.length}`);
  keep.length = 0; keep.push(...deduped);
  if (keep.length !== before) console.log(`🧹 Kalite filtresi: ${before - keep.length} ilan çıkarıldı (ilan olmayan sayfa / yurt dışı / 5+ yıl deneyim / kıdemli unvan / çöp başlık).`);
  return keep;
}

(async () => {
  try {
    const changed = await aiBatchStep(combined.items);
    // 08.10: "mindestens 3 bis 5 Jahre Berufserfahrung" → exp (parser okumuyordu; eski/önbellekteki ilanlar dahil hepsine).
    { let nExp = 0; for (const it of combined.items) {
        const est = Array.isArray(it.estimated) ? it.estimated : [];
        if (it.exp != null && !est.includes('exp')) continue;
        const v = aiFields.yearsExp(it._adText || it._rawText); if (v == null) continue;
        it.exp = v; it.estimated = est.filter(k => k !== 'exp'); nExp++; }
      if (nExp) console.log(`🧭 Deneyim yılı ilandan okundu: ${nExp} ilan.`); }
    // 09.10: eski cleanAdText "…dein Profil ab" cümlesini başlık sanıp metnin sadece sonunu tutuyordu (~%35 ilan, küçük harfle başlıyor).
    //        Ham metinden yeniden üretiliyor (önbellekteki eski ilanlar dahil).
    if (P.cleanAdText) { let nTxt = 0; for (const it of combined.items) {
        if (!it._adText || !/^[a-zäöüß]/.test(it._adText) || !it._rawText) continue;
        const t2 = P.cleanAdText(it._rawText, it.title);
        if (t2 && t2.length > 400 && !/^[a-zäöüß]/.test(t2)) { it._adText = t2; nTxt++; } }
      if (nTxt) console.log(`🧾 Kesik ilan metni düzeltildi: ${nTxt} ilan.`); }
    const filtered = qualityFilter(combined.items);
    // 05.10: "Handel & Gastronomie" alanı sitede kaldırıldı. Verkauf/Kundenservice → Sales; Event → Marketing;
    // Gastro/Hotel ilanları (öğrenci ilanı değilse) çıkarılıyor.
    { let moved = 0, dropped = 0;
      for (let i = filtered.length - 1; i >= 0; i--) {
        const it = filtered[i], c = it.aiCat || '';
        if (/^RETAIL:(retailsales|custservice)$/.test(c)) { it.aiCat = 'BIZOFF:salesbiz'; moved++; }
        else if (c === 'RETAIL:events') { it.aiCat = 'CREATIVE:marketing'; moved++; }
        else if (/^RETAIL:(gastro|hotel)$/.test(c) && !STUDENT_T.test(it.title || '')) { filtered.splice(i, 1); dropped++; }
      }
      if (moved || dropped) console.log(`🛒 Handel-Alanı: ${moved} ilan Sales/Marketing'e taşındı, ${dropped} Gastro/Hotel ilanı çıkarıldı.`);
    }
    if (filtered.length !== combined.items.length) { combined.items = filtered; combined.totalItems = filtered.length; }
    // 30.09: Whittle Apply "Markt-Check" istatistikleri (bugün + önceki combined, externalUrl'e göre tekil —
    // tarayıcı taraması 2 günde bir olduğu için tek gün şirketlerin yarısını kaçırırdı).
    try {
      const prevFile = fs.readdirSync(outDir).filter(f => /^whittle-import-\d{4}-\d{2}-\d{2}-combined\.json$/.test(f) && f < `whittle-import-${dateStr}`).sort().pop();
      const prev = prevFile ? (loadIfExists(path.join(outDir, prevFile)) || {}).items || [] : [];
      const seenM = new Set(), pool = [];
      for (const it of [...combined.items, ...prev]) { const k = it.externalUrl || `${it.companyName}|${it.title}`; if (seenM.has(k)) continue; seenM.add(k); pool.push(it); }
      combined.market = require('./market-stats').buildMarketStats(pool, aiFields.CATEGORIES || {});
      combined.market.date = dateStr;
      console.log(`📊 Markt-Statistik: ${pool.length} ilan, ${Object.keys(combined.market.cats).length} kategori/alan.`);
    } catch (e) { console.log(`⚠️  Markt-Statistik hesaplanamadı: ${e.message}`); }
    // aiCat (cache'ten) ve filtre her durumda combined dosyasına yansısın diye her seferinde yeniden yazılıyor.
    fs.writeFileSync(outFile, JSON.stringify(combined, null, 2));
    if (changed) {
      const fullCache = loadIfExists(path.join(outDir, 'ai-soft-cache.json')) || {};
      fs.writeFileSync(path.join(outDir, 'ai-learning-report.md'), learning.learningReport(fullCache, dateStr));
      console.log(`✅ AI sonuçları combined dosyasına ve öğrenme raporuna işlendi.`);
    }
  } catch (e) { console.log(`⚠️  AI batch adımı başarısız: ${e.message} — combined dosyası AI'sız haliyle duruyor.`); }
})();
