// x-cards.js — X post taslakları için görsel + kısa video (05.10)
//
// x-posts.js'in yazdığı results/x-posts.json'dan her taslak için 1200×675 PNG kart, ilk 3 taslak için
// ~5 sn'lik MP4 (sayı sayarak artıyor, çubuklar doluyor) üretir → x-paket/ klasörü:
//   x-paket/01.png, 01.mp4, 01.txt (yapıştırılacak metin) … + index.html (telefonda/bilgisayarda hepsini gör)
// GitHub Actions bu klasörü "x-paket-<tarih>" adıyla çalıştırmanın sayfasına zip olarak koyuyor (repoya girmez).
// Kullanım: node x-cards.js   (puppeteer + ffmpeg gerekli; ffmpeg yoksa sadece PNG)
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
let puppeteer; try { puppeteer = require('puppeteer'); } catch (e) { puppeteer = require('puppeteer-core'); }

const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'results', 'x-posts.json'), 'utf8'));
const out = path.join(__dirname, 'x-paket');
fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
const VIDEOS = Number(process.env.X_VIDEOS || 3);
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const W = 1280, H = 720; // X 16:9; video için çift sayı şart
function html(card){
  const rows = (card.rows || []).filter(Boolean);
  const bigNum = card.big ? card.big.match(/^(€?)([\d.]+)(%?)$/) : null;
  return `<!doctype html><html><head><meta charset="utf-8">
${process.env.X_NOFONTS ? '' : '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=Space+Grotesk:wght@600;700&display=block" rel="stylesheet">'}
<style>
  :root{ --p:1; --bg:#FFFAF3; --ink:#2B2016; --muted:#6B5E54; --brand:#C2410C; --bright:#F97316; --track:#F6E7D6; }
  *{box-sizing:border-box;margin:0;padding:0}
  body{width:${W}px;height:${H}px;background:var(--bg);font-family:Inter,'Helvetica Neue',Arial,sans-serif;color:var(--ink);
    padding:60px 80px 52px;display:flex;flex-direction:column;position:relative;overflow:hidden}
  body::before{content:'';position:absolute;right:-180px;top:-180px;width:520px;height:520px;border-radius:50%;
    background:radial-gradient(circle,rgba(249,115,22,.18),rgba(249,115,22,0) 70%)}
  .top{display:flex;justify-content:space-between;align-items:center}
  .kicker{font:700 22px Inter,sans-serif;letter-spacing:2.5px;text-transform:uppercase;color:var(--brand)}
  .logo{font:700 30px 'Space Grotesk',sans-serif;color:var(--ink);letter-spacing:-.5px}
  .logo span{color:var(--bright)}
  .main{flex:1;display:flex;flex-direction:column;justify-content:center;gap:${rows.length ? 26 : 14}px}
  .big{font:700 ${rows.length ? 132 : 200}px/0.95 'Space Grotesk',sans-serif;letter-spacing:-4px;color:var(--brand)}
  .bigSub{font:600 ${rows.length ? 30 : 40}px/1.25 Inter,sans-serif;color:var(--ink);max-width:960px}
  .title{font:700 56px/1.1 'Space Grotesk',sans-serif;letter-spacing:-1px;max-width:1000px}
  .rows{display:flex;flex-direction:column;gap:${rows.length > 4 ? 12 : 18}px;margin-top:4px}
  .row{display:grid;grid-template-columns:330px 1fr 140px;align-items:center;gap:22px}
  .row .l{font:600 ${rows.length > 4 ? 23 : 26}px Inter,sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .row .v{font:700 ${rows.length > 4 ? 26 : 30}px 'Space Grotesk',sans-serif;text-align:right}
  .bar{height:${rows.length > 4 ? 18 : 24}px;border-radius:999px;background:var(--track);overflow:hidden}
  .bar i{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,var(--brand),var(--bright));width:calc(var(--w) * var(--p))}
  .foot{display:flex;justify-content:space-between;font:400 19px Inter,sans-serif;color:var(--muted);border-top:2px solid var(--track);padding-top:18px}
</style></head><body>
  <div class="top"><div class="kicker">${esc(card.kicker)}</div><div class="logo">whittle<span>.</span>at</div></div>
  <div class="main">
    ${card.title ? `<div class="title">${esc(card.title)}</div>` : ''}
    ${card.big ? `<div class="big" id="big" data-pre="${bigNum ? bigNum[1] : ''}" data-num="${bigNum ? bigNum[2].replace(/\./g, '') : ''}" data-suf="${bigNum ? bigNum[3] : ''}">${esc(card.big)}</div>` : ''}
    ${card.bigSub ? `<div class="bigSub">${esc(card.bigSub)}</div>` : ''}
    ${rows.length ? `<div class="rows">${rows.map(([l, v, f]) => `<div class="row"><div class="l">${esc(l)}</div><div class="bar"><i style="--w:${Math.max(0.02, Math.min(1, f || 0)) * 100}%"></i></div><div class="v">${esc(v)}</div></div>`).join('')}</div>` : ''}
  </div>
  <div class="foot"><div>Quelle: ${card.n ? card.n + ' aktuelle Stellenanzeigen' : 'aktuelle Stellenanzeigen'} · Stand ${esc(data.dd)}</div><div>Alle Jobs: whittle.at</div></div>
<script>
  window.setP = p => {
    document.documentElement.style.setProperty('--p', p);
    const b = document.getElementById('big');
    if (b && b.dataset.num) { const n = Math.round(Number(b.dataset.num) * p); b.textContent = b.dataset.pre + String(n).replace(/\\B(?=(\\d{3})+(?!\\d))/g, '.') + b.dataset.suf; }
  };
</script></body></html>`;
}

(async () => {
  const browser = await puppeteer.launch({ headless: 'new', executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  let hasFfmpeg = true; try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch (e) { hasFfmpeg = false; }
  const list = [];
  for (const p of data.posts) {
    const id = String(p.i).padStart(2, '0');
    fs.writeFileSync(path.join(out, `${id}.txt`), p.text + '\n');
    if (!p.card) { list.push({ id, p, img: null, vid: null }); continue; }
    const page = await browser.newPage(); // her kart yeni sekmede (takılan bir sayfa diğerlerini bozmasın)
    await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
    await page.setContent(html(p.card), { waitUntil: 'load', timeout: 30000 }).catch(() => {});
    await Promise.race([page.evaluate(() => document.fonts && document.fonts.ready.then(() => 1)), new Promise(r => setTimeout(r, 5000))]).catch(() => {});
    await page.screenshot({ path: path.join(out, `${id}.png`) });
    let vid = null;
    if (hasFfmpeg && p.i <= VIDEOS) {
      // 0.4 sn boş → 1.6 sn animasyon (ease-out) → 3 sn sabit = 5 sn, 30 fps
      const fdir = fs.mkdtempSync(path.join(out, 'f')); const FPS = 30, total = 150;
      for (let f = 0; f < total; f++) {
        const t = Math.max(0, Math.min(1, (f / FPS - 0.4) / 1.6)), e = 1 - Math.pow(1 - t, 3);
        await page.evaluate(v => window.setP(v), e);
        await page.screenshot({ path: path.join(fdir, `${String(f).padStart(3, '0')}.png`) });
      }
      try {
        execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', path.join(fdir, '%03d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart', path.join(out, `${id}.mp4`)]);
        vid = `${id}.mp4`;
      } catch (e) { console.log(`  ⚠️  Video ${id}: ${e.message}`); }
      fs.rmSync(fdir, { recursive: true, force: true });
    }
    await page.close().catch(() => {});
    list.push({ id, p, img: `${id}.png`, vid });
  }
  await browser.close();
  // index.html: hepsi tek sayfada; "Kopieren" ile metin panoya
  const idx = `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>X-Paket ${esc(data.dd)}</title>
<style>body{font-family:Inter,system-ui,sans-serif;background:#FFFAF3;color:#2B2016;margin:0;padding:16px;max-width:760px;margin:auto}
h1{font-size:22px}.post{background:#fff;border:1px solid #F0DCC5;border-radius:14px;padding:16px;margin:16px 0}
pre{white-space:pre-wrap;font:15px/1.45 system-ui,sans-serif;margin:10px 0}img,video{width:100%;border-radius:10px;border:1px solid #F0DCC5}
button{background:#C2410C;color:#fff;border:0;border-radius:999px;padding:8px 16px;font-weight:600;cursor:pointer}small{color:#8A817A}</style></head><body>
<h1>X-Paket · ${esc(data.dd)}</h1><small>${list.length} Entwürfe · Bild/Video speichern, Text kopieren, posten.</small>
${list.map(x => `<div class="post"><small>${x.id} · ${esc(x.p.key)} · ${x.p.text.length} Zeichen</small><pre id="t${x.id}">${esc(x.p.text)}</pre>
<button onclick="navigator.clipboard.writeText(document.getElementById('t${x.id}').innerText);this.textContent='Kopiert ✓'">Text kopieren</button>
${x.vid ? `<p><video src="${x.vid}" controls muted playsinline></video></p>` : ''}${x.img ? `<p><img src="${x.img}" alt=""></p>` : ''}</div>`).join('')}
</body></html>`;
  fs.writeFileSync(path.join(out, 'index.html'), idx);
  console.log(`🖼️  X-Paket: ${list.filter(x => x.img).length} Bilder, ${list.filter(x => x.vid).length} Videos → x-paket/`);
})().catch(e => { console.log(`⚠️  x-cards: ${e.message}`); process.exit(0); });
