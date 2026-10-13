// Günlük otomatik içe aktarma (30.09).
// GitHub Actions'taki merge işi bittikten sonra çalışır: whittle.at'i başsız Chrome'da açar, admin
// hesabıyla giriş yapar ve sitenin KENDİ içe aktarma fonksiyonunu (window.whittleAutoImport) bugünkü
// combined dosyasıyla çağırır. Böylece içe aktarma mantığı tek yerde (sitede) kalır; panelde elle
// "Toplu içe aktar" yapmakla birebir aynı sonuç: yeni ilanlar eklenir, eksik alanlar dolar, kaybolanlar
// kapanır, snapshot yenilenir.
//
// Gerekli GitHub Secrets:
//   WHITTLE_ADMIN_EMAIL, WHITTLE_ADMIN_PASSWORD  — admin (trywhittle@gmail.com) girişi
//   APPCHECK_DEBUG_TOKEN                          — Firebase App Check debug token (başsız Chrome reCAPTCHA'yı geçemez)
// Kullanım: node auto-import.js results/whittle-import-2026-09-30-combined.json
const fs = require('fs');
const puppeteer = require('puppeteer');

const SITE = process.env.WHITTLE_SITE || 'https://whittle.at/';
const file = process.argv[2];
const { WHITTLE_ADMIN_EMAIL: email, WHITTLE_ADMIN_PASSWORD: password, APPCHECK_DEBUG_TOKEN: debugToken } = process.env;

(async () => {
  if(!file || !fs.existsSync(file)){ console.log(`❌ Dosya yok: ${file}`); process.exit(1); }
  if(!email || !password || !debugToken){ console.log('⚠️  WHITTLE_ADMIN_EMAIL / WHITTLE_ADMIN_PASSWORD / APPCHECK_DEBUG_TOKEN secret\'ları eksik — otomatik içe aktarma atlandı.'); process.exit(0); }
  const json = fs.readFileSync(file, 'utf8');
  const parsed = JSON.parse(json);
  const n = Array.isArray(parsed) ? parsed.length : (parsed.items || []).length;
  // Güvenlik freni: tarama bir şekilde çöktüyse (ör. 100'den az ilan) siteyi boşaltma.
  if(n < 300){ console.log(`❌ Sadece ${n} ilan var — tarama büyük ihtimalle bozuk, içe aktarma yapılmadı.`); process.exit(1); }

  // 03.10: 1953 ilanla import 3 dk'yı geçti → puppeteer'ın varsayılan protocolTimeout'u (180 sn) yetmedi. 30 dk.
  const browser = await puppeteer.launch({ headless: 'new', protocolTimeout: 30 * 60 * 1000, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  try{
    const page = await browser.newPage();
    page.on('console', m => { const t = m.text(); if(/error|hata|warn/i.test(t)) console.log('  [site]', t.slice(0, 300)); });
    await page.evaluateOnNewDocument(tok => { self.FIREBASE_APPCHECK_DEBUG_TOKEN = tok; }, debugToken);
    await page.goto(SITE, { waitUntil: 'networkidle2', timeout: 90000 });
    await page.waitForFunction(() => typeof window.whittleAutoImport === 'function' && typeof employerLogin === 'function', { timeout: 60000 });
    console.log('🔐 Admin girişi…');
    await page.evaluate((e, p) => employerLogin(e, p), email, password);
    const isAdmin = await page.evaluate(() => !!(state.employer && state.employer.email === ADMIN_EMPLOYER_EMAIL));
    if(!isAdmin){ console.log('❌ Admin girişi başarısız (şifre ya da App Check).'); process.exit(1); }
    console.log(`📥 ${n} ilan içe aktarılıyor…`);
    page.setDefaultTimeout(0);
    const result = await page.evaluate(txt => window.whittleAutoImport(txt), json);
    console.log('✅ Bitti:', JSON.stringify(result));
    if(result.snapshot && result.snapshot.ok === false) { console.log('⚠️  Snapshot yazılamadı:', result.snapshot.reason); process.exit(1); }
  } catch(e){
    console.log('❌ Otomatik içe aktarma hatası:', e.message);
    process.exit(1);
  } finally { await browser.close(); }
})();
