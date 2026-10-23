// ai-fields.js — AI alan çıkarımının paylaşılan parçaları (28.09).
// Hem parser (yerel/elle taramada anlık çağrı) hem merge-results.js (GitHub'da toplu/Batch API çağrısı)
// AYNI prompt'u, doğrulamayı ve alan uygulamasını kullansın diye buraya taşındı.
const learning = require('./ai-learning');

const AI_MODEL = 'claude-haiku-4-5';
const AI_MAX_TOKENS = 900;
// Günlük AI çağrı üst sınırı (merge'deki toplu çağrı + akşamki elle tarama TOPLAMI).
// Batch API %50 indirimli: ~$0.002/çağrı → 180/gün ≈ ayda ~$11 ≈ €10 tavan.
const DAILY_AI_LIMIT = 180;

const SOFT_FIELD_KEYS = ['team','cust','phys','shift','autonomy','variety','competitive','creative','leadership','mobile'];
// EKLENDİ (26.09): zorunlu şartlar da AI katmanına dahil. Keyword'ün bulamadığı (boş/estimated) her
// alan için soruluyor. Kota hâlâ ÇAĞRI başına (MAX_AI_CALLS_PER_RUN) — bir ilanın tüm eksik alanları
// TEK çağrıda soruluyor, yani alan sayısı artınca kota tüketimi artmıyor, sadece çağrı biraz uzuyor.
const HARD_FIELD_KEYS = ['deg','de','en','exp','wm'];
// (27.09) Yeni: çalışma şekli, sert belge şartları ve alt kategori sorularının dayandığı "facet"ler.
// Facet'ler sitenin alt kategori sorularına çevriliyor (bkz. whittle_1.html → FACET_TO_SQ):
// f_night → Nachtdienste, f_shift → Schichtmodell, f_place → Büro/Außendienst/Baustelle,
// f_sales → Verkaufsziele, f_commission → Provision, f_customers → B2B/B2C, f_cold → Kühllager,
// f_lehramt → Lehramt. Aynı AI çağrısında soruluyor, günlük 80 kotası değişmiyor.
const EXTRA_AI_KEYS = ['emp', 'certs', 'f_night', 'f_shift', 'f_place', 'f_sales', 'f_commission', 'f_customers', 'f_cold', 'f_lehramt', 'study', 'sem', 'hrs', 'start']; // 12.10: start → başlangıç tarihi sorusu; 09.10: study/sem/hrs → sitedeki yeni sorular
const AI_FIELD_KEYS = [...HARD_FIELD_KEYS, ...SOFT_FIELD_KEYS, ...EXTRA_AI_KEYS];
function isFieldMissing(item, k){
  if(k === 'certs') return !Array.isArray(item.certs) || item.certs.length === 0; // kural "yok" dediyse AI yine de baksın
  return !(k in item) || item[k] === null || item[k] === undefined || (Array.isArray(item[k]) && item[k].length === 0);
}

// Maliyet: AI'ya ilanın tamamı değil, şartların geçtiği kısım gidiyor. "Über uns" tanıtımı çoğu zaman
// başta, "Wir bieten"/Datenschutz sonda — ikisini de kırpmak girdi token'ını ~%20-35 düşürüyor.
function trimForAi(text){
  let t = String(text || '').replace(/\s+/g, ' ').trim();
  const start = t.search(/(deine|ihre|your)?\s*(aufgaben|tätigkeiten|verantwortung|responsibilities|what you.ll do|das erwartet dich|deine rolle|your role|dein profil|ihr profil|anforderungen|requirements|das bringst du mit|qualifikation)/i);
  if(start > 400) t = t.slice(start - 150);
  const end = t.search(/(datenschutz|privacy policy|data protection|wir freuen uns auf deine bewerbung|we look forward to (receiving )?your application)/i);
  if(end > 1500) t = t.slice(0, end);
  return t.slice(0, 4000);
}

function buildAiPrompt(title, text, missingKeys){
  const defs = {
    deg: `- deg: AÇIKÇA istenen eğitim. 0 = şart yok, 1 = Matura/Lehre, 2 = devam eden Bachelor (öğrenci/Werkstudent/Praktikum için "Studium" istenmesi), 3 = tamamlanmış Bachelor, 4 = Master`,
    de: `- de: istenen Almanca seviyesi. 0 = istenmiyor, 1 = A2, 2 = B1, 3 = B2/"gut", 4 = C1-C2/"sehr gut"/fließend/muttersprachlich. İlan Almanca yazılmış olması TEK BAŞINA şart sayılmaz`,
    en: `- en: istenen İngilizce seviyesi, "de" ile aynı ölçek`,
    exp: `- exp: istenen iş deneyimi. 0 = gerekmiyor ya da sadece "von Vorteil"/"idealerweise", 1 = 1-2 yıl ya da "erste Erfahrung" şart, 2 = 3-5 yıl, 3 = 5+ yıl`,
    wm: `- wm: "onsite", "hybrid" ya da "remote" — SADECE metin çalışma modelini açıkça söylüyorsa. "Homeoffice möglich", "mobiles Arbeiten", Homeoffice-Tage = "hybrid". "remote" SADECE iş tamamen uzaktansa (100% remote, ortsunabhängig)`,
    team: `- team: "small" (küçük/samimi ekip) ya da "large" (büyük ekip/departman) — metinde açıkça geçiyorsa`,
    cust: `- cust: 1 (müşteriyle doğrudan temas var) — metinde açıkça geçiyorsa, yoksa null`,
    phys: `- phys: 1 (fiziksel/bedensel çaba gerektiren iş) — metinde açıkça geçiyorsa, yoksa null`,
    shift: `- shift: 1 (vardiyalı/hafta sonu çalışma) — metinde açıkça geçiyorsa, yoksa null`,
    autonomy: `- autonomy: 1 (bağımsız/kendi kararını veren çalışma tarzı vurgulanıyor) ya da 0 (sıkı yönlendirme/talimatla çalışma vurgulanıyor)`,
    variety: `- variety: 1 (çeşitli/değişken görevler vurgulanıyor) ya da 0 (tekrarlayan/rutin görevler vurgulanıyor)`,
    competitive: `- competitive: 1 (rekabetçi/performans odaklı ortam vurgulanıyor) ya da 0`,
    creative: `- creative: 1 (yaratıcılık/yeni fikir üretme vurgulanıyor) ya da 0`,
    leadership: `- leadership: 1 (ekip yönetme/liderlik sorumluluğu var) ya da 0`,
    mobile: `- mobile: 1 (seyahat/saha çalışması gerekiyor) ya da 0`,
    emp: `- emp: çalışma şekli LİSTESİ (birden fazla olabilir): "praktikum", "teilzeit" (Werkstudent/Teilzeit, ~30 saate kadar), "geringfuegig", "vollzeit", "lehre". Metinde yoksa null`,
    certs: `- certs: ilanın ŞART koştuğu belgelerin LİSTESİ ("von Vorteil"/"wünschenswert" olanlar HARİÇ): "fsB" (Führerschein B), "fsC" (C/CE/C95), "fsD" (D/Bus), "stapler", "lap" (Lehrabschluss), "heimhilfe", "pa", "pfa", "dgkp", "elementar" (BAfEP), "sfk". Hiçbiri şart değilse []`,
    f_night: `- f_night: gece/hafta sonu nöbeti — "has" (var) ya da "none" (açıkça yok). Belirtilmemişse null`,
    f_shift: `- f_shift: vardiya modeli — "day" (sadece gündüz), "two" (2 vardiya), "three" (3 vardiya, gece dahil). Belirtilmemişse null`,
    f_place: `- f_place: işin çoğu nerede — "office" (büro, planlama, iç hizmet) ya da "field" (saha, müşteride, şantiye, Außendienst, montaj). Belirsizse null`,
    f_sales: `- f_sales: satış hedefi / Verkaufsziele var mı — "yes" ya da "no". Belirtilmemişse null`,
    f_commission: `- f_commission: provizyon / değişken ücret var mı — "yes" ya da "no". Belirtilmemişse null`,
    f_customers: `- f_customers: müşteriler — "b2b" (şirketler) ya da "b2c" (bireyler). Belirsizse null`,
    f_cold: `- f_cold: soğuk ya da dondurucu depoda çalışma — "yes" ya da "no". Belirtilmemişse null`,
    f_lehramt: `- f_lehramt: öğretmenlik diploması — "required" (Lehramt şart) ya da "open" (Quereinstieg kabul). Belirtilmemişse null`,
    study: `- study: ilanın ŞART koştuğu ya da somut olarak saydığı ÇALIŞMA ALANLARI listesi: "wirt" (Wirtschaft, BWL, VWL, Finance, Wirtschaftsinformatik), "jus" (Jus, Rechtswissenschaften, Wirtschaftsrecht), "tech" (Informatik, Technik, Ingenieurwesen, Mathematik, Statistik, Wirtschaftsinformatik), "nat" (Chemie, Biologie, Physik, Pharmazie, Lebensmittel, Umwelt), "soz" (Sozial-, Geistes-, Sprach-, Kommunikationswissenschaften, Psychologie, Pädagogik), "health" (Medizin, Pflege, Gesundheit). "oder vergleichbar"/"z. B." ile sayılan alanları da yaz. İlan sadece "Studium"/"Studierende aller Fachrichtungen" diyorsa ya da alan söylemiyorsa []`,
    sem: `- sem: ilanın şart koştuğu EN AZ dönem (tam sayı 2-10): "ab dem 3. Semester" → 3, "fortgeschrittenes Studium" → 4, "Masterstudium" şartı → 7. Belirtilmemişse null`,
    start: `- start: işe BAŞLANGIÇ zamanı. "ab sofort", "nächstmöglicher Zeitpunkt", "asap", "immediately" → "asap". Belirli bir ay geçiyorsa → "YYYY-MM" (ör. "ab März 2027" → "2027-03", "Start: 01.02.2027" → "2027-02", "Sommer 2027"/"Juli–August" → "2027-07", "Wintersemester" → o yılın "-10"u). Yıl yazmıyorsa bugünden (${new Date().toISOString().slice(0,7)}) SONRAKİ ilk o ay. Başlangıç bilgisi yoksa null`,
    hrs: `- hrs: haftalık çalışma saati [min, max] sayı dizisi: "20–25 Stunden" → [20,25], "38,5 Stunden" ya da sadece "Vollzeit" → [38.5,38.5], "Teilzeit 30 h" → [30,30], "geringfügig" → [8,11]. Saat ya da Vollzeit/geringfügig bilgisi yoksa null`,
  };
  return [
    `İlan başlığı: "${title || ''}"`,
    `İlan metni: "${trimForAi(text)}"`,
    ``,
    `Bu metinden SADECE şu alanları çıkarmaya çalış: ${missingKeys.join(', ')}`,
    `Alan anlamları:`,
    ...missingKeys.map(k => defs[k]).filter(Boolean),
    ``,
    `Tahmin yürütme: metinde dayanağı yoksa null yaz. Yanlış bir değer, boş bırakmaktan çok daha zararlı.`,
    // 28.09: öğrenme katmanı için — değerin dayandığı ifade. Parser bu ifadeleri biriktirip, farklı
    // şirketlerde tekrar tekrar aynı değeri gösterenleri AI'sız uygulanan kurallara dönüştürüyor.
    `Null OLMAYAN her alan için "_q" nesnesine, metinde o değeri gösteren EN KISA ifadeyi yaz: metinden BİREBİR kopyala (2-6 kelime, değiştirme, çevirme). Şirkete özgü isimler değil, başka ilanlarda da geçebilecek genel ifade seç (ör. "in einem kleinen Team", "im Außendienst", "Führerschein B erforderlich").`,
    `SADECE geçerli JSON döndür, başka hiçbir metin ekleme. Her istenen alan için ya doğru değeri ya da null yaz. Örnek: {"de":4,"wm":null,"autonomy":1,"emp":["vollzeit","teilzeit"],"certs":[],"f_place":"field","study":["wirt"],"hrs":[20,25],"_q":{"de":"sehr gute Deutschkenntnisse","autonomy":"selbstständige Arbeitsweise","emp":"Vollzeit oder Teilzeit","f_place":"im Außendienst"}}`
  ].join('\n');
}

// Her istenen alan için ya geçerli bir değer ya da null döner ("soruldu, bulunamadı" cache'e
// girsin diye — bkz. eski aiExtractSoftFields notu). Ölçek dışı değerler null'a çevrilir.
const AI_ENUMS = {
  emp: ['praktikum', 'teilzeit', 'geringfuegig', 'vollzeit', 'lehre'],
  certs: ['fsB', 'fsC', 'fsD', 'stapler', 'lap', 'heimhilfe', 'pa', 'pfa', 'dgkp', 'elementar', 'sfk'],
  f_night: ['has', 'none'], f_shift: ['day', 'two', 'three'], f_place: ['office', 'field'],
  f_sales: ['yes', 'no'], f_commission: ['yes', 'no'], f_customers: ['b2b', 'b2c'],
  f_cold: ['yes', 'no'], f_lehramt: ['required', 'open'],
  study: ['wirt', 'jus', 'tech', 'nat', 'soz', 'health'],
};
function validateAiFields(parsed, keys){
  const inRange = (v, max) => Number.isInteger(v) && v >= 0 && v <= max;
  const out = {};
  for(const k of keys){
    const v = parsed ? parsed[k] : null;
    if(k === 'team') out[k] = (v === 'small' || v === 'large') ? v : null;
    else if(k === 'wm') out[k] = (v === 'onsite' || v === 'hybrid' || v === 'remote') ? v : null;
    else if(k === 'deg' || k === 'de' || k === 'en') out[k] = inRange(v, 4) ? v : null;
    else if(k === 'exp') out[k] = inRange(v, 3) ? v : null;
    else if(k === 'emp') out[k] = Array.isArray(v) ? [...new Set(v.filter(x => AI_ENUMS.emp.includes(x)))] : null;
    else if(k === 'certs') out[k] = Array.isArray(v) ? [...new Set(v.filter(x => AI_ENUMS.certs.includes(x)))] : null;
    else if(k === 'study') out[k] = Array.isArray(v) ? [...new Set(v.filter(x => AI_ENUMS.study.includes(x)))] : null;
    else if(k === 'start'){ const m = typeof v === 'string' ? v.trim() : ''; out[k] = (m === 'asap' || /^20\d\d-(0[1-9]|1[0-2])$/.test(m)) ? m : null; }
    else if(k === 'sem') out[k] = (Number.isInteger(v) && v >= 2 && v <= 10) ? v : null;
    else if(k === 'hrs'){ const a = Array.isArray(v) ? v.map(Number) : (typeof v === 'number' ? [v, v] : null); out[k] = a && a.length === 2 && a.every(x => x > 0 && x <= 60) && a[0] <= a[1] ? a : null; }
    else if(AI_ENUMS[k]) out[k] = AI_ENUMS[k].includes(v) ? v : null;
    else out[k] = (v === 0 || v === 1) ? v : null;
    if(Array.isArray(out[k]) && out[k].length === 0 && k === 'emp') out[k] = null;
  }
  return out;
}

// items: zaten regex geçmiş, _rawText taşıyan item'lar (bir şirketin target-fit ilanları).
// cache: tüm çalıştırma boyunca paylaşılan { externalUrl: {alan: değer} } sözlüğü.
// budget: { remaining } — MAX_AI_CALLS_PER_RUN'dan başlayan, şirketler arasında paylaşılan sayaç.
// DÜZELTME (Eren'in fark ettiği "preferenceler hep boş kalmış" sorunu — asıl neden burasıydı):
// bir alan AI tarafından BAŞARIYLA bulunduğunda (item[k] = ...) item.estimated dizisinden o alan
// hiç ÇIKARILMIYORDU — estimated dizisi regex geçişinde (guessRequirements içinde, AI hiç
// çalışmadan ÖNCE) bir kere hesaplanıp dondurulmuştu. Yani AI bir alanı gerçekten bulsa bile,
// dışa yazılan JSON'da o alan hâlâ "estimated" (= "tahmin/belirsiz") listesinde görünmeye devam
// ediyordu — AI hiç çalışmamış gibi bir görüntü veriyordu, oysa çalışıyordu, sadece sonucu
// estimated etiketine yansımıyordu.
function applyFieldValue(item, k, v, fromAi, quote, learned){
  if(v === null || v === undefined) return; // bulunamadı — dürüstçe "estimated" kalmaya devam etsin
  item[k] = v;
  if(Array.isArray(item.estimated)){
    const idx = item.estimated.indexOf(k);
    if(idx > -1) item.estimated.splice(idx, 1); // artık tahmin değil, belirlendi
  }
  // Import ekranında elle incelerken hangi değerin AI'dan geldiğini görebilesin diye.
  // 28.09: kaynağı ve dayandığı ifade de yazılıyor: '(AI) „…"' ya da '(öğrenildi) „…"'.
  if(fromAi || learned){
    item.evidence = item.evidence || {};
    if(!item.evidence[k]) item.evidence[k] = (learned ? '(öğrenildi)' : '(AI)') + (quote ? ` „${quote}"` : '');
  }
}


// Modelin cevap metnini doğrulanmış alanlara (+ metinde birebir geçen ifadeler _q) çevirir. Bozuksa null.
function parseAiText(raw, missingKeys, text){
  const jsonMatch = String(raw || '').match(/\{[\s\S]*\}/);
  if(!jsonMatch) return null;
  let parsed; try{ parsed = JSON.parse(jsonMatch[0]); }catch(e){ return null; }
  const out = validateAiFields(parsed, missingKeys);
  const q = {};
  if(parsed && parsed._q && typeof parsed._q === 'object'){
    for(const k of missingKeys){
      const v = out[k];
      if(v === null || v === undefined || (Array.isArray(v) && !v.length)) continue;
      const p = learning.validQuote(parsed._q[k], text);
      if(p) q[k] = p;
    }
  }
  if(Object.keys(q).length) out._q = q;
  return out;
}

// Tek bir anlık çağrı (yerel/elle taramalar için). Hata → null (cache'e yazılmaz, sonra tekrar denenir).
async function aiExtractFields(title, text, missingKeys){
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if(!apiKey) return null;
  try{
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: AI_MODEL, max_tokens: AI_MAX_TOKENS, messages: [{ role: 'user', content: buildAiPrompt(title, text, missingKeys) }] }),
      signal: AbortSignal.timeout(20000),
    });
    if(!res.ok) return null;
    const data = await res.json();
    return parseAiText((data.content && data.content[0] && data.content[0].text) || '', missingKeys, text);
  }catch(e){ return null; }
}

// Cache kaydı: değerler + _q (ifadeler) + _c (şirket, öğrenme eşiği için).
function cacheEntryFrom(prev, aiResult, company){
  const { _q, ...values } = aiResult;
  const entry = { ...(prev || {}), ...values };
  if(_q) entry._q = { ...((prev && prev._q) || {}), ..._q };
  if(company) entry._c = company;
  return entry;
}


// =====================================================================================
// 28.09: ALAN SINIFLANDIRMASI (AI). Sitenin başlık-kelime sınıflandırıcısı sık yanılıyordu
// ("Consultant SIEM, SOC" → Finanz, "Prämieninkasso" → Marketing). Her ilan bir kez, çok kısa ve
// ucuz bir istekle (başlık + firma + metnin başı, cevap tek kelime) sınıflandırılıyor; sonuç cache'e
// "cat" olarak yazılıyor ve bir daha sorulmuyor. Kategori listesi whittle_1.html → LABELS.de.SUB ile BİREBİR aynı.
// "none" = gerçek bir ilan değil (genel sayfa, çerez/video uyarısı, toplu başvuru) → sitede içe aktarılmıyor.
// =====================================================================================
const CATEGORIES = {
  'BIZOFF:finance': 'Finanzen & Buchhaltung',
  'BIZOFF:salesbiz': 'Vertrieb, Sales & Kundenservice',
  'BIZOFF:hr': 'Personalwesen & Recruiting',
  'BIZOFF:admin': 'Büroorganisation & Verwaltung',
  'BIZOFF:legal': 'Recht & Beratung',
  'BIZOFF:supplychain': 'Supply Chain & Einkauf',
  'TECH:swdev': 'Softwareentwicklung',
  'TECH:itsupport': 'IT-Support & Systeme',
  'TECH:data': 'Daten & Analyse',
  'TECH:techpm': 'Tech-Produkt-/Projektmanagement',
  'CREATIVE:design': 'Design (Grafik/Produkt)',
  'CREATIVE:marketing': 'Marketing & Kommunikation',
  'CREATIVE:content': 'Content, Medien & Social',
  'RETAIL:retailsales': 'Verkauf im Einzelhandel',
  'RETAIL:gastro': 'Gastronomie (Küche/Service)',
  'RETAIL:hotel': 'Hotellerie & Tourismus',
  'RETAIL:custservice': 'Kundenservice',
  'RETAIL:events': 'Eventmanagement',
  'HEALTH:medical': 'Medizin & Pflege',
  'HEALTH:therapy': 'Therapie & Gesundheitsberufe',
  'HEALTH:eldercare': 'Altenpflege',
  'HEALTH:socialwork': 'Sozialarbeit & Beratung',
  'HEALTH:childcare': 'Kinderbetreuung & Elementarpädagogik',
  'TRADES:construction': 'Bauwesen',
  'TRADES:handwerk': 'Handwerk (Elektrik, Installation, KFZ)',
  'TRADES:manufacturing': 'Produktion & Fertigung',
  'TRADES:warehouse': 'Lager & Logistik',
  'TRADES:driving': 'Fahren & Transport',
  'EDU:teaching': 'Schulunterricht',
  'EDU:highered': 'Hochschule & Forschung',
  'EDU:publicadmin': 'Öffentliche Verwaltung',
  'EDU:nonprofit': 'NGO & Non-profit',
  'EDU:security': 'Sicherheitsdienst & Ordnung',
  'ENG:electrical': 'Elektrotechnik & Energie',
  'ENG:mechanical': 'Maschinenbau & Konstruktion',
  'ENG:building': 'Gebäudetechnik (TGA/HKLS)',
  'ENG:lab': 'Labor, Chemie & Pharma',
  'ENG:safety': 'Arbeitssicherheit & Umwelt',
};
const CAT_DAILY_LIMIT = 1500; // ~$0.0003/istek (batch, ~650 token girdi) → ilk gün birikmiş ~1500 ilan ≈ $0.5, sonra günde birkaç sent
function buildCatPrompt(title, company, text){
  const snippet = trimForAi(text).slice(0, 700);
  return [
    `Stellenanzeige: "${title || ''}"${company ? ` bei ${company}` : ''}`,
    snippet ? `Anfang des Anzeigentexts: "${snippet}"` : '',
    ``,
    `Ordne die Stelle GENAU EINER Kategorie zu (nach der tatsächlichen Tätigkeit, nicht nach der Branche des Arbeitgebers — z. B. IT-Security bei einer Bank = TECH:itsupport, Marketing bei einem Spital = CREATIVE:marketing):`,
    ...Object.entries(CATEGORIES).map(([k, v]) => `${k} = ${v}`),
    `none = keine echte Stellenanzeige (Übersichtsseite, Cookie-/Video-Hinweis, Initiativbewerbung, Programm-Beschreibung)`,
    ``,
    `Zweite Zeile: der Arbeitsort laut Anzeige als "Stadt, Land" (z. B. "Linz, Österreich" oder "Dessau, Deutschland"), oder "unbekannt".`,
    `Antworte NUR mit diesen zwei Zeilen, z. B.:`,
    `TECH:data`,
    `Wien, Österreich`,
  ].filter(x => x !== '').join('\n');
}
// 29.09: ikinci satır = çalışma yeri. Avusturya modunda konumu okunamayan ilanlarda ("Österreich")
// yurt dışı ilanları ayıklamak ve doğru eyaleti bulmak için. Döner: { city, country, austria } | null
function parseLoc(raw){
  const lines = String(raw || '').split(/\n+/).map(x => x.trim()).filter(Boolean);
  const l = lines[1] || '';
  if(!l || /unbekannt|unknown/i.test(l)) return null;
  const [city, ...rest] = l.replace(/^["'„]|["'“]$/g, '').split(',').map(x => x.trim());
  const country = rest.join(', ');
  return { city: city || '', country, austria: /österreich|austria|^at$/i.test(country || city) };
}
function parseCat(raw){
  const m = String(raw || '').match(/\b([A-Z]+:[a-z]+|none)\b/);
  if(!m) return null;
  return m[1] === 'none' || CATEGORIES[m[1]] ? m[1] : null;
}


// 03.10: KURAL TABANLI KATEGORİ — başlığı tek başına yeterince açık olan seri ilanlar (Zusteller, Lenker,
// Kommissionierer, Verkäufer:in, Koch …) AI'ya sorulmadan sınıflanıyor. 03.10 verisinde AI etiketlerine karşı
// test edildi: 565/1953 ilan, %97 aynı sonuç (farkların çoğu zaten driving↔warehouse sınırında).
// Öğrenci/ofis kelimesi (Praktikum, Leitung, Disposition, Einkauf …) geçen başlıklar her zaman AI'ya gidiyor.
const RULE_CATS = [
  ['TRADES:warehouse', /(vorsortier|kommissionier|lagermitarbeit|lagerist|staplerfahrer|sortierkraft|lagerarbeit)/],
  ['TRADES:driving', /(zusteller|\blenker|fahrer\b|fahrer[*:/]|chauffeur|kraftfahrer|lkw-(fahrer|lenker)|c-führerschein|paketzust|briefzust|kurier)/],
  ['TRADES:warehouse', /(logistikzentrum|paketzentrum|verteilzentrum|lagerlogistik|\blager\b|wareneingang)/],
  ['RETAIL:retailsales', /(verkäufer|verkaufsmitarbeit|verkaufsberater|kassier|filialmitarbeit|filialverkauf|feinkost|regalbetreu)/],
  ['RETAIL:gastro', /\b(koch|köchin|kellner|servicemitarbeit|abwasch|küchenhilfe|barista|commis de|chef de partie|restaurantfach|systemgastronomie)/],
];
const RC_STUDENT = /(praktik|\bintern\b|internship|trainee|werkstudent|working student|studentische|\bstudent\b|ferialpraxis|ferialjob|graduate|absolvent)/;
const RC_OTHER = /(sicherheit|elektrik|techniker|zoll|buchhalt|controll|kaufm|leiter|leitung|manager|teamlead|disponent|disposition|\bit\b|admin|einkauf|recht|personal|\bhr\b|monteur|mechanik|schlosser|instandhalt|marketing|referent|assistenz)/;
function ruleCat(title){
  const t = String(title || '').toLowerCase();
  if(!t || RC_STUDENT.test(t) || RC_OTHER.test(t)) return null;
  for(const [c, re] of RULE_CATS) if(re.test(t)) return c;
  return null;
}
// 03.10: DETAY AI'sı (deg/de/exp/wm …) öğrenci platformu için önemli ilanlara gidiyor. Bu kategorilerde
// alanlar kural tabanlı tahminle kalıyor (başlıkta Praktikum/Trainee/Werkstudent varsa yine AI'ya gider).
const FIELD_AI_SKIP = new Set(['TRADES:driving', 'TRADES:warehouse', 'TRADES:manufacturing', 'TRADES:construction', 'HEALTH:medical', 'HEALTH:eldercare', 'HEALTH:therapy', 'EDU:security']);
const FIELD_AI_BOOST = /^(BIZOFF|TECH|CREATIVE|ENG):/;
function fieldAiPriority(title, cat, loc){
  const t = String(title || '').toLowerCase(), student = RC_STUDENT.test(t);
  if(cat && FIELD_AI_SKIP.has(cat) && !student) return null; // AI'ya gitmez
  return (student ? 50 : 0) + (cat && FIELD_AI_BOOST.test(cat) ? 15 : 0) + (/wien|vienna/i.test(String(loc || '')) ? 20 : 0) - (cat && /^RETAIL:/.test(cat) ? 10 : 0);
}

// 05.10: "mode": "office" şirketleri (SPAR, Post, DHL, MediaMarkt …) — mağaza/depo/şoför ilanları atılıyor,
// sadece merkez ofis + öğrenci ilanları kalıyor. Hem parser'da (AI'dan önce) hem merge'de uygulanıyor.
const FRONTLINE_T = /(verkauf|verkäuf|kassa|kassier|cashier|regal|lager(?!ung)|kommission|filial|marktmanag|marktleit|marktküche|feinkost|fleisch|metzger|\bkoch\b|köch|jungkoch|abwäsch|küchen|florist|friseur|kosmetik|fußpfleg|zusteller|\blenker|fahrer|chauffeur|driver|reinigung|cleaning|\bcrew\b|restaurant|kellner|barista|aushilfe|minijob|samstag|backbox|bäck|konditor|monteur|mechatron|kfz|reifen|werkstatt|haustechnik|handwerk|facility|elektriker|elektro(?!nik)|installat|instandhalt|pflege|dgkp|pädagog|betreuer|heimhilfe|ärzt|arzt|ordinationsassist|fachassistenz|assistenzkraft|empfang|front office|hospitality agent|therapeut|hebamm|apothek|studioleit|\bstore\b|\bshop|sales associate|automobilverk|kundendienstberat|bankbetreuer|gebietsleit|gebietsmanag|telesales|multichannel advisor|lehrling|\blehre\b|schicht|produktionsmitarb|operator)/i;
const OFFICE_T = /(praktik|\bintern\b|internship|trainee|werkstudent|working student|studentisch|student|ferial|graduate|absolvent|junior|controll|buchhalt|accounting|accountant|finanz|finance|\btax\b|steuer|audit|revision|treasury|marketing|kommunikation|communication|social media|content|\bpr\b|brand|crm|e-?commerce|digital|online|\bhr\b|human resources|personal(?!trainer)|recruit|talent|learning|people|payroll|lohnverrechn|einkauf|einkäuf|procurement|purchas|category|supply chain|demand|disponent|disposition|spedit|customs|zoll|bestellwesen|planning|planer|planner|analyst|analytics|\bdata|business intelligence|\bbi\b|\bit\b|software|developer|entwickl|engineer|security|\bsap\b|projekt|project|prozess|process|assistenz|assistant|office|sekretariat|backoffice|administration|verwaltung|legal|recht|jurist|compliance|qualitätsmanag|strateg|key account|account manag|sales executive|business develop|partner manag|product manag|research|consult|referent|specialist|spezialist|sachbearbeit|kaufm|zentrale|headquarter|förder|case manag)/i;
const officeTitle = title => { const t = String(title || ''); return OFFICE_T.test(t) && !FRONTLINE_T.test(t); };


// 08.10: İLAN ÖZETİ (Apply 1. adım, herkese ücretsiz). Kullanıcı başına değil İLAN başına bir kez, gece batch'inde.
// Çıktı ilanın dilinde, kısa JSON. Uydurma yok: sadece ilanda yazan ya da açıkça çıkarılabilen şeyler.
const BRIEF_MAX_TOKENS = 500;
function buildBriefPrompt(title, company, text){
  const t = String(text || '').replace(/\s+\n/g, '\n').slice(0, 3500);
  return `Du analysierst eine österreichische Stellenanzeige für Studierende, die sich bewerben wollen.
Antworte NUR mit JSON in der Sprache der Anzeige (Deutsch oder Englisch), ohne Erklärung:
{"summary":"1 Satz: worum es in der Stelle wirklich geht",
 "must":["max 6 echte Muss-Anforderungen, je max 8 Wörter"],
 "nice":["max 4 Anforderungen, die nur von Vorteil sind"],
 "hidden":["max 3 Dinge zwischen den Zeilen, die die Anzeige nicht direkt sagt, aber erwartet – nur wenn klar ableitbar"],
 "keywords":["max 8 Begriffe aus der Anzeige, die in Lebenslauf und Anschreiben vorkommen sollten"],
 "questions":["max 4 wahrscheinliche Interviewfragen für genau diese Stelle"]}
Regeln: nichts erfinden, was nicht in der Anzeige steht oder klar daraus folgt; leere Listen sind erlaubt; Unternehmensbeschreibung und Benefits ignorieren.

Titel: ${String(title || '').slice(0, 200)}
Unternehmen: ${String(company || '').slice(0, 120)}
Anzeige:
"""
${t}
"""`;
}
function parseBrief(raw){
  try{
    const m = String(raw || '').match(/\{[\s\S]*\}/); if(!m) return null;
    const j = JSON.parse(m[0]);
    const arr = (x, n, len) => Array.isArray(x) ? x.map(v => String(v || '').trim()).filter(v => v && v.length <= len).slice(0, n) : [];
    const b = { summary: String(j.summary || '').trim().slice(0, 240), must: arr(j.must, 6, 120), nice: arr(j.nice, 4, 120), hidden: arr(j.hidden, 3, 200), keywords: arr(j.keywords, 8, 40), questions: arr(j.questions, 4, 200) };
    return (b.must.length || b.summary) ? b : null;
  }catch(e){ return null; }
}

// 08.10: "mindestens 3 bis 5 Jahre Berufserfahrung" gibi yıl ifadeleri hiç okunmuyordu (49 ilandan 42'sinde exp boştu) →
// deneyimsiz öğrenciye 3–5 yıl isteyen Controller ilanı çıkıyordu. Seviye: 0 yok, 1 = 1–2 yıl, 2 = 3–5 yıl, 3 = 5+ yıl.
const YEARS_A = /(?:mindestens|min\.|zumindest|at least|minimum(?: of)?|ab)?\s*(\d{1,2})\s*(?:\+|\s*(?:bis|[-–]|to)\s*\d{1,2})?\s*(?:jahre?n?|years?|yrs)\b[^.\n•]{0,50}?(?:berufserfahrung|berufspraxis|erfahrung|praxis|experience)/i;
const YEARS_B = /(?:berufserfahrung|erfahrung|experience)[^.\n•]{0,40}?(?:von|of)?\s*(?:mindestens|min\.|at least|minimum(?: of)?)?\s*(\d{1,2})\s*(?:\+|\s*(?:bis|[-–]|to)\s*\d{1,2})?\s*(?:jahre?n?|years?)/i;
const MEHRJ = /mehrjährige[nr]?\s+(?:einschlägige[nr]?\s+)?(?:berufs)?erfahrung|several years of (?:professional |relevant )?experience|langjährige[nr]?\s+(?:berufs)?erfahrung|extensive experience/i;
function yearsExp(text){
  const t = String(text || '');
  if(/keine (berufs)?erfahrung (nötig|erforderlich|notwendig)|no (prior )?experience (required|needed)/i.test(t)) return null;
  const m = t.match(YEARS_A) || t.match(YEARS_B);
  if(m){
    const ctx = t.slice(Math.max(0, m.index - 60), m.index + m[0].length + 110); // 23.10: 60 → 110 ("… sind von Vorteil" uzak geliyordu)
    if(/idealerweise|im idealfall|wünschenswert|ideally|preferably|nice to have/i.test(t.slice(Math.max(0, m.index - 45), m.index + 4))) return null; // 23.10: "Idealerweise mindestens 3 Jahre" = şart değil
    // 23.10: maaş örneği ("Bruttogehalt z.B. mit 2 Jahren Berufserfahrung lt. KV") şart değil.
    if(/gehalt|kollektivvertrag|\bkv\b|einstufung|vordienstzeit|anrechnung|salary/i.test(t.slice(Math.max(0, m.index - 80), m.index + m[0].length + 40))) return null;
    // "mindestens 3 Jahre …, idealerweise in einer Gruppe" — 'idealerweise' başka şeye ait; 'mindestens/at least' varsa şart sayılır.
    if(!/mindestens|min\.|zumindest|at least|minimum|erforderlich|required/i.test(m[0]) && /von vorteil|wünschenswert|idealerweise|nice to have|a plus|preferred|gerne/i.test(ctx)) return null;
    const n = Number(m[1]);
    if(n >= 1 && n <= 30) return n >= 5 ? 3 : n >= 3 ? 2 : 1;
  }
  { const mj = t.match(MEHRJ);
    if(mj){ const c2 = t.slice(mj.index, mj.index + mj[0].length + 110);
      if(/von vorteil|wünschenswert|nice to have|a plus|preferred|gerne|idealerweise/i.test(c2)) return null; // 23.10
      return /langjährige|extensive experience/i.test(mj[0]) ? 3 : 2; } }
  return null;
}
module.exports = { yearsExp, buildBriefPrompt, parseBrief, BRIEF_MAX_TOKENS, officeTitle, ruleCat, fieldAiPriority, FIELD_AI_SKIP, parseLoc, CATEGORIES, CAT_DAILY_LIMIT, buildCatPrompt, parseCat, AI_MODEL, AI_MAX_TOKENS, DAILY_AI_LIMIT, SOFT_FIELD_KEYS, HARD_FIELD_KEYS, EXTRA_AI_KEYS, AI_FIELD_KEYS,
  isFieldMissing, trimForAi, buildAiPrompt, AI_ENUMS, validateAiFields, applyFieldValue, parseAiText, aiExtractFields, cacheEntryFrom };
