// x-posts.js — X (Twitter) için günlük post taslakları (05.10)
//
// Her gün merge'den sonra combined dosyalarından ~12 farklı taslak üretir → results/x-posts.md.
// • 15+ farklı açı (sayı, maaş, dil, beceri, yan haklar, "Überzahlung", Junior mitleri, sezon …) × alanlar × DE/EN
// • results/x-posts-history.json: son 21 günde önerilen açı+konu bir daha önerilmez → her gün başka postlar.
// • Şirket ismi YOK. Sadece gerçek sayılar; az veriyle (n < 8) istatistik yapılmaz.
// • Link: whittle.at/?source=x → admin panelinde X'ten gelen ziyaretler ayrı görünür.
// Kullanım: node x-posts.js [YYYY-AA-GG]
const fs = require('fs');
const path = require('path');
const { monthlyFullTime } = require('./market-stats');

const outDir = path.join(__dirname, 'results');
const files = fs.readdirSync(outDir).filter(f => /^whittle-import-\d{4}-\d{2}-\d{2}-combined\.json$/.test(f)).sort();
const want = process.argv[2] ? `whittle-import-${process.argv[2]}-combined.json` : files[files.length - 1];
const date = want.slice(15, 25);
const load = f => { try { return JSON.parse(fs.readFileSync(path.join(outDir, f), 'utf8')).items || []; } catch (e) { return []; } };

// Bugün + dün (tarayıcı şirketleri 2 günde bir) → URL'ye göre tekil havuz
const idx = files.indexOf(want);
const pool = new Map();
for (const f of files.slice(Math.max(0, idx - 1), idx + 1).reverse()) for (const it of load(f)) if (it.externalUrl && !pool.has(it.externalUrl)) pool.set(it.externalUrl, it);
const items = [...pool.values()];
// "Bu hafta yeni": son 7 günde ilk kez görülen URL'ler (önceki tüm dosyalara göre)
const firstSeen = new Map();
for (const f of files.slice(0, idx + 1)) { const d = f.slice(15, 25); for (const it of load(f)) if (it.externalUrl && !firstSeen.has(it.externalUrl)) firstSeen.set(it.externalUrl, d); }
const daysAgo = d => Math.round((new Date(date) - new Date(d)) / 86400000);
const haveWeekHistory = files.length && daysAgo(files[0].slice(15, 25)) >= 10;

// ---------- yardımcılar ----------
const WIEN = /\b(wien|vienna|1[0-2]\d0)\b/i;
const STU = /praktik|\bintern\b|internship|trainee|werkstudent|working student|studentisch|student|ferial|graduate|absolvent/i;
const txt = it => String(it._adText || it._rawText || '');
const low = it => txt(it).toLowerCase();
const isWien = it => WIEN.test(it.sourceNote || '');
const isStu = it => STU.test(it.title || '') || (Array.isArray(it.emp) && it.emp.includes('praktikum'));
const pc = (a, b) => b ? Math.round(a / b * 100) : 0;
const fmtEur = v => '€' + String(Math.round(v / 10) * 10).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : null; };
const sal = it => monthlyFullTime(it._salaryText || '');
const isEnglishAd = it => { const t = ' ' + low(it).slice(0, 2500) + ' '; const en = (t.match(/ (the|and|you|with|our|your|we) /g) || []).length, de = (t.match(/ (und|die|der|mit|wir|sie|du|für) /g) || []).length; return en > 12 && en > de * 2; };
const deOk = it => it.de != null && Number(it.de) <= 2 && !(Array.isArray(it.estimated) && it.estimated.includes('de')); // ilanda açıkça B1'e kadar (bilinmeyen sayılmaz)
const noGer = it => deOk(it) || isEnglishAd(it); // açıkça B1'e kadar ya da ilan tamamen İngilizce
const deC1 = it => it.de != null && Number(it.de) >= 4;

const FIELDS = [ // [anahtar, aiCat regex, DE adı, EN adı]
  ['finance', /^BIZOFF:finance$/, 'Finance & Controlling', 'finance & controlling'],
  ['consulting', /^BIZOFF:legal$/, 'Consulting, Audit & Tax', 'consulting, audit & tax'],
  ['marketing', /^CREATIVE:(marketing|content)$/, 'Marketing & Kommunikation', 'marketing & comms'],
  ['hr', /^BIZOFF:hr$/, 'HR', 'HR'],
  ['sales', /^BIZOFF:salesbiz$/, 'Sales & Business Development', 'sales & BD'],
  ['supply', /^BIZOFF:supplychain$/, 'Supply Chain & Einkauf', 'supply chain & procurement'],
  ['data', /^TECH:data$/, 'Data & Analytics', 'data & analytics'],
  ['it', /^TECH:(swdev|itsupport|techpm)$/, 'IT & Software', 'IT & software'],
  ['office', /^BIZOFF:admin$/, 'Office & Assistenz', 'office & admin'],
];
const inField = re => it => re.test(it.aiCat || '');
const BIZ = /^(BIZOFF|TECH|CREATIVE):/;
const wienStu = items.filter(it => isWien(it) && isStu(it) && BIZ.test(it.aiCat || ''));
const wienBiz = items.filter(it => isWien(it) && BIZ.test(it.aiCat || ''));

// ---------- açılar (her biri birden çok aday üretir) ----------
// Her aday: key, text (X'e yapıştırılacak metin, link hariç ≤ 255 karakter) ve card (x-cards.js'in görsele çevirdiği veri).
const C = [];
const LINK = 'whittle.at/?source=x';
const dd = date.slice(8, 10) + '.' + date.slice(5, 7) + '.' + date.slice(0, 4);
const add = (key, text, card) => { if (!text || text.length > 255) { if (text) console.log(`  (zu lang, übersprungen: ${key}, ${text.length})`); return; } C.push({ key, text, card }); };
const cap = x => String(x).charAt(0).toUpperCase() + String(x).slice(1);
const SHORT = { finance: 'Finance', consulting: 'Consulting/Audit/Tax', marketing: 'Marketing', hr: 'HR', sales: 'Sales/BD', supply: 'Supply Chain', data: 'Data', it: 'IT', office: 'Office' };
const rows = (arr, n) => arr.map(([l, c]) => [l, `${pc(c, n)}%`, n ? c / n : 0]);

// 1) Alan başına öğrenci ilanı sayısı + Almanca şartı
for (const [k, re, de, en] of FIELDS) {
  const a = wienStu.filter(inField(re)); if (a.length < 20) continue; // 05.10: 8 → 20 (küçük sayılar zayıf duruyordu)
  const ok = a.filter(noGer).length, hy = a.filter(it => it.wm === 'hybrid' || it.wm === 'remote').length;
  const card = { kicker: 'Wien · ' + de, big: String(a.length), bigSub: 'offene Praktika & Werkstudentenjobs', rows: [['ohne fließendes Deutsch', String(ok), ok / a.length], ['hybrid oder remote', String(hy), hy / a.length]], n: a.length };
  add(`count:${k}`, `${de} studieren und in Wien was Praktisches suchen?\n\nGerade offen: ${a.length} Praktika & Werkstudentenjobs.${ok >= 3 ? `\n${ok} davon ohne fließendes Deutsch.` : ''}${hy >= 3 ? `\n${hy} hybrid oder remote.` : ''}\n\nAlle an einem Ort:`, card);
  add(`count-en:${k}`, `Studying in Vienna and looking for something in ${en}?\n\nOpen right now: ${a.length} internships & working-student jobs.${ok >= 3 ? `\n${ok} don't require fluent German.` : ''}${hy >= 3 ? `\n${hy} are hybrid or remote.` : ''}\n\nAll in one place:`, { ...card, kicker: 'Vienna · ' + en, bigSub: 'open internships & working-student jobs', rows: [['no fluent German needed', String(ok), ok / a.length], ['hybrid or remote', String(hy), hy / a.length]] });
}
// 2) Almancasız iş
{ const ok = wienStu.filter(noGer), en = wienStu.filter(isEnglishAd), c1 = wienStu.filter(deC1);
  if (wienStu.length >= 30) {
    add('nogerman', `"You can't get a job in Vienna without German."\n\nWe checked ${wienStu.length} open student jobs in business & tech:\n• ${pc(ok.length, wienStu.length)}% don't ask for fluent German\n• ${en.length} are written entirely in English\n• only ${pc(c1.length, wienStu.length)}% want C1\n\nFind them:`,
      { kicker: 'Vienna · student jobs', title: `German isn't always required`, rows: [['no fluent German needed', `${pc(ok.length, wienStu.length)}%`, ok.length / wienStu.length], ['ad written in English', `${pc(en.length, wienStu.length)}%`, en.length / wienStu.length], ['German C1 required', `${pc(c1.length, wienStu.length)}%`, c1.length / wienStu.length]], n: wienStu.length });
    add('nogerman-de', `Deutsch ist nicht immer Pflicht.\n\nVon ${wienStu.length} offenen Studentenjobs in Wien (Business & Tech):\n• ${en.length} komplett auf Englisch ausgeschrieben\n• ${pc(ok.length, wienStu.length)}% ohne fließendes Deutsch\n• nur ${pc(c1.length, wienStu.length)}% verlangen C1\n\nHier filtern:`,
      { kicker: 'Wien · Studentenjobs', title: 'Wie viel Deutsch wirklich verlangt wird', rows: [['kein fließendes Deutsch nötig', `${pc(ok.length, wienStu.length)}%`, ok.length / wienStu.length], ['Anzeige auf Englisch', `${pc(en.length, wienStu.length)}%`, en.length / wienStu.length], ['Deutsch C1 verlangt', `${pc(c1.length, wienStu.length)}%`, c1.length / wienStu.length]], n: wienStu.length });
  } }
// 3) Maaş: alan bazında öğrenci medyanı + aralık
const stuSal = {};
const q = (a, f) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(f * (s.length - 1) + 0.5))]; };
for (const [k, re, de, en] of FIELDS) {
  const v = items.filter(it => isStu(it) && inField(re)(it)).map(sal).filter(Boolean);
  if (v.length < 12) continue; const m = median(v), lo = q(v, 0.25), hi = q(v, 0.75); stuSal[k] = { m, n: v.length, de, en };
  const card = { kicker: 'Österreich · Praktikum ' + de, big: fmtEur(m), bigSub: 'Median brutto/Monat (Vollzeit gerechnet)', rows: [['untere 25 %', fmtEur(lo), lo / hi], ['Median', fmtEur(m), m / hi], ['obere 25 %', fmtEur(hi), 1]], n: v.length };
  add(`sal:${k}`, `Was zahlt ein Praktikum in ${de} in Österreich?\n\nMedian aus ${v.length} aktuellen Anzeigen: ${fmtEur(m)} brutto/Monat (auf Vollzeit gerechnet).\nDie mittlere Hälfte liegt zwischen ${fmtEur(lo)} und ${fmtEur(hi)}.\n\nGehalt vor der Bewerbung checken:`, card);
  add(`sal-en:${k}`, `What does a ${en} internship in Austria actually pay?\n\nMedian of ${v.length} current job ads: ${fmtEur(m)} gross/month (full-time equivalent).\nMiddle half: ${fmtEur(lo)} to ${fmtEur(hi)}.\n\nCheck before you apply:`, { ...card, kicker: 'Austria · ' + en + ' internship', bigSub: 'median gross/month (full-time equivalent)', rows: [['lower 25%', fmtEur(lo), lo / hi], ['median', fmtEur(m), m / hi], ['upper 25%', fmtEur(hi), 1]] });
}
// 4) Maaş sıralaması (05.10: iki alanlı karşılaştırma kaldırıldı — nüansı anlatmıyordu)
{ const ks = Object.keys(stuSal).sort((a, b) => stuSal[b].m - stuSal[a].m);
  if (ks.length >= 4) {
    const card = { kicker: 'Österreich · Praktikumsgehälter', title: 'Welche Praktika am besten zahlen', rows: ks.slice(0, 6).map(k => [`${stuSal[k].de} (${stuSal[k].n})`, fmtEur(stuSal[k].m), stuSal[k].m / stuSal[ks[0]].m]), n: ks.reduce((s, k) => s + stuSal[k].n, 0) };
    add('salrank', `Welche Praktika in Österreich am besten zahlen (Median brutto/Monat, Vollzeit gerechnet):\n\n${ks.slice(0, 5).map((k, i) => `${i + 1}. ${SHORT[k]}: ${fmtEur(stuSal[k].m)}`).join('\n')}\n\nBasis: ${ks.slice(0, 5).reduce((s2, k) => s2 + stuSal[k].n, 0)} Anzeigen mit Gehaltsangabe.`, card);
    add('salrank-en', `Which internships in Austria pay best (median gross/month, full-time equivalent):\n\n${ks.slice(0, 5).map((k, i) => `${i + 1}. ${SHORT[k]}: ${fmtEur(stuSal[k].m)}`).join('\n')}\n\nBased on ${ks.slice(0, 5).reduce((s2, k) => s2 + stuSal[k].n, 0)} ads that state a salary.`,
      { ...card, kicker: 'Austria · internship pay', title: 'Which internships pay best', rows: ks.slice(0, 6).map(k => [`${stuSal[k].en} (${stuSal[k].n})`, fmtEur(stuSal[k].m), stuSal[k].m / stuSal[ks[0]].m]) });
  } }
// 5) En çok istenen beceri (alan bazında)
const SK = [['Excel', /\bexcel\b/], ['SAP', /\bsap\b/], ['Power BI', /power ?bi\b/], ['SQL', /\bsql\b/], ['Python', /\bpython\b/], ['PowerPoint', /powerpoint/], ['Salesforce', /salesforce/], ['Tableau', /tableau/], ['Figma', /\bfigma\b/], ['Adobe', /adobe|photoshop|indesign/], ['KI-Tools', /künstliche intelligenz|\bki\b|chatgpt|\bai\b/], ['Projektmanagement', /projektmanagement|project management/], ['Jira', /\bjira\b/]];
const skEn = n => ({ 'KI-Tools': 'AI tools', 'Projektmanagement': 'Project management' }[n] || n);
for (const [k, re, de, en] of FIELDS) {
  const a = items.filter(it => isStu(it) && inField(re)(it)); if (a.length < 15) continue;
  const r = SK.map(([n, sre]) => [n, a.filter(it => sre.test(low(it))).length]).sort((x, y) => y[1] - x[1]).filter(x => x[1] > 0).slice(0, 5);
  if (r.length < 3 || r[0][1] / a.length < 0.25) continue; // 06.10: zayıf sinyal (en çok istenen < %25) → post yok
  const card = { kicker: 'Österreich · ' + de + '-Praktika', title: 'Diese Skills stehen in den Anzeigen', rows: rows(r, a.length), n: a.length };
  add(`skill:${k}`, `Was in ${a.length} aktuellen ${de}-Praktika in Österreich verlangt wird:\n\n${r.slice(0, 4).map(([n, c]) => `${n}: ${pc(c, a.length)}%`).join('\n')}\n\nWenn du dieses Semester nur eins lernst: ${r[0][0]}.\nPasst dein CV? Check:`, card);
  add(`skill-en:${k}`, `What ${a.length} current ${en} internship ads in Austria ask for:\n\n${r.slice(0, 4).map(([n, c]) => `${skEn(n)}: ${pc(c, a.length)}%`).join('\n')}\n\nIf you learn one thing this semester: ${skEn(r[0][0])}.\nDoes your CV match? Check:`,
    { ...card, kicker: 'Austria · ' + en + ' internships', title: 'Skills the ads ask for', rows: r.map(([n, c]) => [skEn(n), `${pc(c, a.length)}%`, c / a.length]) });
}
// 6) KI-Tools teknoloji dışı alanlarda
for (const [k, re, de, en] of FIELDS.filter(f => !['it', 'data'].includes(f[0]))) {
  const a = items.filter(inField(re)); if (a.length < 25) continue;
  const c = a.filter(it => /künstliche intelligenz|\bki\b|chatgpt|\bai\b|\bllm/.test(low(it))).length;
  if (c < 4) continue;
  const card = { kicker: 'Österreich · ' + de, big: `${pc(c, a.length)}%`, bigSub: 'der Anzeigen erwähnen KI oder KI-Tools', n: a.length };
  add(`ai:${k}`, `KI ist kein IT-Thema mehr.\n\n${pc(c, a.length)}% der aktuellen ${de}-Stellen in Österreich erwähnen KI oder KI-Tools in der Anzeige. Das sind ${c} von ${a.length}.\n\nWer "ChatGPT im Alltag" in den CV schreibt, sollte Beispiele parat haben.`, card);
  add(`ai-en:${k}`, `AI isn't just an IT topic anymore.\n\n${pc(c, a.length)}% of current ${en} job ads in Austria mention AI or AI tools – ${c} out of ${a.length}.\n\nIf your CV says "familiar with ChatGPT", have a concrete example ready.`, { ...card, kicker: 'Austria · ' + en, bigSub: 'of ads mention AI or AI tools' });
}
// 7) "Junior" mitleri
{ const j = items.filter(it => /\bjunior\b/i.test(it.title || '') && it.exp != null), e = j.filter(it => Number(it.exp) >= 1);
  if (j.length >= 20) {
    const card = { kicker: 'Österreich · Junior-Stellen', big: `${pc(e.length, j.length)}%`, bigSub: 'verlangen mindestens 1 Jahr Erfahrung', n: j.length };
    add('junior', `"Junior" heißt nicht "ohne Erfahrung".\n\n${pc(e.length, j.length)}% der aktuellen Junior-Stellen in Österreich verlangen schon mindestens 1 Jahr Berufserfahrung.\n\nDeshalb zählt jedes Praktikum und jeder Werkstudentenjob während des Studiums.`, card);
    add('junior-en', `"Junior" doesn't mean "no experience".\n\n${pc(e.length, j.length)}% of current junior job ads in Austria already ask for 1+ years of work experience.\n\nThat's why internships and working-student jobs during your degree matter.`, { ...card, kicker: 'Austria · junior roles', bigSub: 'ask for at least 1 year of experience' }); } }
// 8) (05.10: Überzahlung postu kaldırıldı)
// 9) Yan haklar
const BEN = [['Klimaticket / Öffi-Ticket', 'Public transport ticket', /klimaticket|jahreskarte|öffi-?ticket|jobticket|wiener linien jahres/], ['Gleitzeit', 'Flexible hours', /gleitzeit|flexible arbeitszeit|flexible working hours/], ['Homeoffice', 'Home office', /home ?office|remote|mobiles arbeiten|hybrid/], ['Essenszuschuss', 'Meal allowance', /essenszuschuss|essensgutschein|kantine|mittagessen|lunch/], ['Weiterbildung', 'Training budget', /weiterbildung|schulungen|training budget|learning budget/], ['4-Tage-Woche', '4-day week', /4-tage-woche|vier-tage-woche|4 day week/]];
if (wienBiz.length >= 80) {
  const r = BEN.map(([n, ne, re]) => [n, wienBiz.filter(it => re.test(low(it))).length, ne]).sort((x, y) => y[1] - x[1]);
  const card = { kicker: 'Wien · Benefits', title: 'Was Arbeitgeber versprechen', rows: rows(r.slice(0, 6), wienBiz.length), n: wienBiz.length };
  add('benefits', `Was Wiener Arbeitgeber gerade in Stellenanzeigen versprechen (${wienBiz.length} Business- & Tech-Stellen):\n\n${r.slice(0, 5).map(([n, c]) => `${n}: ${pc(c, wienBiz.length)}%`).join('\n')}\n\nWas fehlt dir auf der Liste?`, card);
  add('benefits-en', `What Vienna employers promise in job ads right now (${wienBiz.length} business & tech roles):\n\n${r.slice(0, 5).map(([, c, ne]) => `${ne}: ${pc(c, wienBiz.length)}%`).join('\n')}\n\nWhat's missing from the list?`, { ...card, kicker: 'Vienna · benefits', title: 'What employers promise', rows: r.slice(0, 6).map(([, c, ne]) => [ne, `${pc(c, wienBiz.length)}%`, c / wienBiz.length]) });
}
// 10) Çalışma modeli
for (const [k, re, de, en] of FIELDS) {
  const a = wienBiz.filter(it => inField(re)(it) && it.wm); if (a.length < 20) continue;
  const h = a.filter(it => it.wm === 'hybrid').length, r = a.filter(it => it.wm === 'remote').length, o = a.length - h - r;
  const card = { kicker: 'Wien · ' + de, title: 'Büro, hybrid oder remote?', rows: rows([['Hybrid', h], ['Nur Büro', o], ['Voll remote', r]], a.length), n: a.length };
  add(`wm:${k}`, `Homeoffice in ${de}? So sieht es in Wien gerade aus (${a.length} aktuelle Stellen):\n\nHybrid: ${pc(h, a.length)}%\nVoll remote: ${pc(r, a.length)}%\nNur Büro: ${pc(o, a.length)}%${r / a.length < 0.1 ? '\n\nVoll remote bleibt die Ausnahme.' : ''}`, card);
  add(`wm-en:${k}`, `Remote work in ${en}? Here's Vienna right now (${a.length} current roles):\n\nHybrid: ${pc(h, a.length)}%\nFully remote: ${pc(r, a.length)}%\nOffice only: ${pc(o, a.length)}%${r / a.length < 0.1 ? '\n\nFully remote is still the exception.' : ''}`, { ...card, kicker: 'Vienna · ' + en, title: 'Office, hybrid or remote?', rows: rows([['Hybrid', h], ['Office only', o], ['Fully remote', r]], a.length) });
}
// 11) Teilzeit / geringfügig
{ const g = wienBiz.filter(it => Array.isArray(it.emp) && it.emp.includes('geringfuegig')), t = wienBiz.filter(it => Array.isArray(it.emp) && it.emp.includes('teilzeit'));
  if (t.length >= 20) {
    const card = { kicker: 'Wien · neben dem Studium', big: String(t.length), bigSub: 'Teilzeitstellen in Business & Tech', rows: g.length >= 3 ? [['davon geringfügig', String(g.length), g.length / t.length]] : null, n: wienBiz.length };
    add('teilzeit', `Neben dem Studium arbeiten, aber nicht im Café oder an der Kassa?\n\nGerade offen in Wien: ${t.length} Teilzeitstellen in Business & Tech${g.length >= 3 ? `, ${g.length} davon geringfügig` : ''}.\n\nFinance, Marketing, Data, Office – gefiltert nach deinem Profil:`, card);
    add('teilzeit-en', `Want a part-time job next to your degree – but not in a café?\n\nOpen in Vienna right now: ${t.length} part-time roles in business & tech${g.length >= 3 ? ` (${g.length} of them "geringfügig", i.e. mini-jobs)` : ''}.\n\nFinance, marketing, data, office – filtered to your profile:`, { ...card, kicker: 'Vienna · next to your studies', bigSub: 'part-time roles in business & tech', rows: g.length >= 3 ? [['mini-jobs (geringfügig)', String(g.length), g.length / t.length]] : null });
  } }
// 12) Sezon
{ const y = Number(date.slice(0, 4)) + 1, a = items.filter(it => new RegExp(`(sommer|summer)\\s*(praktikum|internship)?\\s*${y}|(sommer|summer)[- ]?${y}|${y}`).test(low(it)) && isStu(it));
  if (a.length >= 15) {
    const card = { kicker: 'Österreich · Praktika ' + y, big: String(a.length), bigSub: `Anzeigen erwähnen schon ${y}`, n: items.filter(isStu).length };
    add(`season:${y}`, `Sommerpraktikum ${y}? Die Bewerbungsphase läuft schon.\n\n${a.length} aktuelle Studenten-Anzeigen in Österreich erwähnen bereits ${y}. Bei Big Four, Banken und Konzernen ist Herbst/Winter die Hauptsaison.\n\nJetzt schauen:`, card);
    add(`season-en:${y}`, `Summer internship ${y}? Applications are already open.\n\n${a.length} current student job ads in Austria already mention ${y}. Big Four firms, banks and corporates mostly hire for summer in autumn and winter.\n\nLook now:`, { ...card, kicker: 'Austria · internships ' + y, bigSub: `ads already mention ${y}` });
  } }
// 13) İşveren tipi — 0 olan satırlar gösterilmiyor (05.10)
{ const T = [['konzern', 'Konzerne', 'Corporates'], ['beratung', 'Beratung, Big Four & Kanzleien', 'Consulting, Big Four & law firms'], ['startup', 'Start-ups', 'Start-ups'], ['public', 'Öffentlich & Uni', 'Public sector & universities'], ['ngo', 'NGOs', 'NGOs']]
    .map(([t, de, en]) => [de, en, wienStu.filter(it => it.employerType === t).length]).filter(x => x[2] >= 3).sort((a, b) => b[2] - a[2]);
  if (wienStu.length >= 50 && T.length >= 3) {
    const card = { kicker: 'Wien · Studentenjobs', title: 'Wer gerade Studierende sucht', rows: T.map(([de, , n]) => [de, String(n), n / wienStu.length]), n: wienStu.length };
    add('emptype', `Wer in Wien gerade Studierende sucht (Business & Tech, ${wienStu.length} offene Stellen):\n\n${T.map(([de, , n]) => `${de}: ${n}`).join('\n')}`, card);
    add('emptype-en', `Who's hiring students in Vienna right now (business & tech, ${wienStu.length} open roles):\n\n${T.map(([, en, n]) => `${en}: ${n}`).join('\n')}`, { ...card, kicker: 'Vienna · student jobs', title: "Who's hiring students", rows: T.map(([, en, n]) => [en, String(n), n / wienStu.length]) });
  } }
// 14) C1 sıralaması
{ const r = FIELDS.map(([k, re, de, en]) => { const a = wienBiz.filter(inField(re)); return [de, a.filter(deC1).length, a.length, en]; }).filter(x => x[2] >= 20).sort((a, b) => b[1] / b[2] - a[1] / a[2]);
  if (r.length >= 4) {
    const card = { kicker: 'Wien · Deutsch C1 verlangt', title: 'Wo C1 wirklich zählt', rows: r.slice(0, 6).map(([n, c, t]) => [n, `${pc(c, t)}%`, c / t]), n: r.reduce((s, x) => s + x[2], 0) };
    add('c1rank', `In welchen Bereichen du in Wien am ehesten Deutsch C1 brauchst (Anteil der Anzeigen):\n\n${r.slice(0, 3).map(([n, c, t]) => `${n}: ${pc(c, t)}%`).join('\n')}\n\nAm wenigsten: ${r[r.length - 1][0]} (${pc(r[r.length - 1][1], r[r.length - 1][2])}%)`, card);
    add('c1rank-en', `Where in Vienna you most likely need C1 German (share of job ads):\n\n${r.slice(0, 3).map(([, c, t, en]) => `${cap(en)}: ${pc(c, t)}%`).join('\n')}\n\nLeast: ${cap(r[r.length - 1][3])} (${pc(r[r.length - 1][1], r[r.length - 1][2])}%)`, { ...card, kicker: 'Vienna · C1 German required', title: 'Where C1 German really matters', rows: r.slice(0, 6).map(([, c, t, en]) => [cap(en), `${pc(c, t)}%`, c / t]) });
  } }
// 15) Bu hafta yeni
if (haveWeekHistory) {
  const nw = wienStu.filter(it => firstSeen.has(it.externalUrl) && daysAgo(firstSeen.get(it.externalUrl)) <= 6);
  const by = FIELDS.map(([k, re, de, en]) => [de, nw.filter(inField(re)).length, en]).sort((a, b) => b[1] - a[1]);
  if (nw.length >= 15) {
    const card = { kicker: 'Wien · diese Woche', big: String(nw.length), bigSub: 'neue Praktika & Werkstudentenjobs', rows: by.slice(0, 4).map(([n, c]) => [n, String(c), c / nw.length]), n: nw.length };
    add(`week:${date}`, `Diese Woche neu in Wien: ${nw.length} Praktika & Werkstudentenjobs in Business & Tech.\n\nAm meisten in:\n${by.slice(0, 3).map(([n, c]) => `${n}: ${c}`).join('\n')}\n\nNeue Stellen jeden Tag:`, card);
    add(`week-en:${date}`, `New in Vienna this week: ${nw.length} internships & working-student jobs in business & tech.\n\nMost in:\n${by.slice(0, 3).map(([, c, en]) => `${cap(en)}: ${c}`).join('\n')}\n\nNew roles every day:`, { ...card, kicker: 'Vienna · this week', bigSub: 'new internships & working-student jobs', rows: by.slice(0, 4).map(([, c, en]) => [cap(en), String(c), c / nw.length]) });
  }
}
// 16) Deneyimsiz normal işler
{ const a = wienBiz.filter(it => !isStu(it) && it.exp != null && Number(it.exp) === 0 && it.seniorityGuess !== 'senior');
  if (a.length >= 30) {
    const card = { kicker: 'Wien · Einstieg', big: String(a.length), bigSub: 'reguläre Stellen ohne Berufserfahrung', n: wienBiz.length };
    add('noexp', `Nicht jeder Einstiegsjob heißt "Praktikum".\n\nIn Wien sind gerade ${a.length} reguläre Stellen in Business & Tech offen, die keine Berufserfahrung verlangen.\n\nWer nur nach "Praktikum" sucht, sieht die nicht. Wir zeigen beides:`, card);
    add('noexp-en', `Not every entry-level job is called "internship".\n\nVienna has ${a.length} regular business & tech roles open right now that ask for no work experience.\n\nIf you only search "internship", you miss them. We show both:`, { ...card, kicker: 'Vienna · entry level', bigSub: 'regular roles, no experience required' });
  } }

// ---------- seçim: geçmişte önerilmemiş, açı başına en fazla 1, ~12 taslak ----------
const histFile = path.join(outDir, 'x-posts-history.json');
let hist = {}; try { hist = JSON.parse(fs.readFileSync(histFile, 'utf8')); } catch (e) {}
const recent = new Set(Object.entries(hist).filter(([, d]) => daysAgo(d) < 21 && d !== date).map(([k]) => k));
let seed = [...date].reduce((s, ch) => s * 31 + ch.charCodeAt(0) >>> 0, 7);
const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296;
const fresh = C.filter(c => !recent.has(c.key)).map(c => ({ ...c, r: rnd() })).sort((a, b) => a.r - b.r);
// 06.10: dil dengesi — her açıdan tek varyant, sırayla DE / EN tercih ediliyor (~yarı yarıya İngilizce).
const isEN = k => /^[a-z0-9]+-en(:|$)/.test(k) || k === 'nogerman';
const angleOf = k => k.split(':')[0].replace(/-.*$/, '');
const base = k => k.replace('-en', '').replace('nogerman-de', 'nogerman'), pick = [], has = c => pick.some(p => base(p.key) === base(c.key));
{ const byAngle = new Map(); for (const c of fresh) { const a = angleOf(c.key); if (!byAngle.has(a)) byAngle.set(a, []); byAngle.get(a).push(c); }
  let wantEN = rnd() < 0.5;
  for (const [, pool] of byAngle) { if (pick.length >= 12) break; const c = pool.find(x => isEN(x.key) === wantEN) || pool[0]; pick.push(c); wantEN = !wantEN; }
  for (const c of fresh) { if (pick.length >= 12) break; if (!has(c) && isEN(c.key) === (pick.filter(p => isEN(p.key)).length < pick.length / 2)) pick.push(c); }
  for (const c of fresh) { if (pick.length >= 12) break; if (!has(c)) pick.push(c); } }
// Taze aday azsa: en uzun süredir önerilmeyenlerle doldur (sayılar o arada değişmiş oluyor).
if (pick.length < 12) for (const c of C.filter(c => !has(c)).sort((a, b) => (hist[a.key] || '').localeCompare(hist[b.key] || ''))) { if (pick.length >= 12) break; if (!has(c)) pick.push(c); }
pick.forEach(c => { hist[c.key] = date; });
for (const [k, d] of Object.entries(hist)) if (daysAgo(d) > 60) delete hist[k];
fs.writeFileSync(histFile, JSON.stringify(hist, null, 1));

const md = [`# X-Post-Entwürfe — ${date}`, '', `${pick.length} Entwürfe aus ${items.length} aktuellen Anzeigen (${C.length} mögliche, die der letzten 21 Tage ausgelassen). Link am Ende anhängen: ${LINK}`, '',
  ...pick.map((c, i) => `## ${i + 1}. \`${c.key}\`\n\n${c.text}\n\n${LINK}\n`)].join('\n');
fs.writeFileSync(path.join(outDir, 'x-posts.md'), md + '\n');
fs.writeFileSync(path.join(outDir, 'x-posts.json'), JSON.stringify({ date, dd, link: LINK, posts: pick.map((c, i) => ({ i: i + 1, key: c.key, text: c.text + '\n\n' + LINK, card: c.card })) }, null, 1));
console.log(`🐦 X-Entwürfe: ${pick.length} (aus ${C.length} möglichen) → results/x-posts.md`);
