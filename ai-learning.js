// ai-learning.js — Parser'ın kendi kendine öğrenme katmanı (28.09)
//
// Fikir: AI bir alanı doldurduğunda artık sadece değeri değil, metinde o değeri gösteren kısa
// birebir ifadeyi de ("_q") veriyor. Bu ifadeler ai-soft-cache.json'da ilan bazında saklanıyor.
// Aynı ifade farklı şirketlerin ilanlarında tekrar tekrar AYNI değeri gösteriyorsa, o ifade
// "öğrenilmiş kural" oluyor ve bir sonraki taramada AI'ya sormadan, bedava uygulanıyor.
//
//   AI çağrısı → cache'e {değer, _q: ifade, _c: şirket} → kurallar cache'ten her koşuda yeniden
//   hesaplanıyor → eşiği geçen ifade ücretsiz katmana giriyor → AI kotası yeni/zor ilanlara kalıyor.
//
// Kurallar ayrı bir dosyada tutulmuyor: tek doğruluk kaynağı cache. Böylece paralel parçalar
// (shard) arasında ekstra birleştirme gerekmiyor, kötü bir kural cache'ten silinince kendiliğinden gidiyor.
// results/ai-learning-report.md her gün yeniden yazılıyor: hangi kurallar terfi etti, hangileri
// yaklaşıyor, hangi ifadeler çelişkili — kalıcı regex'e taşınacak adaylar buradan seçilir.

// Terfi eşikleri: en az 3 ilan, en az 2 farklı şirket (tek bir şirketin şablon metni kural olmasın),
// oyların en az %90'ı aynı değer.
const PROMOTE_MIN_N = 3;
const PROMOTE_MIN_COMPANIES = 2;
const PROMOTE_MIN_SHARE = 0.9;
const MIN_WORDS = 2, MAX_WORDS = 8, MAX_CHARS = 80;

function normText(s){
  return String(s || '').normalize('NFC').toLowerCase()
    .replace(/[ \s]+/g, ' ')
    .replace(/[„“”"'«»]/g, '')
    .trim();
}
function normPhrase(s){
  return normText(s).replace(/^[\s,.;:!?()\-–•*]+|[\s,.;:!?()\-–•*]+$/g, '');
}
function wordCount(p){ return p.split(' ').filter(Boolean).length; }

// AI'nın verdiği ifade gerçekten metinde geçiyor mu ve kullanışlı uzunlukta mı?
function validQuote(q, text){
  if(typeof q !== 'string') return null;
  const p = normPhrase(q);
  if(!p || p.length > MAX_CHARS) return null;
  const w = wordCount(p);
  if(w < MIN_WORDS || w > MAX_WORDS) return null;
  if(!normText(text).includes(p)) return null; // uydurma/parafraz ifade kabul edilmez
  return p;
}

const valueKey = v => JSON.stringify(Array.isArray(v) ? [...v].sort() : v);
const isUsable = v => v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0);

// cache: { url: { alan: değer, ..., _q: { alan: ifade }, _c: şirket } }
function tallyFromCache(cache){
  const t = {}; // t[alan][ifade] = { votes: {valueKey: n}, companies: Set, n }
  for(const entry of Object.values(cache || {})){
    if(!entry || typeof entry !== 'object' || !entry._q) continue;
    for(const [k, q] of Object.entries(entry._q)){
      const v = entry[k];
      if(!isUsable(v) || typeof q !== 'string') continue;
      const p = normPhrase(q);
      if(!p) continue;
      t[k] = t[k] || {};
      const rec = t[k][p] = t[k][p] || { votes: {}, companies: new Set(), n: 0 };
      const vk = valueKey(v);
      rec.votes[vk] = (rec.votes[vk] || 0) + 1;
      rec.n++;
      if(entry._c) rec.companies.add(entry._c);
    }
  }
  return t;
}

function summarize(rec){
  const [topKey, topN] = Object.entries(rec.votes).sort((a, b) => b[1] - a[1])[0];
  return { value: JSON.parse(topKey), share: topN / rec.n, n: rec.n, companies: rec.companies.size };
}

// { alan: [{ phrase, value, n, companies }] } — uzun ifadeler önce (daha spesifik).
function buildLearnedRules(cache){
  const t = tallyFromCache(cache);
  const rules = {};
  for(const [k, phrases] of Object.entries(t)){
    for(const [phrase, rec] of Object.entries(phrases)){
      const s = summarize(rec);
      if(s.n >= PROMOTE_MIN_N && s.companies >= PROMOTE_MIN_COMPANIES && s.share >= PROMOTE_MIN_SHARE){
        (rules[k] = rules[k] || []).push({ phrase, value: s.value, n: s.n, companies: s.companies });
      }
    }
    if(rules[k]) rules[k].sort((a, b) => b.phrase.length - a.phrase.length);
  }
  return rules;
}

// Eksik alanlar için öğrenilmiş kuralları uygular. Döner: { alan: { value, phrase } }
function matchLearnedRules(text, rules, keys){
  const nt = normText(text);
  const out = {};
  if(!nt) return out;
  for(const k of keys){
    const list = rules[k];
    if(!list) continue;
    // Olumsuzlama koruması: "kein Führerschein B erforderlich" içinde "führerschein b erforderlich" eşleşmesin.
    const NEG = /\b(kein|keine|keinen|nicht|ohne|no|not|without)\b[^.;:!?]{0,25}$/;
    const hits = list.filter(r => {
      let i = nt.indexOf(r.phrase);
      while(i > -1){ if(!NEG.test(nt.slice(Math.max(0, i - 40), i))) return true; i = nt.indexOf(r.phrase, i + 1); }
      return false;
    });
    if(!hits.length) continue;
    // Aynı metinde çelişen kurallar varsa (ör. team small + large) hiçbirini uygulama — AI'ya kalsın.
    const distinct = new Set(hits.map(h => valueKey(h.value)));
    if(distinct.size > 1) continue;
    out[k] = { value: hits[0].value, phrase: hits[0].phrase };
  }
  return out;
}

function learningReport(cache, date){
  const t = tallyFromCache(cache);
  const promoted = [], near = [], conflicts = [];
  let quotedEntries = 0;
  for(const e of Object.values(cache || {})) if(e && e._q && Object.keys(e._q).length) quotedEntries++;
  for(const [k, phrases] of Object.entries(t)){
    for(const [phrase, rec] of Object.entries(phrases)){
      const s = summarize(rec);
      const row = { k, phrase, ...s, votes: rec.votes };
      if(Object.keys(rec.votes).length > 1 && s.share < PROMOTE_MIN_SHARE) conflicts.push(row);
      else if(s.n >= PROMOTE_MIN_N && s.companies >= PROMOTE_MIN_COMPANIES && s.share >= PROMOTE_MIN_SHARE) promoted.push(row);
      else if(s.n >= 2) near.push(row);
    }
  }
  const byN = (a, b) => b.n - a.n || a.k.localeCompare(b.k);
  promoted.sort(byN); near.sort(byN); conflicts.sort(byN);
  const fmt = v => '`' + JSON.stringify(v) + '`';
  const table = (rows, extra) => rows.length
    ? ['| Alan | Değer | İfade | İlan | Şirket |' + (extra ? ' Oylar |' : ''), '|---|---|---|---|---|' + (extra ? '---|' : ''),
       ...rows.map(r => `| ${r.k} | ${fmt(r.value)} | ${r.phrase.replace(/\|/g, '/')} | ${r.n} | ${r.companies} |` + (extra ? ` ${Object.entries(r.votes).map(([v, n]) => `${v}×${n}`).join(', ')} |` : ''))].join('\n')
    : '_(henüz yok)_';
  return [
    `# Parser öğrenme raporu — ${date}`,
    ``,
    `Kaynak: results/ai-soft-cache.json. İfade (_q) taşıyan ilan kaydı: **${quotedEntries}**.`,
    `Terfi eşiği: ≥${PROMOTE_MIN_N} ilan, ≥${PROMOTE_MIN_COMPANIES} farklı şirket, oyların ≥%${Math.round(PROMOTE_MIN_SHARE * 100)}'i aynı değer.`,
    ``,
    `## Terfi etmiş kurallar (${promoted.length}) — artık AI'ya sorulmadan uygulanıyor`,
    `Sürekli burada duranlar parser'daki kalıcı regex'e taşınmaya aday.`,
    ``,
    table(promoted.slice(0, 200)),
    ``,
    `## Yaklaşanlar (${near.length}) — bir-iki ilan daha görülürse terfi eder`,
    ``,
    table(near.slice(0, 100)),
    ``,
    `## Çelişkili ifadeler (${conflicts.length}) — aynı ifade farklı değerlere işaret ediyor, kural OLMAZ`,
    `Bunlar genelde AI'nın bağlama göre karar verdiği yerler; prompt ya da alan tanımı netleştirilebilir.`,
    ``,
    table(conflicts.slice(0, 60), true),
    ``,
  ].join('\n');
}

module.exports = { validQuote, buildLearnedRules, matchLearnedRules, learningReport, normText, normPhrase, PROMOTE_MIN_N };
