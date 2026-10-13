// coverage-report.js — "her öğrenci profili için kaç işe yarar ilan var?" (03.10)
//
// Toplam ilan sayısı öğrenciye bir şey söylemiyor. Bu script tipik WU öğrenci profillerini alıp
// combined dosyasında her biri için kaç uygun ilan olduğunu sayar. Az çıkan profil = eklenecek şirketler.
// Kullanım: node coverage-report.js [YYYY-AA-GG]   → results/coverage.md + konsol
const fs = require('fs');
const path = require('path');
const outDir = path.join(__dirname, 'results');
const files = fs.readdirSync(outDir).filter(f => /^whittle-import-\d{4}-\d{2}-\d{2}-combined\.json$/.test(f)).sort();
const file = process.argv[2] ? `whittle-import-${process.argv[2]}-combined.json` : files[files.length - 1];
// Tarayıcıyla taranan şirketler 2 günde bir geliyor → son 2 günün dosyası birleştiriliyor (URL'ye göre tekil).
const idx = files.indexOf(file), use = files.slice(Math.max(0, idx - 1), idx + 1);
const seen = new Map();
for (const f of use.reverse()) for (const it of (JSON.parse(fs.readFileSync(path.join(outDir, f), 'utf8')).items || [])) if (!seen.has(it.externalUrl)) seen.set(it.externalUrl, it);
const items = [...seen.values()];

const WIEN = /\b(wien|vienna|1[0-2]\d0)\b/i;
const STUDENT = it => /praktik|\bintern|trainee|werkstudent|working student|studentisch|\bstudent|ferial|graduate|absolvent|junior/i.test(it.title || '')
  || (Array.isArray(it.emp) && it.emp.some(e => e === 'praktikum' || e === 'teilzeit' || e === 'geringfuegig'));
const noSenior = it => !(it.exp != null && Number(it.exp) >= 2);
const deOk = max => it => it.de == null || Number(it.de) <= max; // de: 0 yok … 4 C1+
const cat = re => it => re.test(it.aiCat || '');

const PROFILES = [
  ['Finance / Controlling / Accounting', cat(/^BIZOFF:finance$/)],
  ['Consulting / Audit / Tax', cat(/^BIZOFF:legal$/)],
  ['Marketing / Kommunikation', cat(/^CREATIVE:(marketing|content)$/)],
  ['HR', cat(/^BIZOFF:hr$/)],
  ['Sales / Business Development', cat(/^BIZOFF:salesbiz$/)],
  ['Supply Chain / Einkauf', cat(/^BIZOFF:supplychain$/)],
  ['Data / Analytics', cat(/^TECH:data$/)],
  ['IT / Software', cat(/^TECH:(swdev|itsupport|techpm)$/)],
  ['Office / Assistenz', cat(/^BIZOFF:admin$/)],
];
const rows = PROFILES.map(([name, fn]) => {
  const base = items.filter(it => fn(it) && STUDENT(it) && noSenior(it));
  const wien = base.filter(it => WIEN.test(it.sourceNote || ''));
  const entry = items.filter(it => fn(it) && !STUDENT(it) && WIEN.test(it.sourceNote || '') && (it.exp == null || Number(it.exp) === 0) && it.seniorityGuess !== 'senior').length;
  const en = wien.filter(deOk(2)); // Almanca en fazla B1 / belirtilmemiş
  const sal = wien.filter(it => it._salaryText);
  const cos = new Set(wien.map(it => it.companyName)).size;
  return { name, all: base.length, wien: wien.length, entry, en: en.length, sal: sal.length, cos };
});
const flag = r => r.wien < 10 ? ' ⚠️' : '';
const md = [
  `# Kapsam raporu — ${file.slice(15, 25)}`, '',
  `Son 2 günün dosyası birleşik (${use.join(', ')}). "Öğrenci ilanı" = Praktikum/Werkstudent/Trainee/Junior; "Deneyimsiz normal ilan" = Wien'de, öğrenci kelimesi yok ama deneyim şartı da yok.`, '',
  '| Profil | Öğrenci ilanı (AT) | Öğrenci ilanı (Wien) | + Deneyimsiz normal ilan (Wien) | Wien, Almanca ≤ B1 | Wien, maaşlı | Wien işveren |',
  '| --- | --- | --- | --- | --- | --- | --- |',
  ...rows.map(r => `| ${r.name}${flag(r)} | ${r.all} | ${r.wien} | ${r.entry} | ${r.en} | ${r.sal} | ${r.cos} |`),
  `| **Toplam** | ${rows.reduce((a, r) => a + r.all, 0)} | ${rows.reduce((a, r) => a + r.wien, 0)} | ${rows.reduce((a, r) => a + r.entry, 0)} | | | |`, '',
  '⚠️ = Wien\'de 10\'dan az ilan: bu alan için yeni şirket eklemek öncelikli.',
].join('\n');
fs.writeFileSync(path.join(outDir, 'coverage.md'), md + '\n');
console.log(md);
