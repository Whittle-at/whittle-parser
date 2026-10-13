// market-stats.js — 30.09: Whittle Apply "Markt-Check" için kategori bazında pazar istatistikleri.
//
// merge-results.js her gün combined dosyasından (bugün + dün, externalUrl'e göre tekil) şunu hesaplıyor:
//   • her alt kategori (aiCat, ör. "BIZOFF:finance") ve üst alan (ör. "BIZOFF") için:
//     – en sık istenen beceriler ve ilanların yüzde kaçında geçtikleri,
//     – Almanca/İngilizce için B2+ ve C1+ isteyen ilan oranı,
//     – ilanda yazan aylık brüt maaşın (Vollzeit'a çevrilmiş) ortancası; Praktikum/Werkstudent/Trainee için ayrıca.
// Sonuç combined.market alanına yazılıyor; otomatik içe aktarma bunu Firestore snapshot/market'e koyuyor,
// Apply oradan okuyor. AI yok, kişi verisi yok — sadece ilan metinlerinden sayım.

// Beceri sözlüğü. Regex'ler KÜÇÜK HARFLİ metne uygulanıyor; aynı kaynak Apply'a da gidiyor (CV'yi aynı kuralla arıyor).
const SKILLS = [
  ['excel', 'Excel', '\\bexcel\\b'],
  ['sap', 'SAP', '\\bsap\\b'],
  ['powerbi', 'Power BI', 'power ?bi\\b'],
  ['sql', 'SQL', '\\bsql\\b'],
  ['python', 'Python', '\\bpython\\b'],
  ['r', 'R (Statistik)', '\\br(?= ?(?:studio|programm|statistik|,\\s*python|\\/python))'],
  ['tableau', 'Tableau', '\\btableau\\b'],
  ['vba', 'VBA', '\\bvba\\b'],
  ['msoffice', 'MS Office', 'ms[ -]?office|microsoft office|office[ -]?paket|m365|microsoft 365'],
  ['powerpoint', 'PowerPoint', 'powerpoint'],
  ['salesforce', 'Salesforce', 'salesforce'],
  ['crm', 'CRM-Systeme', '\\bcrm\\b'],
  ['hubspot', 'HubSpot', 'hubspot'],
  ['datev', 'DATEV/BMD', '\\bdatev\\b|\\bbmd\\b'],
  ['java', 'Java', '\\bjava\\b(?!script)'],
  ['javascript', 'JavaScript/TypeScript', 'javascript|typescript'],
  ['react', 'React', '\\breact\\b'],
  ['cloud', 'Cloud (Azure/AWS/GCP)', '\\bazure\\b|\\baws\\b|google cloud|\\bgcp\\b'],
  ['linux', 'Linux', '\\blinux\\b'],
  ['git', 'Git', '\\bgit\\b|github|gitlab'],
  ['jira', 'Jira/Confluence', '\\bjira\\b|confluence'],
  ['figma', 'Figma', '\\bfigma\\b'],
  ['adobe', 'Adobe (Photoshop/InDesign …)', 'adobe|photoshop|indesign|illustrator|premiere'],
  ['ai', 'KI-Tools', 'künstliche intelligenz|\\bki\\b|\\bai\\b|chatgpt|machine learning|\\bllm'],
  ['accounting', 'Buchhaltung', 'buchhaltung|buchhalt|accounting|bookkeeping|rechnungswesen'],
  ['balance', 'Bilanzierung', 'bilanz|jahresabschluss|financial statements'],
  ['ifrs', 'IFRS/UGB', '\\bifrs\\b|\\bugb\\b|us.gaap'],
  ['controlling', 'Controlling', 'controlling|fp&a|financial planning'],
  ['reporting', 'Reporting', 'reporting|berichtswesen'],
  ['tax', 'Steuern', 'steuerberat|steuerrecht|steuerlehre|steuererklär|steuerwesen|lohnsteuer|umsatzsteuer|\\btax\\b'],
  ['audit', 'Prüfung/Audit', 'wirtschaftsprüfung|\\baudit|revision'],
  ['payroll', 'Lohnverrechnung', 'lohnverrechnung|personalverrechnung|payroll'],
  ['risk', 'Risikomanagement', 'risikomanagement|risk management|\\brisk\\b'],
  ['compliance', 'Compliance', 'compliance|geldwäsche|\\baml\\b|\\bkyc\\b'],
  ['marketing', 'Marketing', 'marketing'],
  ['socialmedia', 'Social Media', 'social media|instagram|tiktok|linkedin'],
  ['seo', 'SEO/SEA', '\\bseo\\b|\\bsea\\b|google ads|suchmaschinen'],
  ['content', 'Content-Erstellung', 'content'],
  ['sales', 'Vertrieb/Sales', 'vertrieb|\\bsales\\b|verkauf(?!s?stell)|akquise'],
  ['procurement', 'Einkauf', 'einkauf|procurement|beschaffung'],
  ['supplychain', 'Logistik/Supply Chain', 'logistik|supply chain|lieferkette'],
  ['projectmgmt', 'Projektmanagement', 'projektmanagement|project management|projektleitung'],
  ['agile', 'Agile/Scrum', '\\bscrum\\b|\\bagil|kanban'],
  ['dataanalysis', 'Datenanalyse', 'datenanalyse|data analy|analytics|auswertung'],
  ['customer', 'Kundenservice', 'kundenservice|kundenbetreuung|customer service|customer support|kundendienst'],
  ['legal', 'Recht', 'rechtswissenschaft|\\bjus\\b|\\blegal\\b|juridisch|jurist'],
  ['hr', 'HR/Recruiting', 'recruiting|personalwesen|\\bhr\\b|human resources|talent acquisition'],
  ['nursing', 'Pflege', '\\bpflege(?:fach|assistenz|kraft|kräfte|dienst|heim|bereich|personal|wissenschaft)|dgkp|gesundheits- und krankenpflege|krankenpflege|altenpflege'],
  ['pedagogy', 'Pädagogik', 'pädagog|\\bhort\\b'],
  ['license', 'Führerschein B', 'führerschein|lenkberechtigung|driving licen'],
  ['forklift', 'Staplerschein', 'stapler'],
  ['cash', 'Kassa', '\\bkassa|\\bkasse\\b|kassier'],
  ['shift', 'Schicht-/Wochenenddienst', 'schichtdienst|schichtarbeit|wochenenddienst|nachtdienst|samstags'],
];
const SKILL_RE = SKILLS.map(([k, , re]) => [k, new RegExp(re)]);

const ENT = { auml:'ä', ouml:'ö', uuml:'ü', Auml:'Ä', Ouml:'Ö', Uuml:'Ü', szlig:'ß', euro:'€', amp:'&', nbsp:' ', ndash:'–' };
const dec = s => String(s || '').replace(/&([a-z]+);/gi, (m, n) => ENT[n] != null ? ENT[n] : m).replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(+d));

// Dil seviyesi (Apply'daki langLevel ile aynı mantık): "Deutsch … C1" ya da "C1 … Deutsch", araya başka dil girmeden.
const LVL = { a1:1, a2:2, b1:3, b2:4, c1:5, c2:6, grundkenntnisse:2, basic:2, gut:4, gute:4, good:4, 'sehr gut':5, 'sehr gute':5, fließend:5, fliessend:5, fluent:5, verhandlungssicher:5, verhandlungssichere:5, excellent:5, muttersprache:6, native:6 };
const LVL_RE = '(a1|a2|b1|b2|c1|c2|grundkenntnisse|basic|sehr gute?|gute?|good|fließend|fliessend|fluent|verhandlungssichere?|excellent|muttersprach\\w*|native)';
const OTHER_LANG = /deutsch|englisch|german|english|französisch|french|türkisch|turkish|spanisch|spanish|italienisch|italian|russisch|kroatisch|serbisch|bosnisch|polnisch|ungarisch|rumänisch/;
function langRank(t, langRe){
  const pick = raw => { raw = raw.replace(/^muttersprach\w*/, 'muttersprache'); return LVL[raw] || LVL[raw.replace(/e$/, '')] || null; };
  const fwd = new RegExp('(?:' + langRe + ')([^.;\\n]{0,40}?)\\b' + LVL_RE + '\\b', 'g'); let m;
  while((m = fwd.exec(t))){ if(!OTHER_LANG.test(m[1])) return pick(m[2]); }
  const bwd = new RegExp('\\b' + LVL_RE + '\\b([^.;\\n]{0,25}?)(?:' + langRe + ')', 'g');
  while((m = bwd.exec(t))){ if(!OTHER_LANG.test(m[2])) return pick(m[1]); }
  return null;
}

// İlandaki ilk maaş tutarı → aylık brüt, Vollzeit karşılığı. Emin olunamayan durumlarda null (istatistiğe girmez).
function parseAmount(s){
  let x = String(s).replace(/[\s ]/g, '').replace(/[.,-]+$/, '');
  if(/,\d{1,2}$/.test(x)) x = x.replace(/,\d{1,2}$/, '');            // 2.745,32 → 2.745
  else if(/\.\d{1,2}$/.test(x) && /[,.]\d{3}/.test(x.slice(0, -3))) x = x.replace(/\.\d{1,2}$/, ''); // 2,745.32 → 2,745
  const v = Number(x.replace(/[.,]/g, ''));
  return Number.isFinite(v) && v > 0 ? v : null;
}
function monthlyFullTime(salaryText){
  const t = dec(salaryText);
  if(!t) return null;
  // 02.10: ilk tutar Prämie/Bonus/Zuschuss ise (Sixt "Prämie von EUR 1.500") atla, sonrakine bak.
  const RE = /(?:€|eur(?:o)?)\s*([0-9][0-9.,\s ]{1,12}[0-9]|[0-9]{3,6})|([0-9][0-9.,\s ]{1,12}[0-9])\s*(?:,-+\s*)?(?:€|eur)/ig;
  const BONUS_BEFORE = /(?:prämie|praemie|bonus|zuschuss|gutschein|refer|empfehlung|fitness|budget|guthaben|klimaticket|jobticket|essens|weiterbildung|umzug|relocation|sign.?on)[^.!?€]{0,40}$/i;
  let m = null, mm;
  while((mm = RE.exec(t))){ if(!BONUS_BEFORE.test(t.slice(Math.max(0, mm.index - 60), mm.index))){ m = mm; break; } }
  if(!m) return null;
  let v = parseAmount(m[1] || m[2]);
  if(!v) return null;
  const ctx = t.slice(Math.max(0, m.index - 200), m.index + m[0].length + 150).toLowerCase();
  const after = t.slice(m.index + m[0].length, m.index + m[0].length + 30).toLowerCase();
  if(v < 60 && /stunde|\/h|hour/.test(after)) return null;
  if(v >= 15000) v = v / 14; // yıllık brüt (Avusturya: 14 maaş)
  const full = /vollzeit|full.?time|38[,.]5|40\s*(wochen)?stunden|40\s*h\b/.test(ctx);
  const h = ctx.match(/\b(\d{1,2})\s*(?:wochenstunden|stunden|std\.?|h)\b/);
  if(!full && h && +h[1] >= 5 && +h[1] < 38) v = v * 38.5 / +h[1];
  return v >= 800 && v <= 15000 ? Math.round(v) : null;
}
const STUDENT_RE = /praktik|\bintern\b|internship|werkstudent|studentische|ferial|trainee|studentenjob|student job/i;
const pct = (a, q) => { if(a.length < 4) return null; const s = [...a].sort((x, y) => x - y); return Math.round(s[Math.min(s.length - 1, Math.floor(q * (s.length - 1) + 0.5))]); };
const median = a => { if(!a.length) return null; const s = [...a].sort((x, y) => x - y), i = s.length >> 1; return Math.round(s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2); };

// Kategori başına en fazla 24 maaşlı ilan: tekrarlar atılır, maaşa göre sıralanıp eşit aralıklarla seçilir (tüm aralık görünsün).
function pickAds(ads){
  const seen = new Set(), uniq = ads.filter(a => { const k = (a.t + '|' + a.c).toLowerCase(); if(seen.has(k)) return false; seen.add(k); return true; }).sort((a, b) => a.s - b.s);
  if(uniq.length <= 24) return uniq;
  const out = []; for(let i = 0; i < 24; i++) out.push(uniq[Math.round(i * (uniq.length - 1) / 23)]);
  return out;
}
// 02.10: ilanın yazıldığı dil (blog "Jobs in Vienna without German" için). Almanca yazılmış ilan Almancayı
// açıkça istemese bile bekler; "İngilizce'ye açık" = İngilizce yazılmış VE Almanca ≥B2 istemeyen ilan.
const DE_SW = /\b(und|der|die|das|mit|für|wir|du|sie|ist|eine?|bei|von|zu|auf|im|nicht|deine?|ihre?|unser(e|en)?|oder|sowie)\b/g;
const EN_SW = /\b(and|the|with|for|we|you|is|of|to|in|our|your|are|will|or|as|this|that)\b/g;
function adLang(t){ const s = String(t || '').toLowerCase().slice(0, 4000); const d = (s.match(DE_SW) || []).length, e = (s.match(EN_SW) || []).length; return d + e < 15 ? null : (e > d * 1.3 ? 'en' : 'de'); }
function buildMarketStats(items, labels){
  const groups = new Map();
  const add = (key, it) => { if(!groups.has(key)) groups.set(key, []); groups.get(key).push(it); };
  items.forEach(it => {
    const cat = it.aiCat;
    if(!cat || cat === 'none' || !/^[A-Z]+:[a-z]+$/.test(cat)) return;
    add(cat, it); add(cat.split(':')[0], it);
  });
  const out = {};
  for(const [key, arr] of groups){
    if(arr.length < 10) continue;
    const sk = {}; let deB2 = 0, deC1 = 0, enB2 = 0, enC1 = 0, alN = 0, alDeImpl = 0, alOpenEn = 0; const sal = [], stuSal = []; let stu = 0;
    const ads = [], fx = { deg: { hi: [], lo: [] }, exp: { hi: [], lo: [] } }; // 01.10: Apply "Gehaltsvorstellung" için
    arr.forEach(it => {
      let text = dec(it._adText || it._rawText || '').toLowerCase();
      const lang = adLang(text);
      // "Wir bieten"/Benefits bölümü sayılmasın (Betriebskindergarten, Steuervorteile … beceri değil).
      const off = text.search(/wir bieten|was wir bieten|das bieten wir|unser angebot|what we offer|we offer|deine vorteile|ihre vorteile|benefits:/);
      if(off > 300) text = text.slice(0, off);
      text += ' ' + String(it.title || '').toLowerCase();
      SKILL_RE.forEach(([k, re]) => { if(re.test(text)) sk[k] = (sk[k] || 0) + 1; });
      const d = langRank(text, 'deutsch|german'), e = langRank(text, 'englisch|english');
      if(d >= 4) deB2++; if(d >= 5) deC1++; if(e >= 4) enB2++; if(e >= 5) enC1++;
      if(lang){ alN++; if(d < 4){ if(lang === 'de') alDeImpl++; else alOpenEn++; } }
      const isStu = STUDENT_RE.test(it.title || '') || (Array.isArray(it.emp) && it.emp.includes('praktikum'));
      if(isStu) stu++;
      const m = monthlyFullTime(it._salaryText);
      if(m){
        sal.push(m); if(isStu) stuSal.push(m);
        ads.push({ t: String(it.title || '').replace(/\s+/g, ' ').trim().slice(0, 80), c: String(it.companyName || '').slice(0, 40), s: m, u: isStu ? 1 : 0 });
        if(it.deg != null) (Number(it.deg) >= 3 ? fx.deg.hi : fx.deg.lo).push(m);
        if(it.exp != null) (Number(it.exp) >= 1 ? fx.exp.hi : fx.exp.lo).push(m);
      }
    });
    const n = arr.length, share = x => Math.round(x / n * 100) / 100;
    const skills = Object.entries(sk).map(([k, c]) => [k, share(c)]).filter(([, s]) => s >= 0.08).sort((a, b) => b[1] - a[1]).slice(0, 18);
    out[key] = {
      l: labels[key] || null, n, stu,
      sk: Object.fromEntries(skills),
      de: { b2: share(deB2), c1: share(deC1) }, en: { b2: share(enB2), c1: share(enC1) },
      al: alN >= 10 ? { n: alN, deExp: Math.round((alN - alDeImpl - alOpenEn) / alN * 100) / 100, deImpl: Math.round(alDeImpl / alN * 100) / 100, openEn: Math.round(alOpenEn / alN * 100) / 100 } : null,
      sal: sal.length >= 5 ? { med: median(sal), n: sal.length, p25: pct(sal, 0.25), p75: pct(sal, 0.75) } : null,
      stuSal: stuSal.length >= 5 ? { med: median(stuSal), n: stuSal.length } : null,
      ads: pickAds(ads),
      fx: Object.fromEntries(Object.entries(fx).filter(([, g]) => g.hi.length >= 4 && g.lo.length >= 4).map(([k, g]) => [k, { hi: [median(g.hi), g.hi.length], lo: [median(g.lo), g.lo.length] }])),
    };
  }
  // 03.10: işveren profili (Apply Pro "Was dieser Arbeitgeber sucht" + Listing Insights). En az 3 ilanı olan şirketler.
  const byCo = new Map();
  items.forEach(it => { const k = String(it.companyName || '').trim(); if(!k) return; if(!byCo.has(k)) byCo.set(k, []); byCo.get(k).push(it); });
  const co = {};
  for(const [name, arr] of byCo){
    if(arr.length < 3) continue;
    const sk = {}; let deB2 = 0, enB2 = 0, exp = 0, expN = 0, deg = 0, degN = 0, stu = 0; const sal = [], cats = {};
    arr.forEach(it => {
      const text = dec(it._adText || it._rawText || '').toLowerCase() + ' ' + String(it.title || '').toLowerCase();
      SKILL_RE.forEach(([k, re]) => { if(re.test(text)) sk[k] = (sk[k] || 0) + 1; });
      if(langRank(text, 'deutsch|german') >= 4) deB2++; if(langRank(text, 'englisch|english') >= 4) enB2++;
      if(it.exp != null){ expN++; if(Number(it.exp) >= 1) exp++; }
      if(it.deg != null){ degN++; if(Number(it.deg) >= 3) deg++; }
      if(STUDENT_RE.test(it.title || '')) stu++;
      const m = monthlyFullTime(it._salaryText); if(m) sal.push(m);
      if(it.aiCat && it.aiCat !== 'none') cats[it.aiCat] = (cats[it.aiCat] || 0) + 1;
    });
    const n = arr.length, r2 = x => Math.round(x * 100) / 100;
    co[name] = { n, stu, de: r2(deB2 / n), en: r2(enB2 / n), exp: expN >= 3 ? r2(exp / expN) : null, deg: degN >= 3 ? r2(deg / degN) : null,
      sal: sal.length >= 2 ? { med: median(sal), n: sal.length } : null,
      sk: Object.fromEntries(Object.entries(sk).map(([k, c]) => [k, r2(c / n)]).filter(([, v]) => v >= 0.2).sort((a, b) => b[1] - a[1]).slice(0, 8)),
      cats: Object.fromEntries(Object.entries(cats).sort((a, b) => b[1] - a[1]).slice(0, 4)) };
  }
  return { v: 1, n: items.length, skills: SKILLS.map(([k, l, re]) => ({ k, l, re })), cats: out, co };
}

module.exports = { buildMarketStats, monthlyFullTime, langRank, SKILLS };
