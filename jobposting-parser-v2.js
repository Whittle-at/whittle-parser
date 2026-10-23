#!/usr/bin/env node
// jobposting-parser-v2.js — v1'den farkı: gerçek bir (headless) tarayıcı açıp JS'in çalışmasını
// bekliyor, SONRA schema.org/JobPosting verisini arıyor. Personio gibi JS ile render eden
// siteler için bu şart — ham HTML'de bir şey yoktu çünkü içerik JS çalışınca oluşuyordu.
//
// YENİ: Greenhouse ve Lever için tarayıcıya HİÇ gerek yok — ikisi de gerçek, halka açık,
// belgelenmiş JSON API sunuyor. URL doğrudan boards.greenhouse.io/jobs.lever.co ise ya da
// şirketin kendi career sayfası (ör. careers.şirket.com) arkada bu ikisinden birini
// kullanıyorsa (gömülü iframe/link olarak), parser bunu tespit edip doğrudan API'den çekiyor.
// Bu yol JSON-LD/chunk-split/tıklama-tahmini gibi kırılgan adımların hepsini atlıyor — daha
// hızlı ve daha güvenilir. Personio gibi bu ikisi olmayan siteler için eski akış (tarayıcı +
// JSON-LD + chunk-split + tıklama denemesi) aynen çalışmaya devam ediyor.
//
// YENİ (2): --batch modu — bir dosyaya (satır başına bir URL, opsiyonel "url,şehir" formatı)
// birden fazla şirket verip tek komutla hepsini sırayla işletebilirsin; sonunda tüm şirketlerin
// ilanları TEK bir JSON bloğunda birleşip yazdırılıyor. Bir şirket hata verirse atlanır, kalanlar
// devam eder.
//
// YENİ (3): Her ilan için deg/de/en/exp/wm'nin yanına nicheGuess de ekleniyor — Whittle'ın şu an
// canlıdaki 3 alan grubundan (Finance/Tech/Marketing) hangisine en çok benzediği, başlık+açıklama
// metnindeki keyword sayımıyla TAHMİN ediliyor. Bu da diğerleri gibi kesin değil — eşleşme yoksa
// ya da eşitse null dönüyor, elle seçilmesi gerektiği anlamına geliyor.
//
// YENİ (4): Greenhouse/Lever'in yanına Recruitee, Workable ve SmartRecruiters de eklendi — bu 5
// platformun hepsi gerçek, halka açık, dokümante JSON API sunuyor. NOT: WordPress/özel siteler
// "ATS'siz" değil, parser'ın EN BAŞTA denediği yöntem (schema.org/JobPosting JSON-LD) tam olarak
// bunun için var — platformdan bağımsız, Google Jobs'ta görünmek isteyen her site (WordPress dahil)
// bunu SEO amaçlı ekler. Sadece SEO'ya hiç önem vermeyen küçük/özel siteler bunu hiç eklemez, o
// zaman chunk-split/tıklama tahminine (ya da hiçbir yapılandırılmış veriye) düşülür.
//
// Kurulum (bir kere, terminalde):
//   npm install puppeteer
//   (ATS API yolları için Node 18+ gerekiyor — global fetch() kullanıyor)
//
// Kullanım:
//   node jobposting-parser-v2.js "https://şirket.jobs.personio.de/"
//   node jobposting-parser-v2.js "https://boards.greenhouse.io/sirket"
//   node jobposting-parser-v2.js "https://jobs.lever.co/sirket"
//   node jobposting-parser-v2.js "https://sirket.recruitee.com/"
//   node jobposting-parser-v2.js "https://apply.workable.com/sirket/"
//   node jobposting-parser-v2.js "https://jobs.smartrecruiters.com/sirket"
//   node jobposting-parser-v2.js "https://careers.sirket.com" Wien   (5 ATS'i de kendi career sayfasının altına gömen şirketler için otomatik tespit çalışır)
//   node jobposting-parser-v2.js --batch companies.txt Wien           (companies.txt: satır başına 1 URL, ya da "url,şehir")
//   node jobposting-parser-v2.js "https://..." "*"                    (şehir filtresi yerine "*"/"any"/"alle" ver — TEK şehirli şirketler için, sayfa hiç şehir adı yazmıyorsa örn. OeKB)

// 30.09: puppeteer ilk kullanıldığında yükleniyor — merge-results.js bu dosyadaki filtreleri kullanabilsin diye
// (merge işinde puppeteer kurulu değil).
let _puppeteer = null;
const puppeteer = new Proxy({}, { get: (_, k) => (_puppeteer || (_puppeteer = require('puppeteer')))[k] });
const fs = require('fs');
const path = require('path');
const learning = require('./ai-learning'); // 28.09: kendi kendine öğrenme katmanı (bkz. ai-learning.js)

function extractJsonLd(html){
  const blocks = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while((m = re.exec(html))){
    try{ blocks.push(JSON.parse(m[1].trim())); }catch(e){ /* bozuk JSON-LD, atla */ }
  }
  return blocks;
}

function findJobPostings(blocks){
  const jobs = [];
  function walk(node){
    if(!node) return;
    if(Array.isArray(node)){ node.forEach(walk); return; }
    if(typeof node !== 'object') return;
    const type = node['@type'];
    if(type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'))) jobs.push(node);
    Object.values(node).forEach(walk);
  }
  blocks.forEach(walk);
  return jobs;
}

// Sayfanın ham metni tek bir uzun cümle gibi geliyor (ayraç yok) — ama Personio'da her ilan kaydı
// genelde bir istihdam-türü etiketiyle bitiyor: Almanca "Teilzeit/Vollzeit" + "Befristet/
// Festanstellung", ya da İNGİLİZCE sayfalarda "Full-time/Part-time" + "Permanent employee/
// Temporary employee/Contract/Internship/Freelance". DÜZELTME: eski versiyon sadece Almanca
// kalıbı arıyordu — İngilizce arayüzlü Personio sayfalarında (ör. Optimuse) hiç sınır bulunamıyor,
// o sayfadaki TÜM ilanlar tek bir dev chunk'a birleşiyordu. Artık ikisi de destekleniyor.
// Bazı şirketler Almanca sayfada bile şehir adını İngilizce yazıyor (EY'de "Standort: Vienna"
// gördük, Almanca sayfada "Wien" değil) — düz "Wien" filtresi bunları sessizce eler. Bilinen
// eş anlamlıları da kabul eden bir regex kuruyoruz.
const CITY_ALIASES = { wien: 'vienna', vienna: 'wien' };
// 28.09: Avusturya geneli mod. Şirket config'inde "city":"AT" (ya da WHITTLE_REGION=AT ortam değişkeni)
// verilince, sadece Wien değil Avusturya'daki her konum kabul ediliyor; yurt dışı konumlar hâlâ eleniyor.
// Posta kodları bilerek YOK: İsviçre'nin de 4 haneli posta kodu var ("8001 Zürich").
const AT_PLACES = [
  'wien','vienna','österreich','oesterreich','austria',
  'niederösterreich','oberösterreich','steiermark','styria','tirol','tyrol','kärnten','carinthia','salzburg','vorarlberg','burgenland','lower austria','upper austria',
  'graz','linz','innsbruck','kundl','schaftenau','langkampfen','klagenfurt','villach','wels','st\\.? ?pölten','sankt pölten','dornbirn','wiener neustadt','steyr','feldkirch','bregenz','leonding','klosterneuburg',
  'baden bei wien','wolfsberg','leoben','krems','traun','amstetten','lustenau','kapfenberg','mödling','hallein','kufstein','traiskirchen','schwechat','braunau','stockerau','saalfelden',
  'ansfelden','tulln','hohenems','spittal','telfs','ternitz','perchtoldsdorf','feldbach','bludenz','bad ischl','eisenstadt','schwaz','hall in tirol','gmunden','wörgl','wals',
  'vöcklabruck','lienz','korneuburg','ried im innkreis','marchtrenk','weiz','gleisdorf','leibnitz','hartberg','judenburg','knittelfeld','deutschlandsberg',
  'voitsberg','liezen','bruck an der mur','bruck an der leitha','zell am see','bischofshofen','imst','landeck','kitzbühel','jenbach','reutte','völkermarkt','st\\.? ?veit',
  'gänserndorf','mistelbach','hollabrunn','zwettl','melk','scheibbs','lilienfeld','neusiedl','oberwart','mattersburg','parndorf','güssing','jennersdorf','freistadt','perg',
  'enns','schärding','eferding','grieskirchen','vösendorf','wiener neudorf','brunn am gebirge','gerasdorf','himberg','fischamend','guntramsdorf','hörsching','pasching',
  'lenzing','ranshofen','kapfenberg','zeltweg','fohnsdorf','rankweil','götzis','bürs','nenzing','wattens','vomp','fulpmes','seekirchen','eugendorf','anif','grödig',
].join('|');
const isAustriaMode = c => /^(at|aut|österreich|oesterreich|austria)$/i.test(String(c || '').trim());
function buildCityRegex(cityFilter){
  if(isAustriaMode(cityFilter)) return new RegExp(`(?<![a-zäöüß])(?:${AT_PLACES})(?![a-zäöüß])`, 'i');
  // DÜZELTME (OeKB gibi TEK şehirli şirketler için): kullanıcı şehir filtresi olarak "*" (ya da
  // "any"/"alle") verirse, konumu ne olursa olsun EŞLEŞMİŞ say — bazı küçük/tek-lokasyonlu
  // şirketlerin sayfalarında (OeKB'nin eski başvuru sistemi gibi) hiç şehir adı geçmiyor, bu
  // yüzden normal şehir kontrolü her şeyi eliyordu. Bu SADECE kullanıcı bu özel değeri BİLEREK
  // verdiğinde devreye giriyor — "Wien" gibi normal bir şehir adı verildiğinde davranış birebir
  // aynı kalıyor, hiçbir mevcut şirket/site etkilenmiyor.
  if(/^(\*|any|alle)$/i.test((cityFilter || '').trim())){
    return { test: () => true };
  }
  const alias = CITY_ALIASES[(cityFilter || '').toLowerCase()];
  const pattern = alias ? `${cityFilter}|${alias}` : cityFilter;
  // (27.09) Kelime sınırı: "Wienerberger" (şirket adı) ya da "Wiener Neustadt" (başka şehir) artık
  // "Wien" sayılmıyor — Wienerberger'in Fransa/İngiltere ilanlarının hepsi Wien filtresinden geçiyordu.
  // "Wien-Meidling", "1100 Wien", "Wien, AT" gibi yazımlar eşleşmeye devam ediyor.
  return new RegExp(`(?<![a-zäöüß])(?:${pattern})(?![a-zäöüß])`, 'i');
}

function splitAndFilterByCity(text, cityKeyword){
  // DÜZELTME (Schönherr): "Full-time employee" gibi TEK KELİMELİK bir istihdam türü ("employee"
  // tek başına) daha önce tanınmıyordu, sadece "Permanent employee"/"Temporary employee" gibi
  // ikili ifadeler kalıba uyuyordu — bu yüzden Schönherr'in kariyer sayfası hiç bölünmüyordu.
  // "employee" (bağımsız kelime olarak) da bir sınır işareti olarak eklendi — sadece EK bir
  // seçenek, mevcut kalıpları kaldırmıyor.
  const boundary = /(?<=(?:Voll-\s*oder\s*Teilzeit|Teilzeit|Vollzeit|Full[\s-]?time|Part[\s-]?time)\s*(?:Befristet|Festanstellung|Permanent\s*employee|Temporary\s*employee|\bemployee\b|\/\s*(?:Full|Part)[\s-]?time|Contract|Internship|Freelance))/i;
  const chunks = text.split(boundary)
    .map(c => c.trim()).filter(Boolean);
  if(chunks.length <= 1) return null; // kalıp tutmadı, sayfa farklı yapıda
  return chunks.filter(c => buildCityRegex(cityKeyword).test(c));
}

// Her kategori grubunun İLK ilanı, kendi chunk'ının başında "Kategori - N Position(en)N" gibi bir
// özet + site şablonu metni (Skip to main content / Zum Hauptinhalt springen / Offene Stellen /
// Open positions / dil seçici) taşıyor — bunlar gerçek ilan başlığı DEĞİL. DÜZELTME: eski versiyon
// bunları hiç temizlemiyordu, başlıklar "Skip to main contentEnglishOpen positionsMarketing - 1
// position1Marketing Manager" gibi çıkıyordu. "N Position(en)N" kalıbının SON geçtiği yere kadar
// olan kısmı atıyoruz — kalanı gerçek başlık+lokasyon metni oluyor.
function stripListingChrome(chunk){
  const positionPattern = /\d+\s*[Pp]osition(?:en)?\s*\d*/g;
  let last = null, m;
  while((m = positionPattern.exec(chunk))) last = m;
  if(last) return chunk.slice(last.index + last[0].length).trim();
  // Kategori özeti yoksa (bu kategorinin ilk ilanı değilse), sadece bilinen site şablonu
  // metinlerini baştan temizle.
  // DÜZELTME (Schönherr): "apply now"/"jetzt bewerben" de yaygın bir baştaki şablon metni — bir
  // önceki ilanın "apply now" linkinden artakalan parça, gerçek başlığın önüne yapışıyordu.
  return chunk.replace(/^(Skip to main content|Zum Hauptinhalt springen|Offene Stellen|Open positions|English|Deutsch|apply now|jetzt bewerben)+/i, '').trim();
}

// Ham metin parçasından elden geldiğince temiz alanlar çıkarıyoruz. "requirements" burada YOK
// çünkü liste sayfası onu hiç taşımıyor — sayfanın kendi tasarımı, benim eksikliğim değil.
function parseChunk(chunk, companyGuess){
  const cleaned = stripListingChrome(chunk);
  const employmentType = (cleaned.match(/(Voll-\s*oder\s*Teilzeit|Teilzeit|Vollzeit|Full[\s-]?time|Part[\s-]?time)\s*(Befristet|Festanstellung|Permanent\s*employee|Temporary\s*employee|\bemployee\b|\/\s*(?:Full|Part)[\s-]?time|Contract|Internship|Freelance)/i)||[])[0] || null;
  const withoutEmployment = employmentType ? cleaned.slice(0, cleaned.length - employmentType.length) : cleaned;
  // DÜZELTME (Schönherr): bazı siteler literal "location" kelimesini bir ETİKET olarak kullanıyor
  // ("... location Austria| Vienna Law Full-time employee") — bu durumda büyük-harf-tahmini yerine
  // (ki "Law"/"Finance" gibi departman adını yanlışlıkla "konum" sanıyordu) bu etiketi güvenilir bir
  // ayraç olarak kullanıyoruz: "location"dan ÖNCESİ başlık, SONRASI konum+departman.
  const locationLabelMatch = withoutEmployment.match(/\blocation\b/i);
  let title, location;
  if(locationLabelMatch){
    title = withoutEmployment.slice(0, locationLabelMatch.index).trim();
    location = withoutEmployment.slice(locationLabelMatch.index + locationLabelMatch[0].length).trim();
  } else {
    const cityMatch = withoutEmployment.match(/([A-ZÄÖÜ][a-zäöüß]+(?:\s?\d{4,5})?(?:,\s?[A-ZÄÖÜ][a-zäöüß]+(?:\s?\d{4,5})?)*)$/);
    location = cityMatch ? cityMatch[1].trim() : null;
    title = (location ? withoutEmployment.slice(0, withoutEmployment.length - location.length) : withoutEmployment).trim();
  }
  return {
    title: title || null, companyName: companyGuess || null,
    location: location || null, employmentType: employmentType || null,
    requirements: null,
  };
}

// Bir ilan başlığına GERÇEKTEN tıklamayı deniyoruz — Personio'da bazı ilanlar ayrı bir sayfaya
// gitmiyor, aynı sayfada genişleyip gereksinim metnini gösteriyor. CSS seçici bilmiyoruz, bilmemize
// de gerek yok — DOM içinde metin araması yapıp en yakın elementi tıklıyoruz, bu yüzden genel/
// yeniden kullanılabilir (herhangi bir siteye uygulanabilir).
async function tryExpandListing(page, titleSnippet){
  const before = page.url();
  const clicked = await page.evaluate((snippet) => {
    const candidates = Array.from(document.querySelectorAll('a,button,[role="button"],li,div,h2,h3,span'));
    const norm = s => s.replace(/\s+/g,' ').trim();
    const target = norm(snippet).slice(0, 35);
    if(!target) return false;
    let best = null, bestLen = Infinity;
    for(const elx of candidates){
      const text = norm(elx.textContent||'');
      if(text.includes(target) && text.length < bestLen && text.length < 500){ best = elx; bestLen = text.length; }
    }
    if(best){ best.scrollIntoView({block:'center'}); best.click(); return true; }
    return false;
  }, titleSnippet);
  if(!clicked) return { ok:false };
  await new Promise(r => setTimeout(r, 1500));
  const after = page.url();
  return after !== before ? { ok:true, navigated:true, url: after } : { ok:true, navigated:false };
}

function summarize(job){
  const desc = job.description ? String(job.description).replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim() : '';
  const req = guessRequirements(desc);
  // DÜZELTME: jobLocation schema.org'a göre TEK bir obje OLABİLECEĞİ GİBİ bir DİZİ de olabilir
  // (bir ilan birden fazla ofis için aynı anda yayınlandığında — büyük şirketlerde sık görülüyor,
  // ör. A1/Accenture). Eski kod sadece tekil objeyi okuyordu, dizi geldiğinde konum sessizce null
  // kalıyordu ve "Wien" filtresi hiçbir zaman eşleşmiyordu. addressRegion de eklendi (bazı
  // şirketler şehri addressLocality yerine addressRegion alanına koyuyor).
  const locations = Array.isArray(job.jobLocation) ? job.jobLocation : (job.jobLocation ? [job.jobLocation] : []);
  const location = locations
    .map(loc => loc && loc.address && [loc.address.addressLocality, loc.address.addressRegion, loc.address.addressCountry].filter(Boolean).join(', '))
    .filter(Boolean)
    .join(' | ') || null;
  return {
    title: job.title || null,
    company: (job.hiringOrganization && job.hiringOrganization.name) || null,
    location,
    employmentType: job.employmentType || null,
    datePosted: job.datePosted || null,
    descriptionSnippet: desc.slice(0, 300) || null,
    descriptionFull: desc,
    // 30.09: Apply için satır yapısı korunmuş hali (JSON-LD açıklaması HTML; madde işaretleri kaybolmasın).
    descriptionLines: job.description ? stripHtmlToPlainText(String(job.description)) : '',
    // Whittle'a yapıştırmaya hazır tahmin: hangi eksenler metinden çıkarıldı (guess), hangileri
    // çıkarılamadığı için şablona bırakılacak (estimated). Bunlar KESİN değil, insan onaylamalı.
    whittleGuess: { deg:null, de:null, en:null, exp:null, wm:null, ...req.guess },
    whittleEstimated: req.estimated,
    // DÜZELTME (Eren'in fark ettiği hata — Accenture/Workday'de görüldü): guessRequirements zaten
    // her guess için bir "bu metinden çıkardım" alıntısı (evidence) üretiyor, ama burada hiç
    // saklanmıyordu — JSON-LD/Workday yoluyla gelen ilanlarda deg/de/en/exp/wm dolu görünse bile
    // evidence alanı çıktıda hiç yoktu, elle doğrulama imkansızdı (diğer TÜM entegrasyon yollarında
    // evidence var, bu tek istisnaydı). Aynı req.evidence'ı burada da taşıyoruz.
    whittleEvidence: req.evidence,
  };
}

// Açıklama metninden Whittle'ın sert eksenlerini (deg/de/en/wm/exp) TAHMİN ETMEYE çalışıyoruz —
// niche tespitinde kullandığımız aynı "şeffaf keyword eşleştirme" mantığı. Bunlar KESİN DEĞİL,
// TAHMİN — Whittle'a aktarılınca 'estimated' alanına konmalı ki dürüstçe işaretlensin, insan
// onayı olmadan asla "kesin" gibi gösterilmesin.
// Metindeki bir eşleşmenin etrafından okunabilir bir alıntı çıkarır — ORİJİNAL (küçük harfe
// çevrilmemiş) metinden, eşleşmenin biraz öncesi/sonrasıyla birlikte. Tahminin doğruluğunu elle
// kontrol edebilmen için: her guess'in yanında "bu metinden çıkardım" diye gösterilecek.
function snippetAround(original, index, length, radius = 40){
  const start = Math.max(0, index - radius);
  const end = Math.min(original.length, index + length + radius);
  let s = original.slice(start, end).trim();
  if(start > 0) s = '…' + s;
  if(end < original.length) s = s + '…';
  return s;
}

// DÜZELTME (Bitpanda): bazı Greenhouse board'ları içeriği "çift kodlanmış" HTML olarak döndürüyor
// — gerçek "<strong>" etiketi yerine, literal "&lt;strong&gt;" metni geliyor. Bu hem evidence
// alıntılarını çirkin/okunmaz yapıyor hem de (daha az sıklıkla) bazı kelime eşleşmelerini
// bozabilir. En yaygın HTML entity'lerini çözen küçük, güvenli bir yardımcı — decode edilecek bir
// şey yoksa (normal HTML/düz metin) hiçbir şeyi değiştirmiyor, zararsız.
function decodeHtmlEntities(s){
  if(!s) return s;
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    // DÜZELTME (Schönherr — Umbraco JSON/HTML cevabı): Almanca ünlü noktalı harfler (ä/ö/ü)
    // sayısal HTML varlığı olarak geliyor (ör. "&#xE4;" = ä, "&#xF6;" = ö). Önceki liste sadece
    // isimlendirilmiş varlıkları (&amp; vb.) çözüyordu — sayısal olanlar (hex &#x..; ve decimal
    // &#..;) hiç çözülmeden "Sch&#xF6;nherr" gibi çöp metin olarak kalıyordu. Genel bir kod-noktası
    // çözücü ekliyoruz — sadece BU kalıpla eşleşen metni etkiler, başka hiçbir siteyi bozmaz.
    .replace(/&#x([0-9a-f]+);/gi, (m, hex) => { try{ return String.fromCodePoint(parseInt(hex, 16)); }catch(e){ return m; } })
    .replace(/&#(\d+);/g, (m, dec) => { try{ return String.fromCodePoint(parseInt(dec, 10)); }catch(e){ return m; } })
    // 30.09 (Wiener Stadtwerke: "f&uuml;r"): isimli Almanca/tipografik varlıklar
    .replace(/&(auml|ouml|uuml|Auml|Ouml|Uuml|szlig|euro|ndash|mdash|bdquo|ldquo|rdquo|lsquo|rsquo|hellip|bull|middot|shy|eacute|egrave|agrave);/g, (m, n) => ({ auml:'ä', ouml:'ö', uuml:'ü', Auml:'Ä', Ouml:'Ö', Uuml:'Ü', szlig:'ß', euro:'€', ndash:'–', mdash:'—', bdquo:'„', ldquo:'“', rdquo:'”', lsquo:'‘', rsquo:'’', hellip:'…', bull:'•', middot:'·', shy:'', eacute:'é', egrave:'è', agrave:'à' })[n]);
}

function guessRequirements(text){
  const original = decodeHtmlEntities(text || '');
  const t = original.toLowerCase();
  const guess = {};
  const evidence = {}; // her guess edilen alan için: "bu metinden çıkardım" alıntısı

  let m;
  // DÜZELTME (Schönherr — Eren'in fark ettiği hata): "master" kelimesi tek başına her zaman
  // yüksek lisans derecesi anlamına gelmiyor — "Master Data Specialist" gibi ilan BAŞLIKLARINDA
  // (Master Data Management terimi) ya da "Scrum Master" gibi rol adlarında geçtiğinde yanlış
  // pozitif üretiyordu. Bilinen, gerçek bir derece ANLAMI TAŞIMAYAN "master X" kalıplarını negatif
  // lookahead ile hariç tutuyoruz — gerçek "Master of Science/Laws", "Masterstudium", "Master's
  // degree" gibi kalıpları hiç etkilemiyor (bunlarda "master" sonrası bu kelimeler gelmiyor).
  // 23.10 (feedback "Master'ı yanlış istiyor / kaçırıyor"): Master SADECE tamamlanmış derece olarak istendiğinde (abgeschlossen,
  // Masterabschluss, master's degree). "Bachelor- oder Masterstudium", "Studierende im Master" = öğrenci → 2.
  const STUDENT_CTX = /studierende|student(?:in|en)?\b|laufende[sm]?|eingeschrieben|enrolled|currently (?:studying|pursuing)|im (?:bachelor|master)(?:studium)?\b|bachelor[- ]?(?:oder|or|bzw\.?|\/)\s*master/i;
  const MASTER_REQ = /(?:abgeschlossene[snm]?\s+(?:\w+\s+){0,2}master|masterabschluss|master'?s?[- ]abschluss|master'?s degree|master degree|(?:msc|m\.sc\.|ma|mba)\s*(?:abschluss|degree)|master(?:studium)?\s+(?:\w+\s+){0,2}abgeschlossen)/i;
  if((m = t.match(MASTER_REQ)) && !STUDENT_CTX.test(t.slice(Math.max(0, m.index - 80), m.index + m[0].length + 80))){ guess.deg = 4; evidence.deg = snippetAround(original, m.index, m[0].length); }
  else if((m = t.match(/master(?!\s*(data|of ceremonies|black\s*belt|card|plan))/i)) && STUDENT_CTX.test(t)){ guess.deg = 2; evidence.deg = snippetAround(original, m.index, m[0].length); }
  else if((m = t.match(/bachelor/i))){
    guess.deg = /laufend|studierend|noch (im )?studium/i.test(t) ? 2 : 3;
    evidence.deg = snippetAround(original, m.index, m[0].length);
  }
  else if((m = t.match(/abgeschlossenes? studium|hochschulabschluss/i))){ guess.deg = 3; evidence.deg = snippetAround(original, m.index, m[0].length); }
  // DÜZELTME (PMI): "abgeschlossene Ausbildung" (sıfat-isim) kalıbı zaten yakalanıyordu, ama
  // bazı ilanlar tersten yazıyor — "Ausbildung abgeschlossen" ("Du hast deine Ausbildung
  // abgeschlossen" gibi bir cümlenin parçası). Eren'in fark ettiği gibi bu durumda deg hiç
  // yakalanmıyor, boş/"estimated" kalıyordu. İkinci kalıbı da (isim ÖNCE, "abgeschlossen" SONRA)
  // OR ile ekliyoruz — var olan "abgeschlossene X" eşleşmesini hiç etkilemiyor.
  else if((m = t.match(/matura|lehrabschluss|abgeschlossene(?:r|s|n)?\s+(?:\w+\s+){0,2}(lehre|ausbildung)|(lehre|ausbildung)(?:\s+\w+){0,3}?\s+abgeschlossen/i))){ guess.deg = 1; evidence.deg = snippetAround(original, m.index, m[0].length); }
  else if((m = t.match(/immatrikuliert|(du |noch )?studierst\b|eingeschriebene(?:r)? student|eingeschrieben.{0,25}(universität|hochschule|fh\b)|\bstudiums?\b|\bsemester\b/i))){ guess.deg = 2; evidence.deg = snippetAround(original, m.index, m[0].length); } // "hâlâ öğrenciyim" ima ediyor — devam eden Bachelor varsayımı
  // 23.10 (feedback "kaufmännische Ausbildung nötig ama gösterildi"): ilan SADECE kaufmännische Ausbildung/Lehre/HAK istiyorsa
  // (yanında "oder Studium / vergleichbar / bzw." alternatifi yoksa) → kfm=true; sitede HAK/kaufm. Ausbildung şartı olur.
  { const km = t.match(/(?:abgeschlossene[nrs]?\s+)?kaufmännische[nrs]?\s+(?:aus|schul)bildung|kaufmännische[nrs]? lehre|lehrabschluss als (?:bürokauf|industriekauf|einzelhandelskauf)\w*|\bhak[- ]?(?:matura|abschluss)\b/i);
    if(km){ const ctx = t.slice(Math.max(0, km.index - 60), km.index + km[0].length + 90);
      if(!/oder|bzw|alternativ|vergleichbar|ähnlich|studium|universit|hochschul|\bfh\b|or similar|equivalent/i.test(ctx)){ guess.kfm = true; evidence.kfm = snippetAround(original, km.index, km[0].length); } } }

  // Önce kesin CEFR etiketleri (C1/B2/B1), yoksa doğal dilde sıkça geçen ifadeler.
  // DİKKAT (düzeltildi): eski versiyon "dil kelimesi + 20 karakter içinde seviye kodu" diye
  // gevşek bir pencere kullanıyordu — bu, "Deutsch (C1) und gute Englischkenntnisse (B2)" gibi
  // tek cümlede iki dil geçen metinlerde C1/B2'yi birbirine karıştırıyordu (İngilizce B2 yanlışlıkla
  // C1 okunuyordu, çünkü "C1) und gute Englisch" 20 karakterden kısaydı). Artık seviye kodu,
  // kendi dil kelimesine SIKI bağlı olmalı (aralarında sadece boşluk/parantez/iki nokta olabilir).
  const langLevel = (wordsRe) => {
    const after = new RegExp(`(?:${wordsRe})\\w*\\s*[:\\-]?\\s*\\(?\\s*(c1|b2|b1)\\b`, 'i');
    const before = new RegExp(`\\b(c1|b2|b1)\\b\\s*\\)?\\s*(?:${wordsRe})`, 'i');
    const mm = t.match(after) || t.match(before);
    return mm ? { level: mm[1].toLowerCase(), index: mm.index, length: mm[0].length } : null;
  };

  const deLevel = langLevel('deutsch|german');
  if(deLevel){
    // DÜZELTME (26.09): ölçek sitenin LEVEL dizisiyle bir kademe kaymıştı (C1→3 yazılıyordu, sitede
    // 3 = B2). Frontend: 0=yok, 1=A2, 2=B1, 3=B2, 4=C1.
    guess.de = deLevel.level === 'c1' ? 4 : deLevel.level === 'b2' ? 3 : 2;
    evidence.de = snippetAround(original, deLevel.index, deLevel.length);
  }
  else if((m = t.match(/(sehr gute?|ausgezeichnete|fließend|verhandlungssicher|muttersprachlich).{0,15}deutsch|(?:fluent|excellent|native|business[- ]fluent|very good)\s+(?:command of\s+|knowledge of\s+|skills in\s+)?german\b|german\s*\((?:fluent|native)\)/i))){ guess.de = 4; evidence.de = snippetAround(original, m.index, m[0].length); }
  else if((m = t.match(/\bgood\s+(?:command of\s+|knowledge of\s+)?german\b|german\s+(?:skills\s+)?(?:is\s+)?(?:required|a must)/i))){ guess.de = 3; evidence.de = snippetAround(original, m.index, m[0].length); }
  else if((m = t.match(/\bgute?\b.{0,10}deutschkenntnisse/i))){ guess.de = 3; evidence.de = snippetAround(original, m.index, m[0].length); }
  // 12.10: İlan tamamen İngilizce yazılmış VE hiçbir yerde Almanca şartı/bahsi yoksa → Almanca gerekmiyor (0).
  // Reddit'teki B1 öğrenci vakası: Henkel/Bitpanda gibi İngilizce ilanlarda de boş kalıyordu, bu yüzden
  // "Basic German is enough" listesine girmiyorlardı. "German advantageous/a plus" gibi her bahis bu kuralı
  // devre dışı bırakır (o zaman AI/insan karar versin). Germany/Deutsche Bank vb. sayılmaz.
  else {
    const enW = (t.match(/\b(the|and|you|your|with|we|our|for|will|are|of)\b/g) || []).length;
    const deW = (t.match(/\b(und|die|der|das|mit|wir|sie|du|für|ist|eine?|bei)\b/g) || []).length;
    const mentionsGerman = /\bgerman\b(?!y)|deutschkenntnis|deutsche? sprache|\bdeutsch\b(?!e? ?(bank|telekom|post|bahn|land))|deutschsprachig|german[- ]speaking/i.test(t);
    if(enW >= 25 && enW > deW * 4 && !mentionsGerman){ guess.de = 0; evidence.de = 'Anzeige auf Englisch, keine Deutschkenntnisse verlangt'; }
  }

  const enLevel = langLevel('englisch|english');
  if(enLevel){
    guess.en = enLevel.level === 'c1' ? 4 : enLevel.level === 'b2' ? 3 : 2;
    evidence.en = snippetAround(original, enLevel.index, enLevel.length);
  }
  // 23.10 (feedback: "very good English" C1 sayılıp eleniyordu): sehr gut / very good = B2 (3); fließend, verhandlungssicher,
  // ausgezeichnet, fluent, excellent, business fluent, native = C1 (4); gut / good = B1 (2).
  else if((m = t.match(/(ausgezeichnete|fließend|verhandlungssicher|muttersprachlich).{0,15}englisch|(?:fluent|excellent|native|business[- ]fluent|outstanding)\s+(?:command of\s+|knowledge of\s+|skills in\s+|written and spoken\s+)?english|english\s*\((?:fluent|native)\)|fluency in english/i))){ guess.en = 4; evidence.en = snippetAround(original, m.index, m[0].length); }
  else if((m = t.match(/sehr gute?.{0,15}englisch|(?:very good|strong)\s+(?:command of\s+|knowledge of\s+|written and spoken\s+)?english/i))){ guess.en = 3; evidence.en = snippetAround(original, m.index, m[0].length); }
  else if((m = t.match(/\bgute?\b.{0,10}englischkenntnisse|\bgood\s+(?:command of\s+|knowledge of\s+)?english/i))){ guess.en = 2; evidence.en = snippetAround(original, m.index, m[0].length); }

  // "mobiles Arbeiten" Almanca İK dilinde seyahat DEĞİL, esnek çalışma konumu demek (mobile alanına bakma).
  // DÜZELTME (26.09 ikinci crawl): Avusturya ilanlarında "Homeoffice möglich / mobiles Arbeiten" neredeyse
  // her zaman KISMİ evden çalışma demek (hybrid) — eskiden bunlar 'remote' sayılıyordu, 493 ilanın 174'ü
  // remote görünüyordu (Deloitte'un 52'si dahil). Artık 'remote' sadece TAMAMEN uzaktan çalışmayı açıkça
  // söyleyen ifadelerde; Homeoffice/remote work benefit'i hybrid.
  if((m = t.match(/100\s*%\s*(remote|homeoffice|home office)|fully remote|full[- ]remote|remote[- ]first|vollständig (remote|im homeoffice)|ausschließlich (remote|im homeoffice)|ortsunabhängig|standortunabhängig|standortungebunden|von überall arbeiten|work from anywhere|remote[- ](position|role|job|stelle)/i))){ guess.wm = 'remote'; evidence.wm = snippetAround(original, m.index, m[0].length); }
  else if((m = t.match(/hybrid|home ?office|homeoffice|von zuhause|telearbeit|mobiles\s*arbeiten|mobil\s*arbeiten|remote[- ]?(work|arbeit)|work from home|\bwfh\b|arbeiten von zu ?hause|\bremote\b|hybrides\s*arbeiten|hybrides\s*arbeitsmodell|teilweise\s*im\s*homeoffice|flexibel\s*zwischen\s*büro\s*und\s*homeoffice|mix\s*aus\s*büro\s*und\s*homeoffice|\d\s*tage?\s*(pro\s*woche\s*)?(im\s*)?homeoffice|flexible\s*work\s*arrangement|hybrid\s*work\s*model|teils\s*remote|teilweise\s*remote/i))){ guess.wm = 'hybrid'; evidence.wm = snippetAround(original, m.index, m[0].length); }
  else if((m = t.match(/\bvor\s*ort\b|\bim\s*büro\b|präsenzpflicht|präsenz\s*vor\s*ort|\bonsite\b|\bon-site\b|in[- ]office|full-time\s*office\s*presence|vollzeit\s*im\s*büro|arbeiten\s*vor\s*ort|\bin\s*person\b/i))){ guess.wm = 'onsite'; evidence.wm = snippetAround(original, m.index, m[0].length); }
  // DÜZELTME (26.09): eskiden metinde hiçbir işaret yoksa wm='onsite' VARSAYILIYORDU — 26.09 crawl'ında
  // 454 ilanın 215'i (%47) böyle, uydurma bir "onsite" taşıyordu ve Whittle bunu kesin veri sayıyordu
  // (hybrid/remote isteyen aday bu ilanlarda puan kaybediyordu; Wien ofis işlerinin çoğu aslında
  // hybrid). Artık boş bırakılıyor → 'estimated' listesine düşüyor, frontend puanlamadan çıkarıyor.

  // 23.10 (feedback: "mind. 1 Jahr Erfahrung" ilanlar "Erfahrung nötig değil" görünüyordu): açık yıl şartı, "X von Vorteil"
  // kalıbından ÖNCE kontrol ediliyor (ilanlar genelde ikisini birden içeriyor: "mind. 1 Jahr …; Erfahrung mit SAP von Vorteil").
  const WORDN = { ein:1, eine:1, einem:1, einjährige:1, one:1, zwei:2, two:2, drei:3, three:3, vier:4, four:4, fünf:5, five:5 };
  const yW = t.match(/(?:mindestens|min\.|zumindest|at least|minimum(?: of)?)\s+(ein(?:e[mn]?)?|one|zwei|two|drei|three|vier|four|fünf|five)\s+(?:jahre?n?|years?)\b[^.\n•]{0,50}?(?:berufserfahrung|berufspraxis|erfahrung|praxis|experience)|\b(einjährige|zweijährige|dreijährige)\s+(?:berufs)?(?:erfahrung|praxis)/i);
  if((m = t.match(/keine (berufs)?erfahrung (nötig|erforderlich|notwendig|vorausgesetzt)|no (prior |previous )?(?:work |professional )?experience (required|needed|necessary)/i))){ guess.exp = 0; evidence.exp = snippetAround(original, m.index, m[0].length); }
  else if(require('./ai-fields').yearsExp(original) != null){ guess.exp = require('./ai-fields').yearsExp(original); const ym = original.match(/\d{1,2}\s*\+?\s*(?:(?:bis|[-–]|to)\s*\d{1,2}\s*)?(?:jahre?n?|years?)/i); if(ym) evidence.exp = snippetAround(original, ym.index, ym[0].length); } // 08.10: "mindestens 3 bis 5 Jahre"
  else if(yW){ const w = (yW[1] || yW[2] || '').toLowerCase().replace(/jährige$/, ''); const n = WORDN[w] || (w==='zwei' ? 2 : w==='drei' ? 3 : 1); guess.exp = n >= 5 ? 3 : n >= 3 ? 2 : 1; evidence.exp = snippetAround(original, yW.index, yW[0].length); }
  else if((m = t.match(/\b1[-–]2 jahre?\b|1-2 years/i)) && !/idealerweise|im idealfall|ideally|von vorteil|wünschenswert|a plus/i.test(t.slice(Math.max(0, m.index - 45), m.index + m[0].length + 80))){ guess.exp = 1; evidence.exp = snippetAround(original, m.index, m[0].length); }
  else if((m = t.match(/keine (berufs)?erfahrung|no experience/i))){ guess.exp = 0; evidence.exp = snippetAround(original, m.index, m[0].length); }
  else if((m = t.match(/erfahrung.{0,60}(ist )?von vorteil|erfahrung.{0,60}wünschenswert|idealerweise.{0,30}erfahrung/i))){ guess.exp = 0; evidence.exp = snippetAround(original, m.index, m[0].length); } // "deneyim varsa iyi olur" = deneyim ŞART değil
  // DİKKAT: "(bereits/schon) erste Erfahrung" — eğer yukarıdaki "von vorteil/idealerweise" kalıplarından
  // biriyle eşleşmediyse, bu genelde "zaten biraz deneyimin olmalı" demek (tersi değil!) — bir önceki
  // sürümde bu ayrım yoktu, "erste Erfahrung" her yerde exp=0 sanılıyordu, bu yanlıştı.
  else if((m = t.match(/(bereits|schon)\s+erste\s+(praktische\s+)?erfahrung/i))){ guess.exp = 1; evidence.exp = snippetAround(original, m.index, m[0].length); }

  // DÜZELTME (Eren'in isteği üzerine — veri kalitesi): Whittle'ın kendi quiz'inde bir "team"
  // sorusu (küçük/büyük ekip) var ama parser bunu hiç tahmin etmiyordu. İlan metninde açık sayı
  // ("Team von 12 Personen") ya da nitel ifade ("kleines, dynamisches Team" / "großes Team")
  // geçiyorsa small/large olarak işaretliyoruz — Whittle'ın 'team' sorusunun beklediği aynı
  // değerler (small/large). Sayı varsa ona öncelik veriyoruz (daha güvenilir); yoksa nitel
  // ifadeye bakıyoruz. Hiçbiri yoksa (çoğu ilan) dokunmuyoruz — uydurma değer üretmemek için.
  if((m = t.match(/team\s+(?:von|of|aus)\s+(?:ca\.?\s*|etwa\s*|rund\s*)?(\d{1,3})\s*(?:personen|mitarbeiter|kolleg|people|employees|members)?/i))){
    const n = Number(m[1]);
    guess.team = n <= 8 ? 'small' : 'large';
    evidence.team = snippetAround(original, m.index, m[0].length);
  }
  else if((m = t.match(/(kleine[nrs]?|small|tight-knit|überschaubare[nrs]?)\s*,?\s*(dynamische[nrs]?|agile[ns]?)?\s*team/i))){
    guess.team = 'small'; evidence.team = snippetAround(original, m.index, m[0].length);
  }
  else if((m = t.match(/(große[nrs]?|grosse[nrs]?|large|big)\s*(abteilung|team|department)/i))){
    guess.team = 'large'; evidence.team = snippetAround(original, m.index, m[0].length);
  }

  // EKLENDİ (Eren'in isteği — soft preference kapsamını genişletmek): müşteri teması / fiziksel iş /
  // vardiya-hafta sonu çalışması için ilan metninde AÇIKÇA geçen ifadeleri arıyoruz. Bilerek TEK
  // YÖNLÜ: bir ifade bulursak 1 (evet) diyoruz, bulamazsak 0 (hayır) VARSAYMIYORUZ — sessizlik "bu
  // konuda bir şey söylemiyor" demek, "hayır" demek değil. Bulamadığımız durumda alan boş kalıyor
  // (estimated'a düşüyor), archetype tahmini ya da (varsa) AI ikinci katman bunu doldurmaya çalışıyor.
  // GENİŞLETİLDİ (Eren'in isteği — gerçek Almanca ilan dili kaynaklarından araştırılıp eklendi):
  // her eksen için hem "tek kelime" hem "aynı anlama gelen eş anlamlılar" ayrı ayrı denendi.
  if((m = t.match(/kundenkontakt|kundenberatung|kundenbetreuung|kundengespräch|kundenservice|kundenanfragen|klientenkontakt|mandantenkontakt|kontaktfreudig|serviceorientierung|dienstleistungsmentalität|kundenorientierte\s*arbeitsweise|aktive\s*kundenansprache|kundenbeziehungen\s*aufbauen|aktiv\s*auf\s*kunden\s*zugehen|ansprechpartner\w*\s*für\s*(unsere\s*)?kunden|im (direkten )?austausch mit (unseren )?kunden|(telefonisch|persönlich)e[nr]?\s*kundenkontakt|customer[- ]facing|direct contact with (our )?(customers|clients)|client[- ]facing|kundenorientiert.{0,20}(kommunikation|tätigkeit)|kundenbetreuer\w*|kundenberater\w*|kundendienst|kundenzufriedenheit|kundenbindung|kundenbeziehungsmanagement|kundenanliegen|kundenwünsche|beratung\s*(von|unserer)\s*kunden|betreuung\s*(von|unserer)\s*kunden|kontakt\s*zu\s*kunden|gästekontakt|gästebetreuung|patientenkontakt|bürgerkontakt|reklamationsbearbeitung|beschwerdemanagement|\bhotline\b|call[- ]?center|telefonzentrale|kundenempfang|erste\s*anlaufstelle\s*für\s*kunden|schnittstelle\s*zu\s*(unseren\s*)?kunden|enger\s*kontakt\s*mit\s*kunden|regelmäßiger\s*kontakt\s*zu\s*kunden|beratungsgespräche|verkaufsgespräche|front[- ]office|guest\s*relations|customer\s*service|customer\s*support|client\s*relationship|account\s*management|interact\w*\s*with\s*customers|dealing\s*with\s*customers|patient[- ]facing|kassiertätigkeit|beratung\s*im\s*verkaufsraum|serviceorientierung\s*am\s*gast|empfang\s*und\s*betreuung\s*der\s*gäste|check[- ]in.{0,10}gäste|rezeptionstätigkeit|gastgeber\w*|pflege\s*und\s*betreuung\s*von\s*patienten|angehörigengespräche|beratung\s*von\s*privatkunden|firmenkundenbetreuung|firmenkundenberat\w*|vermögensberatung|private\s*banking|parteienverkehr|publikumsverkehr|bürgerservice/i))){
    guess.cust = 1; evidence.cust = snippetAround(original, m.index, m[0].length);
  }
  if((m = t.match(/körperlich(e|er)?\s*(anspruchsvoll|tätigkeit|arbeit|fit)|heben (von )?(schwerer? )?lasten|gewichte\s*heben|stehende\s*tätigkeit|handwerkliche[sn]?\s*geschick|manual labor|physical(ly)?\s*demanding|lagertätigkeit|produktionsarbeit|produktionsumgebung|lastentransport|schweres\s*heben|körperliche\s*belastbarkeit|arbeiten\s*im\s*stehen|arbeiten\s*im\s*freien|tätigkeit\s*im\s*freien|witterungseinflüsse|sicherheitsschuhe|staplerschein|motorische\s*fähigkeiten|hands[- ]on\s*work|warehouse\s*work|on\s*your\s*feet|heavy\s*lifting|physically\s*fit|outdoor\s*work|kommissionier\w*|palettier\w*|verladen|be[- ]?und\s*entladen|tragen\s*von\s*lasten|regalbetreuung|ware\s*einräumen|warenpräsentation/i))){
    guess.phys = 1; evidence.phys = snippetAround(original, m.index, m[0].length);
  }
  if((m = t.match(/schichtarbeit|schichtdienst\w*|wechselschicht\w*|wochenendarbeit|bereitschaft\s*(zu|zur)\s*schichtarbeit|bereitschaft.{0,25}wochenende|nachtschicht\w*|unregelmäßige\s*arbeitszeiten|shift work|weekend work|wochenendeinsatz|feiertagsarbeit|spätschicht|frühschicht|tagschicht|turnusdienst|sonntagsdienst|nachtarbeit|schichtplan|schichtbereitschaft|bereitschaftsdienst|rufbereitschaft|arbeiten?\s*an\s*wochenenden\s*und\s*feiertagen|rotating\s*shifts?|night\s*shift|weekend\s*shift|on[- ]call\s*duty|wechselnde\s*(arbeitszeiten|schichten)|arbeitszeiten\s*schwanken|randzeiten|wechselschichten|zwei[- ]schicht[- ]betrieb|drei[- ]schicht[- ]betrieb|schichtbetrieb|schichtmodell|\bteildienst\b|saisonarbeit|dienst\s*an\s*wochenenden/i))){
    guess.shift = 1; evidence.shift = snippetAround(original, m.index, m[0].length);
  }

  // EKLENDİ (Eren'in isteği — AI'ya gitmeden ÖNCE mümkün olduğunca çok anahtar kelimeyle dene):
  // autonomy/variety/competitive/creative/leadership/mobile — bunlar yoruma daha açık eksenler,
  // güvenilirlik cust/phys/shift kadar yüksek değil, ama AMAÇ zaten "AI'ya giden ilan sayısını
  // azaltmak" olduğu için ihtiyatlı ama gerçekçi kalıplarla deneniyor. Yine TEK YÖNLÜ: sadece
  // 1 (evet/vurgulanıyor) için işaretliyoruz, sessizlikten 0 çıkarmıyoruz — 0 gerektiren tarafı
  // (ör. "rutin görevler" gibi zıt bir ifade AÇIKÇA geçiyorsa) ayrıca deniyoruz, yoksa AI'ya bırakılıyor.
  // DİKKAT: Almanca ayrılabilir fiiller ("bringst ... ein" = einbringen, "arbeitest ... eigenständig")
  // yüzünden "kelime1 kelime2" bitişik kalıpları çoğu zaman eşleşmiyor — bu yüzden bu 6 eksende
  // kelimeleri tek başına (bağlamdan koparıp) arıyoruz, cümledeki sırayı varsaymıyoruz.
  if((m = t.match(/eigenständig|selbstständig|selbständig|selbstverantwortlich|eigenverantwort\w*|eigeninitiative|selbstorganisation|entscheidungsstärke|independent(ly)?\s*work|autonomous(ly)?\s*work|eigenverantwortliche[sn]?\s*arbeiten|hohe\s*eigenverantwortung|freie\s*zeiteinteilung|eigene\s*entscheidungen\s*treffen|entscheidungsfreiheit|entscheidungsfreiraum|handlungsspielraum|hohes\s*maß\s*an\s*selbstständigkeit|proaktive\s*arbeitsweise|eigenregie|self[- ]starter|work\s*independently|high\s*degree\s*of\s*autonomy|autonomous\s*role|eigenverantwortliche\s*projektarbeit|selbstständige\s*mandatsführung/i))){
    guess.autonomy = 1; evidence.autonomy = snippetAround(original, m.index, m[0].length);
  }
  // DİKKAT (senin fark ettiğin nokta — deg'deki "Ausbildung abgeschlossen"/"abgeschlossene
  // Ausbildung" örneğiyle aynı ders): sıfat+isim kalıpları ("vielfältige Aufgaben" gibi) cümlede
  // TERS de kurulabiliyor ("die Aufgaben sind vielfältig"). Bu yüzden variety/competitive için
  // hem normal hem ters sıralı halleri ayrı ayrı deniyoruz.
  if((m = t.match(/abwechslungsreich|vielfältige?\s*(aufgaben|tätigkeiten)|vielseitige\s*aufgaben|breit\s*gefächerte\s*aufgaben|breites\s*aufgabenspektrum|(aufgaben|tätigkeiten)\w*.{0,20}(sind|werden)?\s*(sehr\s*)?(vielfältig|abwechslungsreich)\b|varied\s*tasks|diverse\s*responsibilities|facettenreich\w*|projektvielfalt|kein\s*tag\s*gleicht\s*dem\s*anderen|vielschichtige\s*aufgaben|unterschiedliche\s*projekte|breites\s*aufgabenfeld|aufgabenvielfalt|abwechslungsreicher\s*arbeitsalltag|dynamisches\s*aufgabengebiet|wechselnde\s*aufgaben|vielfältiges\s*aufgabengebiet|bunte\s*mischung\s*an\s*aufgaben|no\s*two\s*days\s*are\s*the\s*same|varied\s*role|wide\s*range\s*of\s*tasks|wechselnde\s*(projekte|mandate)|verschiedene\s*branchen/i))){
    guess.variety = 1; evidence.variety = snippetAround(original, m.index, m[0].length);
  }
  else if((m = t.match(/repetitive\s*tasks|routinemäßige\s*aufgaben|gleichbleibende\s*aufgaben/i))){
    guess.variety = 0; evidence.variety = snippetAround(original, m.index, m[0].length);
  }
  if((m = t.match(/leistungsorientiert|erfolgsorientiert|leistungsstark\w*|hohe\s*leistungsbereitschaft|wettbewerbsfähige[sn]?\s*(umfeld|team)|ambitionierte[sn]?\s*team|umfeld\w*.{0,20}(ist\s*)?wettbewerbsfähig\b|performance[- ]driven|competitive\s*environment|wettbewerbsgeist|kompetitives\s*umfeld|leistungsdruck|verkaufsziele\s*erreichen|umsatzziele\s*erreichen|target[- ]driven|results[- ]driven|sales\s*targets|kpi[- ]driven|high[- ]performing\s*team|thrive\s*in\s*a\s*competitive\s*environment|vertriebsziele|verkaufswettbewerb/i))){
    guess.competitive = 1; evidence.competitive = snippetAround(original, m.index, m[0].length);
  }
  if((m = t.match(/kreativität|kreative[sn]?\s*(ideen|lösungen|freiraum)|eigene\s*ideen|gestaltungsspielraum|innovationsfreude|creative\s*freedom|innovative\s*ideen|think outside the box|kreativität\s*gefragt|kreatives\s*denken|out[- ]of[- ]the[- ]box|unkonventionelle\s*lösungen|innovative\s*ansätze|ideenreichtum|gestaltungsfreiraum|eigene\s*projekte\s*umsetzen|freiraum\s*für\s*eigene\s*(ideen|projekte)|experimentierfreudig|innovationsgeist|neue\s*wege\s*gehen|kreative\s*freiheit|design\s*thinking|innovative\s*mindset|creative\s*problem\s*solving|innovationsstark\w*|innovative\s*persönlichkeit|gestaltungswille|kreativ\w*\s*(lösungen|optimieren|ansätze|arbeiten)|kreative\s*kampagnen/i))){
    guess.creative = 1; evidence.creative = snippetAround(original, m.index, m[0].length);
  }
  if((m = t.match(/mitarbeiterführung|teamleitung|führungsverantwortung|führungsaufgabe\w*|führungsposition|personalverantwortung|disziplinarische\s*(führung|verantwortung)|fachliche\s*führung|team\s*(leiten|führen)|leadership\s*responsibility|manage\s*a\s*team|people\s*management|vorbildfunktion|coaching\s*von\s*mitarbeiter\w*|\bmentoring\b|erste\s*führungserfahrung|verantwortung\s*für\s*ein\s*team|führung\s*von\s*mitarbeitenden|führungsqualitäten|führungskompetenz|nachwuchsführungskraft|teamverantwortung|fachliche\s*und\s*disziplinarische\s*führung|supervisory\s*role|managing\s*people|coaching\s*and\s*mentoring\s*staff|line\s*management|schichtleitung|filialleitung|stellvertretende\s*leitung/i))){
    guess.leadership = 1; evidence.leadership = snippetAround(original, m.index, m[0].length);
  }
  // DİKKAT — "false friend" tuzağı (BİLEREK mobile listesine EKLENMEDİ): Almanca ilanlarda
  // "mobiles Arbeiten" / "mobil arbeiten" ifadesi SEYAHATLE ilgili değil — "home office"/uzaktan
  // çalışma anlamına geliyor (yukarıdaki wm=remote kalıbı zaten bunu ayrı yakalıyor). Bu yüzden
  // "mobil" kelimesini TEK BAŞINA hiç kullanmıyoruz; sadece "Reise-"/"travel" köküne bağlı, seyahat
  // anlamı taşıyan kalıplar var. Yeni bir keyword eklerken "mobil" kelimesini buraya EKLEME.
  if((m = t.match(/reisebereitschaft|dienstreisen(\s*im\s*in-\s*und\s*ausland)?|außendienst|reisetätigkeit|internationale\s*reisetätigkeit|travel\s*required|field\s*work|on-site\s*at\s*client|reisetätigkeit\s*im\s*in[- ]?\s*und\s*ausland|gelegentliche\s*dienstreisen|hohe\s*reisebereitschaft|auslandsaufenthalte|kundenbesuche\s*vor\s*ort|vor[- ]ort[- ]termine|einsatz\s*an\s*wechselnden\s*standorten|regelmäßige\s*reisen|willingness\s*to\s*travel|business\s*travel\s*required|on[- ]site\s*client\s*visits|travel\s*across\s*regions|regelmäßige\s*dienstreisen|örtlich\s*flexibel|häufige\s*dienstreisen|zu\s*dienstreisen\s*(gerne\s*)?bereit|berufliche\s*reisen|\bortswechsel\b|montagereisen|servicereisen|kundentermine\s*im\s*in-?\s*und\s*ausland|mehrtägige\s*(service|montage)?reisen/i))){
    guess.mobile = 1; evidence.mobile = snippetAround(original, m.index, m[0].length);
  }

  const ALL = ['deg','de','en','exp','wm','cust','phys','shift','autonomy','variety','competitive','creative','leadership','mobile'];
  const estimated = ALL.filter(k => !(k in guess));
  // _text: sonradan eklenen AI soft-field katmanı için ham metni burada saklıyoruz (bu fonksiyonun
  // zaten decode ettiği metin) — çağıran taraf isterse item'a _rawText olarak ekleyip kullanır,
  // istemezse yok sayar. Mevcut hiçbir kullanım şeklini etkilemez (ekstra bir alan sadece).
  return { guess, estimated, evidence, _text: original };
}

// Whittle'ın şu an canlıdaki 3 alan grubu (Finance/Tech/Marketing) için başlık+açıklama metninden
// keyword-sayımıyla TAHMİN — kesin değil, en çok eşleşen kazanıyor, eşitlik/hiç eşleşme yoksa
// null dönüyor (Whittle tarafında elle seçilmesi gerektiği anlamına gelir). Bilerek basit ve
// şeffaf tutuldu — niche tespitinin app tarafındaki mantığıyla aynı ruhta (regex eşleştirme).
const NICHE_KEYWORDS = {
  Finance: /finance|financial|accounting|buchhaltung|controlling|treasury|audit|wirtschaftsprüf|steuerberat|\btax\b|kredit|invest(ment|or)?|banking|rechnungswesen|bilanz/gi,
  // DÜZELTME: "entwickl" tek başına çok genelti — "Personalentwicklung", "Produktentwicklung",
  // "Organisationsentwicklung" gibi Tech'le ilgisi olmayan HR/iş kelimelerini de yakalayıp
  // yanlış "Tech" etiketi koyuyordu (Helvetia'nın bir İK rolünde gördüğümüz gibi). Artık sadece
  // yazılım/uygulama/web geliştirme bağlamındaki "entwickl" kalıplarını arıyor.
  Tech: /developer|software\s?entwickl|app\s?entwickl|web\s?entwickl|\bsoftware\b|\bengineer|\bit[\s-]|frontend|backend|full[\s-]?stack|devops|data (scientist|analyst|engineer)|programmier|\bcoding\b|cloud|cyber|it-support/gi,
  // DÜZELTME: düz "kommunikation" ve "pr" çok genelti — "Kommunikationsfähigkeit" (iletişim
  // becerisi) neredeyse HER ilanda soft-skill olarak geçiyor, alanla ilgisi yok (UniQA'nın bir
  // sigorta operasyon rolünü, Generali'nin bir satış rolünü yanlışlıkla Marketing yapmıştı).
  // Artık sadece pazarlama/iletişim bağlamındaki bileşik kelimeleri arıyor.
  // KRİTİK DÜZELTME: "werbung" (reklam) kelimesi "Bewerbung" (başvuru) kelimesinin İÇİNDE de
  // geçiyor ("Be-WERBUNG") — ve "Bewerbung"/"jetzt bewerben" neredeyse HER ilanda birden fazla
  // kez geçen standart bir ifade. Bu yüzden ilgisiz onlarca ilan yanlışlıkla Marketing'e
  // yazılıyordu (UniQA'nın sigorta rolü, Generali'nin satış rolü gibi). Negatif lookbehind ile
  // "be" öneki hariç tutuldu. "brand" da kelime sınırına alındı ("Brandschutz" = yangın güvenliği
  // ile karışmasın diye).
  Marketing: /marketing|social media|\bcontent\b|\bseo\b|\bsem\b|\bbrand(ing)?\b|unternehmenskommunikation|marketingkommunikation|public relations|\bgrowth\b|kampagne|(?<!be)werbung/gi,
  // DÜZELTME (Bitpanda — Eren'in fark ettiği eksik): Sales ve Legal diye bir kategori HİÇ yoktu,
  // bu yüzden satış/hukuk ilanları ya yanlış bir kategoriye ya da hiçbir kategoriye düşmüyordu.
  // İkisi de eklendi.
  Sales: /\bsales\b|vertrieb|verkauf|account executive|business development|kundenberatung|\bkey account\b|akquise/gi,
  Legal: /\blegal\b|compliance|\bregulatory\b|\brisk\b|jurist|rechtsabteilung|contract management|vertragsrecht|datenschutz|dsgvo|gdpr/gi,
};

// DÜZELTME (Eren'in fark ettiği yüksek null oranı — 382 ilanın 139'u/%36'sı hiçbir niche'e
// düşmüyordu): "en az 2 eşleşme" kuralı genel olarak doğru bir güvenlik önlemi (tek rastgele
// kelimeyle yanlış etiketlemekten iyi), ama BAZI kelimeler o kadar net/tek-anlamlı ki (ör.
// "Wirtschaftsprüfung", "Buchhalter", "Compliance") tek geçmeleri bile yeterince güvenilir bir
// sinyal — bunları 2 eşleşmiş gibi saymak yanlış pozitif riskini neredeyse hiç artırmıyor, ama
// kapsamı ciddi şekilde iyileştiriyor (BDO'nun audit/tax ilanları, Buchhalter unvanlı roller,
// Red Bull'un "Marketeer" unvanı gibi durumlar). Genel/çok-anlamlı kelimeler (ör. "finance",
// "tax", "risk") BİLEREK bu listede değil — onlar hâlâ 2 eşleşme istiyor.
const STRONG_NICHE_SIGNALS = {
  Finance: /wirtschaftsprüf|steuerberat|buchhalter|buchhaltung|bilanzbuchhalter|rechnungswesen|\baudit\b|\baudit(or|ing)\b/i,
  Tech: /software\s?entwickl|\bdeveloper\b|full[\s-]?stack|frontend|backend|\bdevops\b|data (scientist|engineer)|it-support/i,
  Marketing: /\bmarketeer\b|social media|marketingkommunikation|unternehmenskommunikation/i,
  Sales: /account executive|business development|\bkey account\b/i,
  Legal: /\bcompliance\b|rechtsabteilung|jurist/i, // "jurist" bilerek \b'siz — Almanca'da sık sık birleşik kelime içinde geçiyor (Unternehmensjurist, Syndikusjurist)
};

function guessNiche(text){
  const t = text || '';
  let best = null, bestCount = 0;
  for(const [niche, re] of Object.entries(NICHE_KEYWORDS)){
    const matches = t.match(re);
    let count = matches ? matches.length : 0;
    const strongRe = STRONG_NICHE_SIGNALS[niche];
    if(strongRe && strongRe.test(t)) count = Math.max(count, 2); // tek başına yeterince net — 2 eşleşmiş gibi say
    if(count > bestCount){ best = niche; bestCount = count; }
  }
  // DÜZELTME: tek bir rastgele kelime eşleşmesiyle (ör. metnin bir yerinde geçen tek bir "PR"
  // ya da "content" kelimesi) yanlış bir niche atamak, hiç atamamaktan (null = elle bakılmalı)
  // daha kötü bir hata sınıfı. En az 2 eşleşme (ya da yukarıdaki güçlü tek-kelime istisnası)
  // olmadan karar vermiyoruz.
  return bestCount >= 2 ? best : null;
}

// DÜZELTME (Bitpanda): bazı ATS'ler (Greenhouse gibi) her ilanın kendi departman kategorisini
// ("Commercial, Marketing & Comms", "Legal & Compliance & Risk", "Engineering & Technology" gibi)
// ŞİRKETİN KENDİSİ beyan ettiği, yapılandırılmış bir alan olarak veriyor — bu, tüm ilan metnindeki
// kelimeleri sayıp TAHMİN etmekten (guessNiche) çok daha güvenilir, çünkü tahmin değil şirketin
// kendi sınıflandırması. Varsa ÖNCE bunu deniyoruz, yoksa/eşleşmezse guessNiche'e düşüyoruz.
function mapDepartmentToNiche(departmentNames){
  if(!departmentNames || !departmentNames.length) return null;
  const t = departmentNames.join(' ');
  if(/legal|compliance|risk|\blaw\b/i.test(t)) return 'Legal';
  if(/marketing|commercial|comms|communication/i.test(t)) return 'Marketing';
  if(/\bsales\b|business development/i.test(t)) return 'Sales';
  if(/finance|treasury|accounting/i.test(t)) return 'Finance';
  if(/engineering|technology|\btech\b|product|r&d|r\s*&\s*d|data/i.test(t)) return 'Tech';
  return null;
}

// Whittle'ın hedef kitlesi WU'ya yeni başlayan öğrenciler — yani Praktikum/Werkstudent/Junior/
// Graduate seviyesi arıyorlar, 5+ yıl deneyim isteyen roller değil. Başlıktaki kelimelere bakarak
// TAHMİN ediyoruz (yine kesin değil — ör. "Marketing Manager" hem junior hem senior bir rol olabilir,
// başlıktan anlaşılmıyorsa null dönüyor, elle bakılmalı). "junior" işareti varsa güvenle junior,
// "senior/head of/architect/expert/lead" gibi işaretler varsa muhtemelen hedef kitleye uygun değil.
const JUNIOR_TITLE_KEYWORDS = /praktikum|praktikant|werkstudent|internship|\bintern\b|\bjunior\b|trainee|graduate|entry.level|absolvent/i;
// DÜZELTME (Eren'in "elenenler doğru mu elendi" sorusu üzerine fark edilen boşluk — ters yönlü bir
// risk): bu liste İngilizce kıdem kelimelerine (senior/director/lead vb.) ve birkaç Almanca yönetim
// unvanına (regionalleitung/verbundleitung) bakıyordu ama Almanca'da son derece yaygın olan
// Geschäftsführer/Bereichsleiter/Abteilungsleiter/Prokurist/Vorstand/Niederlassungsleiter gibi KESİN
// senior unvanlar hiç yoktu — yani bu roller YANLIŞLIKLA ELENMİYOR değil, tam tersi, kıdemi
// "belirsiz" sayılıp yanlışlıkla paste bloğuna DAHİL edilme riski taşıyordu.
// 28.09: öğrenci platformu için genişletildi — Leitung/Leiter*in (Team-, Filial-, Stations-…), Direktor*in,
// C-level, Fach-/Oberärzt*in, Primar, Experte/Expertin, Professor*in, Postdoc da eleniyor. (Praktikum/Trainee
// gibi junior kelime de geçiyorsa guessSeniority yine "belirsiz" der, ilan kalır.)
const SENIOR_TITLE_KEYWORDS = /\bsenior\b|\bsr\.?\s|(^|[\s(\/-])(cfo|ceo|cto|coo|cio|cmo|chief)\b(?!\s*(specialist|services|advisory|office))|direktor|director|\bleitung\b|(?<!beg)leiter(\*in|:in|_in|in|innen)?\b|(team|gruppen|abteilungs|bereichs|filial|markt|standort|projekt|stations|pflegedienst|referats|betriebs|küchen|lager|schicht|verkaufs|bau|werkstätten|haus|kindergarten|einrichtungs|gebiets|vertriebs|niederlassungs|geschäfts|kanzlei|praxis|wohnbereichs|heim|schul|instituts|klinik|regional|landes)(leitung|leiter)|fach(ä|ae)rzt(?!\w*ausbildung)|facharzt(?!ausbildung)|ober(ä|ae)rzt|oberarzt|chef(ä|ae)rzt|chefarzt|primar|\bexpert(in|e)\b|professor|postdoc|post-doc|\bhead of\b|\bprincipal\b|\bdirector\b|\bteam\s*lead\b|regionalleitung|verbundleitung|\barchitect\b|\bexpert\b|\blead\b(?!ership)|geschäftsführ|bereichsleit|abteilungsleit|niederlassungsleit|werksleit|prokurist|vorstand|^\s*(senior\s+)?manager(:in|\*in|_in|\/in|in)?(?=[\s(,\/-]|$)(?![^,(]*\b(trainee|praktik|intern))|\b(assistant|associate)\s+manager\b(?=.*(audit|tax|advisory|consulting))/i;
// DÜZELTME: Post AG gibi büyük lojistik/operasyon ağırlıklı işverenlerde, kurye/depo/şoför gibi
// hiçbir ofis/profesyonel niteliği olmayan roller — yanlış nicheGuess yüzünden (ör. "Marketing")
// bir öğrenciye "sana uygun" diye gösterilmesin diye başlık bazlı eleniyor. BİLEREK dar tutuldu:
// "Verkaufsberater*in Filiale" gibi mağaza-içi satış rolleri elenmiyor, çünkü Whittle'ın kendi
// SALES:retail kategorisi ("Einzelhandel & Kundenberatung") bunları zaten meşru şekilde kapsıyor.
const MANUAL_LABOR_TITLE_KEYWORDS = /\bzusteller|\bzustellung|paketzusteller|briefzusteller|\blenker(?:in)?\b|kraftfahrer|kfz-lenkerdienst|lagerarbeit|lagermitarbeit|kommissionier|vorsortierkraft|sortierkraft|\bpostbote\b|reinigungskraft|staplerfahrer|produktionsmitarbeit/i;
function guessManualLabor(title){
  return MANUAL_LABOR_TITLE_KEYWORDS.test(title || '');
}
// DÜZELTME: bazı şirketler "gerçek" bir pozisyon değil, genel bir "bize her zaman başvurabilirsin"
// duyurusu yayınlıyor (Initiativbewerbung / spontane Bewerbung / speculative application) — bu,
// belirli bir alana/niteliğe bağlı olmadığı için niche tahmini de anlamsız çıkıyor (rastgele bir
// kategoriye düşüyor). Gerçek bir açık pozisyon olmadığı için bunları da elemek daha doğru.
const GENERIC_APPLICATION_KEYWORDS = /initiativbewerbung|spontanbewerbung|spontane bewerbung|speculative application|open application|blindbewerbung|test ?ausschreibung|bitte nicht bewerben|do not apply/i;
function guessGenericApplication(title){
  return GENERIC_APPLICATION_KEYWORDS.test(title || '');
}
function guessSeniority(title){
  const t = title || '';
  // "Assistant to the CEO" / "Assistenz der Geschäftsführung" üst yönetim DEĞİL, destek rolü.
  const junior = JUNIOR_TITLE_KEYWORDS.test(t) || /assist(ant|enz)\b.{0,25}\b(ceo|cfo|vorstand|geschäftsführ|leitung)/i.test(t);
  const senior = SENIOR_TITLE_KEYWORDS.test(t);
  if(junior && !senior) return 'junior';
  if(senior && !junior) return 'senior';
  return null; // belirsiz — orta seviye ya da başlıktan anlaşılmıyor, elle bakılmalı
}


// ---- Greenhouse / Lever / Recruitee / Workable / SmartRecruiters doğrudan API yolu ----
// Bu 5 ATS'in hepsinin gerçek, halka açık, dokümante JSON API'leri var — DOM kazımaya hiç gerek
// yok. URL'in kendisi bunlardan biri mi diye bakıyoruz (host + ilk path segmenti = şirket token'ı).
function detectAtsFromUrl(url){
  try{
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const path = u.pathname;
    // API'nin kendi ham URL'si yapıştırılmış olabilir (ör. /v1/boards/{token}/jobs,
    // /v0/postings/{token}) — bunu normal board URL'sinden (ör. /{token}) ayırt et.
    const boardsApiMatch = path.match(/^\/v1\/boards\/([^\/]+)/);
    const postingsApiMatch = path.match(/^\/v0\/postings\/([^\/]+)/);
    const plainSeg = (path.match(/^\/([^\/]+)/) || [])[1];
    // Workday (PwC, A1, Lindt): liste sayfası JS ile render ediliyor, genel crawler 26.09'da PwC/A1'de
    // 0 buldu. Sitenin kendi ön yüzünün çağırdığı CXS JSON API'sini kullanıyoruz. SADECE board URL'i
    // (içinde /job/ geçmeyen) eşleşiyor — tekil ilan linkleri buraya düşüp her seferinde tüm board'u
    // yeniden çekmesin diye. Yol: [/{locale}]/{site}, ör. /de-DE/LindtSpruengliGroupCareers.
    // 30.09: HOFER / SPAR — liste sayfaları JS ile yükleniyor; kendi JSON uç noktaları kullanılıyor (bkz. fetchHoferJobs/fetchSparJobs).
    if(host === 'karriere.hofer.at' && !/^\/job\//.test(path)) return { type: 'hofer', origin: u.origin };
    if(/(^|\.)dm-jobs\.at$/.test(host) && !/^\/job\//.test(path)) return { type: 'dm' };
    // 01.10: Austrian Airlines — lufthansagroup.careers/de/austrian/... sayfası JS ile yükleniyor; sitenin kendi
    // arama API'si (api-apply.lufthansagroup.careers/search) kullanılıyor. Tekil ilan linkleri (ac=jobad) buraya düşmez.
    if(/(^|\.)lufthansagroup\.careers$/.test(host) && /\/austrian/.test(path)) return { type: 'austrian' };
    // 04.10: Avature (UniCredit, Frequentis, L'Oréal, Coca-Cola HBC) — tarayıcı taraması metni ya boş ya da GDPR
    // uyarısı olarak alıyordu. Liste + detay sayfaları sunucu tarafında HTML, doğrudan okunuyor.
    if(/^(careers\.unicredit\.eu|jobs\.frequentis\.com|careers\.loreal\.com|careers\.coca-colahellenic\.com)$/.test(host)) return { type: 'avature', url };
    // 15.10: Siemens da Avature (liste sayfa başı 6 ilan, jobOffset ile). Sadece arama sayfası — tekil JobDetail linki değil.
    if(host === 'jobs.siemens.com' && /SearchJobs/i.test(path)) return { type: 'avature', url };
    // 15.10: sıfır ilan veren şirketlerin kendi uç noktaları (bkz. fetchMicrosoftJobs … fetchBinderJobs).
    if(/^(apply|jobs)\.careers\.microsoft\.com$/.test(host) && !/\/job\/\d/.test(path)) return { type: 'microsoft' };
    if(host === 'jobboerse.strabag.at' && !/job-detail/.test(path)) return { type: 'strabag' };
    if(/\.ob\.sagedpw\.at$/.test(host) && /onlinebewerbung_uebersicht/.test(path)) return { type: 'sagedpw', url };
    if(/(^|\.)horvath-partners\.com$/.test(host) && /\/(jobsuche|jobsearch)\/?$/.test(path)) return { type: 'horvath', url };
    if(/(^|\.)bindergroesswang\.at$/.test(host) && /\/(career|karriere)\/jobs\/?$/.test(path)) return { type: 'binder', url };
    // 02.10: Roland Berger (kendi arama API'si → ilanlar SmartRecruiters'ta), Kearney (Yello), Henkel (kendi AJAX listesi).
    if(/(^|\.)rolandberger\.com$/.test(host) && /\/join/i.test(path)) return { type: 'rolandberger' };
    if(/(^|\.)kearney\.recsolu\.com$/.test(host) && /^\/job_boards\/\d+/.test(path)) return { type: 'yello', origin: u.origin, board: path.match(/^\/job_boards\/(\d+)/)[1], company: 'Kearney' };
    if(/(^|\.)henkel\.com$/.test(host) && /find-your-job/.test(path)) return { type: 'henkel' };
    // 02.10: SAP SuccessFactors kariyer siteleri (KPMG, RBI, Post, Allianz …) — "/go/<Kategori>/<id>/" liste sayfaları
    // sunucu tarafında HTML olarak geliyor; tarayıcı gerekmiyor. Sayfalama: /go/<Kategori>/<id>/<startrow>/.
    { const go = path.match(/^(\/[^\/]+)?\/go\/[^\/]+\/\d+\/?$/); if(go) return { type: 'successfactors', base: u.origin + path.replace(/\/?$/, '/'), origin: u.origin }; }
    // SuccessFactors arama sayfası (EY, UNIQA): /search/?…locationsearch=… ya da searchby=location → sayfalama &startrow=N
    if(/^(\/[^\/]+)?\/search\/?$/.test(path) && /(locationsearch|searchby=location|createNewAlert|optionsFacetsDD_)/i.test(u.search)) return { type: 'successfactors', search: url, origin: u.origin }; // 10.10: ülke facet'i (Borealis optionsFacetsDD_country=AT) de
    if(/(^|\.)spar\.at$/.test(host) && /^\/karriere/.test(path) && !/\/jobboerse\/[^\/]+\/\d+/.test(path)) return { type: 'spar' };
    if(/\.myworkdayjobs\.com$/.test(host) && !/\/job\//.test(path)){
      const segs = path.split('/').filter(Boolean);
      const hasLocale = segs[0] && /^[a-z]{2}-[A-Z]{2}$/.test(segs[0]);
      const site = hasLocale ? segs[1] : segs[0];
      const tenant = host.split('.')[0];
      if(site) return { type: 'workday', origin: u.origin, tenant, site, locale: hasLocale ? segs[0] : null, token: `${tenant}/${site}` };
    }
    if(/(^|\.)greenhouse\.io$/.test(host)){
      // Gömülü pano linki: boards.greenhouse.io/embed/job_board?for=<token>
      const token = u.searchParams.get('for') || (boardsApiMatch && boardsApiMatch[1]) || (plainSeg !== 'embed' ? plainSeg : null);
      // 01.10: boards-api.eu.greenhouse.io diye bir host YOK (DNS çözülmüyor → Bitpanda'da "fetch failed"). AB panoları da
      // global API'den geliyor (doğrulandı: boards-api.greenhouse.io/v1/boards/bitpanda/jobs çalışıyor).
      const apiHost = 'boards-api.greenhouse.io';
      if(token) return { type: 'greenhouse', token, apiHost };
    }
    if(/(^|\.)lever\.co$/.test(host)){
      const token = (postingsApiMatch && postingsApiMatch[1]) || plainSeg;
      if(token) return { type: 'lever', token, eu: /(^|\.)eu\.lever\.co$/.test(host) }; // 03.10: jobs.eu.lever.co → api.eu.lever.co
    }
    // Personio (29.09 — Refurbed, Anyline): {sirket}.jobs.personio.de|com. Herkese açık XML beslemesi var
    // (/xml), tarayıcı açmaya gerek yok.
    if(/\.jobs\.personio\.(de|com)$/.test(host)){
      const sub = host.split('.')[0];
      if(sub) return { type: 'personio', token: sub, tld: host.endsWith('.com') ? 'com' : 'de' };
    }
    // Recruitee: {sirket}.recruitee.com — token alan adının ilk parçası.
    if(/\.recruitee\.com$/.test(host)){
      const sub = host.split('.')[0];
      if(sub && sub !== 'api') return { type: 'recruitee', token: sub };
    }
    // Workable: apply.workable.com/{slug} (güncel) ya da {slug}.workable.com (eski).
    if(host === 'apply.workable.com' && plainSeg && plainSeg !== 'api'){
      return { type: 'workable', token: plainSeg };
    }
    if(/\.workable\.com$/.test(host) && host !== 'apply.workable.com'){
      const sub = host.split('.')[0];
      if(sub && sub !== 'www') return { type: 'workable', token: sub };
    }
    // SmartRecruiters: jobs.smartrecruiters.com/{Company} ya da careers.smartrecruiters.com/{Company}.
    if(/(^|\.)smartrecruiters\.com$/.test(host) && plainSeg && plainSeg !== 'v1'){
      return { type: 'smartrecruiters', token: plainSeg };
    }
    // onlyfy (eski adıyla softgarden "onlyfy one"): softgarden'dan FARKLI olarak sabit bir alan adı
    // var — {müşteri}.onlyfy.jobs. Widget kimliği (token) ya path'te (/candidate/widget/{token}),
    // ya da query string'te (?widgetConfig={token}) geliyor — Magenta'da DevTools'ta bulunan
    // "magenta.onlyfy.jobs/candidate/widget/y6lvdyzt/..." örneğine göre yazıldı.
    // 05.10: BambooHR (woom) — {şirket}.bamboohr.com/careers, herkese açık JSON: /careers/list + /careers/{id}/detail.
    if(/\.bamboohr\.com$/.test(host) && !/\/careers\/\d+/.test(path)) return { type: 'bamboohr', sub: host.split('.')[0] };
    if(/\.onlyfy\.jobs$/.test(host)){
      const sub = host.split('.')[0];
      const widgetPathMatch = path.match(/\/candidate\/widget\/([^\/?]+)/);
      const token = u.searchParams.get('widgetConfig') || (widgetPathMatch && widgetPathMatch[1]);
      if(sub && token) return { type: 'onlyfy', subdomain: sub, token };
    }
    // BMW Group (bmwgroup.jobs) — Adobe AEM/Sling tabanlı. Job Finder widget'ı sayfa yüklendikten
    // sonra kendi AEM "selector" uç noktasını (.jobfinder_table.content.html) çağırıp hazır bir
    // HTML parçası alıyor — Eren'in DevTools'ta bulduğu örnek (Wien):
    //   https://www.bmwgroup.jobs/at/de/standorte/wien/_jcr_content/main/layoutcontainer_copy/
    //     jobfinder30_copy.jobfinder_table.content.html?filterSearch=location_AT%2FVienna&rowIndex=0&blockCount=5
    // Bu URL'in KENDİSİNİ (DevTools'tan kopyalanmış hali) parser'a verirsen tanınır — path'teki
    // "/standorte/{şehir}/" kısmından şehir adını, "filterSearch" query param'ından ülke/şehir
    // kodunu çıkarıyoruz. Her ilanın kendi detay sayfası da (job-description-copy.{id}.html) statik
    // HTML — locale prefix'i (ör. "/at/de") "/standorte/" öncesinden türetiyoruz.
    if(/(^|\.)bmwgroup\.jobs$/.test(host) && /jobfinder_table\.content\.html$/.test(path)){
      const localeMatch = path.match(/^(.*)\/standorte\/([^\/]+)\//);
      if(localeMatch){
        const localePrefix = localeMatch[1]; // ör. "/at/de"
        const citySlug = localeMatch[2]; // ör. "wien"
        const filterSearch = u.searchParams.get('filterSearch') || '';
        return { type: 'bmw', origin: u.origin, basePath: path, localePrefix, citySlug, filterSearch };
      }
    }
    // Bain & Company (bain.com) — kendi dahili arama API'si, sayfa yüklenmeden de erişilebilir
    // statik bir GET uç noktası. Eren'in DevTools'ta bulduğu örnek (Wien/offices filtresi ile):
    //   https://www.bain.com/de/api/jobsearch/keyword/get?start=0&results=10&filters=offices(1529351)|&searchValue=
    // "filters" query param'ı zaten belirli bir ofise göre filtrelenmiş geliyor (Eren'in UI'da
    // "Wien" seçince oluşan istek buydu) — biz sadece start/results'ı kendimiz yöneterek
    // sayfalıyoruz, filters'ı OLDUĞU GİBİ koruyoruz.
    if(/(^|\.)bain\.com$/.test(host) && /\/api\/jobsearch\/keyword\/get$/.test(path)){
      const filters = u.searchParams.get('filters') || '';
      return { type: 'bain', origin: u.origin, filters };
    }
    // McKinsey & Company — gateway.mckinsey.com üzerinden çalışan kendi arama API'si. Bot koruması
    // yok (Bain'in aksine), liste cevabı zaten TAM açıklama taşıyor (whatYouWillDo/yourBackground/
    // whoYouWillWorkWith) — ayrıca detay sayfası çekmeye gerek yok. Eren'in DevTools'ta bulduğu
    // örnek: https://gateway.mckinsey.com/apigw-x0cceuow60/v1/api/jobs/search?pageSize=20&start=1&
    // cities=Vienna&lang=en — "cities" query param'ı GERÇEKTEN filtreliyor (Phenom'un aksine),
    // doğrulandı: 31 ilanın hepsi cities dizisinde "Vienna" içeriyordu.
    if(/(^|\.)mckinsey\.com$/.test(host) && /\/api\/jobs\/search$/.test(path)){
      const cities = u.searchParams.get('cities') || '';
      const lang = u.searchParams.get('lang') || 'en';
      return { type: 'mckinsey', origin: u.origin, basePath: path, cities, lang };
    }
    // Schönherr Rechtsanwälte — kendi sitesi (schoenherr.eu) bir onlyfy "aday portalı" SPA'sına
    // yönlendiriyor ama o SPA içeriği tamamen client-side JS ile yüklüyor (Puppeteer'ın normal
    // bekleme süresinde yakalayamadığı, "All jobsEN" gibi neredeyse boş kalan bir sayfa üretiyor).
    // Kendi sitesindeki Umbraco CMS'in sunucu-taraflı render ettiği liste uç noktası ise (Eren'in
    // DevTools Network sekmesinde bulduğu) başlık+konum+departman veriyor (açıklama YOK — bu yüzden
    // deg/de/en/exp/wm hep "estimated" kalacak, ama en azından gerçek ilan + doğru şehir filtresi).
    // https://www.schoenherr.eu/umbraco/surface/JobFiltersSurface/GetJobList?country=Austria&field=&lng=en-US
    if(/(^|\.)schoenherr\.eu$/.test(host) && /\/umbraco\/surface\/JobFiltersSurface\/GetJobList$/i.test(path)){
      return { type: 'schoenherr', origin: u.origin, search: u.search };
    }
    // MediaMarkt Austria (careers.mediamarktsaturn.com) — SAP SuccessFactors Career Site Builder,
    // ama ilan arama tamamen Azure Cognitive Search üzerinden (Eren'in DevTools Network'te bulduğu
    // gerçek istek): POST https://searchui.search.windows.net/indexes/mms-prod/docs/search — bir
    // "api-key" header'ı ile (bu, Azure Search'ün salt-okunur "query key"i, sitenin kendi tarayıcı
    // kodu da aynısını herkese açık şekilde kullanıyor, gizli bir sır değil). "mms-prod" index'i
    // MediaMarkt + Saturn markalarının + birden fazla ülkenin ilanlarını birlikte tutuyor gibi
    // görünüyor — path'in ilk parçası (ör. "/MediaMarktAT/") marka/site kodu, onu ayıklayıp Azure
    // sorgusunda "brand" alanına göre kendi tarafımızda filtreliyoruz.
    if(/(^|\.)mediamarktsaturn\.com$/.test(host) && /^careers\./.test(host)){
      const brand = plainSeg || 'MediaMarktAT';
      return { type: 'mediamarkt', brand };
    }
  }catch(e){ /* geçersiz URL, yoksay */ }
  return null;
}

// Çoğu şirket Greenhouse/Lever'ı kendi domaininin (ör. careers.sirket.com) ARKASINA gömüyor —
// sayfada bir iframe, "başvur" linki ya da embed script'i olarak. Tarayıcı sayfayı yükledikten
// sonra tüm iframe/link/script kaynaklarını tarayıp bunlardan biri Greenhouse/Lever'a mı
// gidiyor diye bakıyoruz. Bulursak, kırılgan chunk-split tahminine hiç girmeden API'ye geçiyoruz.
async function detectEmbeddedAts(page){
  const srcs = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('iframe[src],a[href],script[src]').forEach(el => {
      const v = el.getAttribute('src') || el.getAttribute('href');
      if(v) out.push(v);
    });
    return out;
  });
  for(const src of srcs){
    try{
      const abs = new URL(src, page.url()).href;
      const det = detectAtsFromUrl(abs);
      if(det) return det;
    }catch(e){ /* geçersiz/bağıl olmayan URL, atla */ }
  }
  return null;
}

// Whittle'ın hedef kitlesi (WU'ya yeni başlayan öğrenciler) senior/kıdemli roller aramıyor —
// bu yüzden "Toplu İçe Aktar"a yapıştırılacak bloktan seniorityGuess==='senior' olan ilanlar
// otomatik ÇIKARILIYOR (junior + belirsiz/null kalıyor, elle gözden geçirilebilsin diye).
// Çıkarılanlar kaybolmuyor — ayrı bir listede gösteriliyor, sadece paste bloğunun dışında.
function splitByTargetFit(items){
  // DEĞİŞTİ (26.09): kurye/depo/şoför/üretim ilanları artık ELENMİYOR — Whittle'ın Handwerk, Bau &
  // Produktion şemsiyesi (Lager, Fahren & Transport, Produktion) tam da bu ilanlar için var ve
  // öğrenciler için Teilzeit/Geringfügig zustell/lager işleri gerçek bir hedef. Sadece senior ve
  // genel (Initiativbewerbung) ilanlar dışarıda kalıyor.
  // Başlığı şirket adından ibaret olan kayıtlar (ör. "UniCredit") gerçek ilan değil — hangi yoldan gelirse gelsin ele.
  const norm = x => (x || '').toLowerCase().replace(/[^a-z0-9äöü]/g, '');
  // 30.09 (TROX): "RO | INTERNAL SALES ENGINEER" — başlıktaki ülke kodu öneki yabancı ilan demek.
  const FOREIGN_PREFIX = /^(RO|HU|CZ|SK|PL|DE|CH|SI|HR|RS|BG|IT|FR|UK|GB|US|ES|NL|BE|UA|TR|BA|ME|MK|AL|LT|LV|EE|DK|SE|NO|FI|CN|IN)\s*[|:–]\s/;
  const bad = it => guessGenericApplication(it.title) || !it.title || FOREIGN_PREFIX.test(String(it.title).trim()) || norm(it.title) === norm(it.companyName) || norm(it.title) === norm(it._company)
    || isJunkTitle(it.title) || (isAustriaMode(it._city)
      ? FOREIGN_CITY_IN_TITLE.test(it.title) && !buildCityRegex('AT').test(it.title)   // AT modu: sadece yurt dışı başlıklar elenir
      : (OTHER_CITY_IN_TITLE.test(it.title) && !/wien|vienna/i.test(it.title)) || isNonViennaTitle(it.title));
  // 28.09: ilan açıkça 5+ yıl deneyim istiyorsa (exp=3, tahmin değil) öğrenciye uygun değil → senior say.
  const tooSenior = it => guessSeniority(it.title) === 'senior' || (it.exp === 3 && !(it.estimated || []).includes('exp') && !JUNIOR_TITLE_KEYWORDS.test(it.title || ''));
  const included = items.filter(it => !tooSenior(it) && !bad(it));
  const excluded = items.filter(it => tooSenior(it) || bad(it));
  return { included, excluded };
}
function printExcludedSenior(excluded){
  if(!excluded.length) return;
  console.log(`\n🚫 ${excluded.length} ilan hedef kitleye uygun görünmediği için paste bloğunun DIŞINDA bırakıldı:`);
  excluded.forEach(it => {
    const reason = it.seniorityGuess === 'senior' ? 'senior/kıdemli' : 'genel/inisiyatif başvurusu (belirli bir pozisyon değil)';
    console.log(`  - ${it.title} (${it.companyName}) — ${reason}`);
  });
}


// Workday CXS API. DOĞRULANMADI (26.09, sandbox'tan ağ yok) — yapı Workday'in herkese açık kariyer
// sitelerinin kendi kullandığı uç noktaya göre yazıldı: POST {origin}/wday/cxs/{tenant}/{site}/jobs
// {appliedFacets, limit<=20, offset, searchText} → {total, jobPostings:[{title, externalPath,
// locationsText, postedOn}]}; detay: GET {origin}/wday/cxs/{tenant}/{site}{externalPath} →
// {jobPostingInfo:{jobDescription(HTML), location, additionalLocations[], externalUrl}}.
// Başarısız olursa null döner, runCrawlBatch genel crawl'a düşer (Lindt'in çalışan akışı bozulmaz).
async function fetchWorkdayJobs(ats){
  const { origin, tenant, site } = ats;
  const api = `${origin}/wday/cxs/${tenant}/${site}`;
  const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36' };
  const city = (ats.cityFilter || 'Wien');
  const alias = CITY_ALIASES[city.toLowerCase()];
  // Global board'larda (PwC Global_Campus_Careers) filtresiz çekmek binlerce ilan demek — şehir
  // adıyla (ve Wien/Vienna eş anlamlısıyla) iki ayrı tam-metin araması yapıp birleştiriyoruz.
  const atMode = isAustriaMode(city);
  const terms = /^(\*|any|alle)$/i.test(city) ? [''] : atMode ? ['Austria', 'Österreich', 'Wien', 'Vienna', 'Graz', 'Linz', 'Innsbruck', 'Salzburg', 'Kundl'] : [city, alias].filter(Boolean);
  const byPath = new Map();
  let got422 = false, gotHtml = false;
  // (27.09 Takeda: HTTP 422) Bazı Workday kurulumları searchText ile aramayı reddediyor. O durumda
  // aramasız tüm listeyi çekip konumu (locationsText) şehir adıyla süzüyoruz.
  const cityRe = atMode ? buildCityRegex(city) : new RegExp([city, alias].filter(Boolean).map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');
  const runTerms = async (termList, filterByLocation) => {
  for(const term of termList){
    for(let offset = 0; offset < 400; offset += 20){
      let data;
      try{
        const res = await fetch(`${api}/jobs`, { method:'POST', headers, signal: AbortSignal.timeout(15000),
          body: JSON.stringify({ appliedFacets:{}, limit:20, offset, searchText: term }) });
        if(!res.ok){ if(res.status === 422) got422 = true; console.log(`  ⚠️  Workday CXS HTTP ${res.status}: ${api}/jobs`); break; }
        const ct = res.headers.get('content-type') || '';
        if(!/json/i.test(ct)){ gotHtml = true; break; } // 03.10: JSON yerine HTML sayfası (Workday bakım/bot sayfası)
        data = await res.json();
      }catch(e){ console.log(`  ⚠️  Workday CXS isteği başarısız: ${e.message}`); break; }
      const posts = Array.isArray(data.jobPostings) ? data.jobPostings : [];
      posts.forEach(p => {
        if(filterByLocation && !cityRe.test(String(p.locationsText || '') + ' ' + String(p.externalPath || ''))) return;
        if(p.externalPath && !byPath.has(p.externalPath)) byPath.set(p.externalPath, p);
      });
      if(posts.length < 20 || (data.total && offset + 20 >= data.total)) break;
    }
  }
  };
  await runTerms(terms, atMode); // AT modunda tam-metin araması başka ülkeleri de getirebilir → konumla süz
  if(!byPath.size && got422 && terms[0] !== ''){
    console.log('  ↪︎ Workday aramayı reddetti (422) — aramasız liste çekilip konuma göre süzülüyor.');
    await runTerms([''], true);
  }
  // 03.10: Cumartesi sabahı wd1/wd3 (ABD veri merkezi) tüm isteklere HTML döndürdü — büyük ihtimalle Workday'in haftalık
  // bakımı. Tarayıcıyla denemek de boşa (aynı sayfa) → 0 ilanla dön; 0 ilanlı şirketin ilanları sitede kapanmıyor, yarın gelir.
  if(!byPath.size && gotHtml){ console.log('  ⚠️  Workday JSON yerine HTML döndürdü (muhtemelen bakım) — bugün atlanıyor, ilanlar sitede açık kalıyor.'); return Object.assign([], { skipToday: true }); }
  if(!byPath.size) return null;
  const out = [];
  for(const p of byPath.values()){
    let info = {};
    try{
      const res = await fetch(`${api}${p.externalPath}`, { headers, signal: AbortSignal.timeout(10000) });
      if(res.ok) info = (await res.json()).jobPostingInfo || {};
    }catch(e){ /* detay yok — liste verisiyle devam */ }
    const locs = [info.location, ...(Array.isArray(info.additionalLocations) ? info.additionalLocations : []), p.locationsText, info.country && (info.country.descriptor || info.country)].filter(x => x && typeof x === 'string');
    out.push({
      title: info.title || p.title || null,
      company: tenant,
      location: locs.join(' | ') || null,
      datePosted: info.startDate || p.postedOn || null,
      description: info.jobDescription || '',
      url: info.externalUrl || `${origin}${ats.locale ? '/' + ats.locale : ''}/${site}${p.externalPath}`,
    });
    await new Promise(r => setTimeout(r, 150));
  }
  return out;
}

async function fetchGreenhouseJobs(token, apiHost){
  apiHost = apiHost || 'boards-api.greenhouse.io'; // AB panoları (job-boards.eu.greenhouse.io) için boards-api.eu.greenhouse.io
  // DÜZELTME (24 Eylül — Bitpanda: aynı ilan 24 kez, farklı gerçek Greenhouse job ID'leriyle):
  // ?content=true parametresi, canlı ilan panosunda hiç görünmeyen ekstra kayıtlar (muhtemelen
  // kapalı/taslak/eski requisition'lar) da döndürüyor — canlı sitede "Analyst, AFC Compliance
  // Advisory" 1 kez varken content=true ile 24 farklı id ile geliyordu. content=true OLMADAN
  // gelen liste ise panoyla birebir eşleşiyor (doğrulandı: Bitpanda için ikisi de 26 vs 1 eşleşme
  // verdi). Bu yüzden önce content'siz "gerçek/açık" id listesini çekip, content=true cevabını
  // buna göre süzüyoruz — açıklama metnini kaybetmeden fazladan/hayalet kayıtları eliyoruz.
  const plainRes = await fetch(`https://${apiHost}/v1/boards/${token}/jobs`);
  const validIds = plainRes.ok ? new Set((await plainRes.json()).jobs?.map(j => j.id) || []) : null;

  const res = await fetch(`https://${apiHost}/v1/boards/${token}/jobs?content=true`);
  if(!res.ok) throw new Error(`Greenhouse API ${res.status} (token "${token}" yanlış olabilir)`);
  const data = await res.json();
  let jobs = validIds ? (data.jobs || []).filter(j => validIds.has(j.id)) : (data.jobs || []);
  // 30.09 (Bitpanda 0 ilan, panoda 23 ilan varken): id süzmesi her şeyi eliyorsa süzmeyi atla.
  if(!jobs.length && (data.jobs || []).length) jobs = data.jobs;
  console.log(`  [greenhouse] ${token}: liste ${validIds ? validIds.size : '—'}, içerikli ${(data.jobs || []).length}, kullanılan ${jobs.length}`);
  return jobs.map(j => ({
    title: j.title || null,
    company: token,
    location: (j.location && j.location.name) || null,
    datePosted: j.updated_at || null,
    // content HTML olarak geliyor, guessRequirements zaten kendi içinde metne indiriyor
    description: j.content || '',
    // DÜZELTME (26.09): url hiç set edilmiyordu — runAtsPath `j.url || sourceUrl`'e düşüp HER ilana
    // board linkini atıyordu (Bitpanda: 8 ilan, tek externalUrl). Whittle import'u externalUrl'e göre
    // tekilleştirdiği için 7'si "zaten var" sayılıp kayboluyordu. Lever/Recruitee/Workable'da da aynı.
    url: j.absolute_url || null,
    // DÜZELTME (Bitpanda): Greenhouse her ilanın departmanını (ör. "Legal & Compliance & Risk")
    // ayrı, yapılandırılmış bir alan olarak veriyor — mapDepartmentToNiche bunu kullanacak.
    departmentNames: Array.isArray(j.departments) ? j.departments.map(d => d.name).filter(Boolean) : [],
  }));
}

async function fetchLeverJobs(token, eu){
  const res = await fetch(`https://api.${eu ? 'eu.' : ''}lever.co/v0/postings/${token}?mode=json`);
  if(!res.ok) throw new Error(`Lever API ${res.status} (token "${token}" yanlış olabilir)`);
  const data = await res.json();
  return (Array.isArray(data) ? data : []).map(j => ({
    title: j.text || null,
    company: token,
    location: (j.categories && j.categories.location) || null,
    datePosted: j.createdAt ? new Date(j.createdAt).toISOString() : null,
    // 23.10: descriptionPlain sadece giriş kısmı; şartlar 'lists'te, maaş/çalışma saati çoğu zaman 'additionalPlain'de
    // (Qualysoft: ort. 830 karakter, maaş %0). Hepsi birleştiriliyor + commitment (Full-time/Part-time).
    description: [
      j.descriptionPlain || j.description || '',
      ...(Array.isArray(j.lists) ? j.lists.map(l => `${l.text || ''}\n${String(l.content || '').replace(/<li>/g, '\n• ').replace(/<[^>]+>/g, ' ')}`) : []),
      j.additionalPlain || j.additional || '',
      j.categories && j.categories.commitment ? `Employment type: ${j.categories.commitment}` : '',
    ].filter(Boolean).join('\n\n').replace(/[ \t]+/g, ' ').slice(0, 9000),
    url: j.hostedUrl || j.applyUrl || null,
  }));
}

async function fetchRecruiteeJobs(token){
  const res = await fetch(`https://${token}.recruitee.com/api/offers/`);
  if(!res.ok) throw new Error(`Recruitee API ${res.status} (token "${token}" yanlış olabilir)`);
  const data = await res.json();
  return (data.offers || []).map(j => ({
    title: j.title || null,
    company: token,
    location: j.city || (j.locations && j.locations[0] && j.locations[0].city) || null,
    datePosted: j.created_at || null,
    // Recruitee tek istekte tam açıklama + gereksinimleri de veriyor — Greenhouse/Lever'dan farklı
    // olarak ayrı bir detay isteğine gerek yok.
    description: [j.description, j.requirements].filter(Boolean).join(' '),
    url: j.careers_url || j.careers_apply_url || null,
  }));
}

function xmlTag(block, tag){
  const m = block.match(new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>'));
  if(!m) return null;
  return m[1].replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '').trim();
}
async function fetchPersonioJobs(token, tld){
  const origin = `https://${token}.jobs.personio.${tld || 'de'}`;
  const res = await fetch(`${origin}/xml?language=de`);
  if(!res.ok) throw new Error(`Personio XML ${res.status} (alt alan adı "${token}" yanlış olabilir)`);
  let xml = await res.text();
  // 02.10: İngilizce yayınlanan ilanlarda (Prewave) ?language=de açıklamaları boş veriyor → en ile tekrar dene.
  const hasDesc = x => /<jobDescription>[\s\S]*?<value>\s*(?:<!\[CDATA\[)?\s*\S{20}/.test(x);
  if(!hasDesc(xml)){ try{ const r2 = await fetch(`${origin}/xml?language=en`); if(r2.ok){ const x2 = await r2.text(); if(hasDesc(x2)) xml = x2; } }catch(e){} }
  const positions = xml.match(/<position>[\s\S]*?<\/position>/g) || [];
  return positions.map(p => {
    const id = xmlTag(p, 'id');
    const offices = [xmlTag(p, 'office'), ...((p.match(/<additionalOffices>[\s\S]*?<\/additionalOffices>/) || [''])[0].match(/<office>([\s\S]*?)<\/office>/g) || []).map(o => o.replace(/<\/?office>/g, '').trim())].filter(Boolean);
    const descs = (p.match(/<jobDescription>[\s\S]*?<\/jobDescription>/g) || [])
      .map(d => `<h3>${xmlTag(d, 'name') || ''}</h3>${xmlTag(d, 'value') || ''}`).join('\n');
    const schedule = xmlTag(p, 'schedule');
    return {
      title: xmlTag(p, 'name'),
      company: xmlTag(p, 'subcompany') || token,
      location: offices.join(', ') || null,
      datePosted: xmlTag(p, 'createdAt'),
      description: descs + (schedule ? `\n<p>${schedule}</p>` : ''),
      url: id ? `${origin}/job/${id}` : origin,
    };
  });
}

async function fetchWorkableJobs(token){
  const res = await fetch(`https://apply.workable.com/api/v1/widget/accounts/${token}?details=true`);
  if(!res.ok) throw new Error(`Workable API ${res.status} (token "${token}" yanlış olabilir)`);
  const data = await res.json();
  return (data.jobs || []).map(j => ({
    title: j.title || null,
    company: token,
    // 02.10: widget API konumu üst seviyede (city/state/country) ve "locations" dizisinde veriyor — j.location yok → Adverity 11 ilanın hepsi elendi.
    location: [j.location && (j.location.city || j.location.country), j.city, j.state, j.country,
      ...(Array.isArray(j.locations) ? j.locations.map(l => [l.city, l.region, l.country].filter(Boolean).join(', ')) : [])].filter(Boolean).join('; ') || null,
    datePosted: j.published_on || null,
    description: [j.description, j.requirements, j.benefits].filter(Boolean).join(' '),
    url: j.url || j.shortlink || j.application_url || null,
  }));
}

async function fetchSmartRecruitersJobs(token){
  // 01.10: Global şirketlerde (H&M binlerce ilan) ilk 100 ilan Avusturya'yı hiç içermeyebiliyordu → önce
  // country=at ile sayfalı çek (en fazla 500); hiç sonuç yoksa eskisi gibi filtresiz ilk 100.
  const page = async (q, offset)=>{ const r = await fetch(`https://api.smartrecruiters.com/v1/companies/${token}/postings?limit=100&offset=${offset}${q}`); if(!r.ok) throw new Error(`SmartRecruiters API ${r.status} (token "${token}" yanlış olabilir)`); return r.json(); };
  let content = [];
  for(let off = 0; off < 500; off += 100){ const d = await page('&country=at', off); const c = d.content || []; content.push(...c); if(c.length < 100) break; }
  if(!content.length) content = (await page('', 0)).content || [];
  const data = { content };
  const basics = (data.content || []).map(j => ({
    id: j.id || null,
    title: j.name || null,
    company: token,
    location: (j.location && [j.location.city, j.location.country].filter(Boolean).join(', ')) || null,
    datePosted: j.releasedDate || null,
    // SmartRecruiters kıdem seviyesini KENDİSİ yapılandırılmış bir alan olarak veriyor — bu,
    // diğer platformlardaki gibi başlıktan TAHMİN değil, şirketin kendi beyanı. Varsa
    // guessSeniority yerine bunu kullanıyoruz (runAtsPath içinde).
    experienceLevelRaw: (j.experienceLevel && `${j.experienceLevel.id || ''} ${j.experienceLevel.label || ''}`) || null,
    // DÜZELTME (Eren'in fark ettiği Deloitte'nin 54 ilanının 1'e düşmesi): liste uç noktası ilanın
    // KENDİ linkini hiç vermiyordu — url alanı hiç set edilmiyordu, bu yüzden runAtsPath'teki
    // `j.url || sourceUrl` düşüşü HER ilan için devreye giriyor, hepsine ilan panosunun genel
    // URL'i atanıyordu (54 farklı gerçek ilan, tek bir linkte toplanmış gibi görünüyordu —
    // sonradan eklediğimiz dedup mantığı bunları da yanlışlıkla TEK ilana indirgeyecekti).
    // SmartRecruiters'ın herkese açık ilan sayfası kararlı bir kalıp izliyor: jobs.smartrecruiters.com/
    // {şirket}/{ilanId} — slug kısmı olmadan bile bu ID'ye gidince doğru ilana yönleniyor.
    url: j.id ? `https://jobs.smartrecruiters.com/${token}/${j.id}` : null,
  }));

  // DÜZELTME (Eren'in Deloitte denemesinde fark ettiği eksiklik): liste uç noktası tam açıklamayı
  // taşımıyordu, eskiden bilerek boş bırakılıyordu ("performans için"). Ama onlyfy/BCG'de aynı
  // sorunu her ilanın KENDİ detay uç noktasını çekerek çözdük — SmartRecruiters'ın da dokümante
  // edilmiş bir detay endpoint'i var (/postings/{id}), aynı yaklaşımı burada da uyguluyoruz.
  // 75 ilan gibi büyük sayılarda bu biraz sürebilir (istek başına ~150ms bekleme var) — kabul
  // edilebilir bir bedel, doğru deg/de/en/exp/wm tahmini için.
  const enriched = [];
  for(const j of basics){
    let description = '';
    if(j.id){
      try{
        const dres = await fetch(`https://api.smartrecruiters.com/v1/companies/${token}/postings/${j.id}`, { signal: AbortSignal.timeout(8000) });
        if(dres.ok){
          const ddata = await dres.json();
          const sections = ddata.jobAd && ddata.jobAd.sections;
          if(sections){
            // sections genelde jobDescription/qualifications/additionalInformation gibi
            // alt-nesnelerden oluşuyor, her birinin içinde HTML taşıyan bir "text" alanı var.
            description = Object.values(sections).map(s => s && s.text).filter(Boolean).join(' ');
          }
        }
      }catch(e){ /* detay çekilemedi — açıklamasız devam, veri kaybetmiyoruz */ }
      await new Promise(r => setTimeout(r, 150));
    }
    enriched.push({ ...j, description });
  }
  return enriched;
}

// onlyfy'ın diğer 5 ATS'ten FARKI: belgelenmiş bir JSON API'si yok — ama widget'ın kendisi
// (tarayıcı JS'i hiç çalışmadan) düz, statik HTML döndüren bir "ajax_list" uç noktasıyla
// besleniyor. Eren'in DevTools Network sekmesinde bulduğu örnek (Magenta):
//   https://magenta.onlyfy.jobs/candidate/job/ajax_list?widgetConfig=y6lvdyzt&display_length=3&page=1&sort=matching&sort_dir=DESC&search=
// Sayfa başına sabit 3 ilan dönüyor (display_length parametresi göz ardı ediliyor gibi
// görünüyor) — o yüzden "page" değerini durana kadar artırıyoruz. Her ilan kendi detay
// sayfasında (…/job/{id}) TAM açıklamayı barındırıyor — o da statik HTML, ayrıca çekiyoruz.
// NOT: Bu, öteki 5 ATS gibi belgelenmiş/kararlı bir API değil, sayfanın kendi (yayınlanmamış)
// dahili uç noktası — onlyfy bunu değiştirirse (ör. sayfalama parametrelerini) burası da
// güncellenmesi gerekir. HTML yapısını TAHMİN ediyoruz (anchor + ardından şehir/tür/tarih satırı) —
// başka bir onlyfy sitesinde farklı çıkarsa (Eren'in başka elle-girilecek şirketlerinden biri
// onlyfy kullanıyorsa) burayı ona göre ayarlamak gerekebilir.
async function fetchOnlyfyJobs(subdomain, token){
  const origin = `https://${subdomain}.onlyfy.jobs`;
  const seen = new Set();
  const basics = []; // { title, url, id, location, employmentType, datePosted }
  const MAX_PAGES = 25; // güvenlik sınırı — sonsuz döngüye girmesin

  for(let page = 1; page <= MAX_PAGES; page++){
    const listUrl = `${origin}/candidate/job/ajax_list?widgetConfig=${encodeURIComponent(token)}&display_length=3&page=${page}&sort=matching&sort_dir=DESC&search=`;
    const res = await fetch(listUrl, { signal: AbortSignal.timeout(10000) });
    if(!res.ok) break;
    const html = await res.text();

    // Bu sayfadaki ilan anchor'larını (href + görünen başlık) bul. href'in kendisi
    // ".../job/{id}?..." formunda — id'yi ayrıca çıkarıyoruz (detay sayfası isteği için).
    const anchorRe = /<a[^>]+href="([^"]*\/job\/([a-z0-9]+)[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    const matches = [...html.matchAll(anchorRe)];
    if(!matches.length) break; // "showing 0 of 0" gibi boş bir sayfaya ulaştık — bitti

    let newOnThisPage = 0;
    for(let i = 0; i < matches.length; i++){
      const m = matches[i];
      const id = m[2];
      const title = m[3].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if(seen.has(id) || !title) continue;
      seen.add(id);
      newOnThisPage++;

      // DÜZELTME: HTML'deki href değerleri GÖRELİ (relative) geliyor — "/candidate/widget/
      // y6lvdyzt/job/..." gibi, başında "https://magenta.onlyfy.jobs" yok. new URL(...) ile
      // origin'e göre TAM URL'ye çeviriyoruz; önceki sürüm bunu ham haliyle fetch()'e veriyordu,
      // node'un fetch()'i (tarayıcının aksine) göreli URL'leri otomatik tamamlamıyor, bu yüzden
      // "Failed to parse URL" hatası alınıyordu — 24/24 detay isteği bu yüzden başarısız oluyordu.
      const url = new URL(m[1].replace(/&amp;/g, '&'), origin).href;

      // Bu anchor'dan bir SONRAKİ anchor'a (ya da içerik sonuna) kadar olan ham HTML dilimini
      // al, etiketleri temizle — orada sırayla şehir / istihdam türü / tarih satırları olması
      // bekleniyor (web_fetch ile elle baktığımızda gördüğümüz sıra buydu).
      const sliceStart = m.index + m[0].length;
      const sliceEnd = matches[i+1] ? matches[i+1].index : html.length;
      const rawSlice = html.slice(sliceStart, sliceEnd);
      const lines = rawSlice.replace(/<[^>]+>/g, '\n').split('\n')
        .map(l => l.replace(/&amp;/g,'&').replace(/&nbsp;/g,' ').trim()).filter(Boolean);
      // TAHMİN: ilk satır şehir, ikincisi istihdam türü, üçüncüsü tarih. Doğrulanmalı —
      // onlyfy sıralamayı değiştirirse ya da ekstra bir alan eklerse bu kayar.
      const [location, employmentType, datePosted] = lines;

      basics.push({ title, url, id, location: location || null, employmentType: employmentType || null, datePosted: datePosted || null });
    }
    if(newOnThisPage === 0) break; // bu sayfada hiç yeni ilan yoksa (tekrar), sona geldik
  }

  // Her ilanın kendi detay sayfasını çek (tam açıklama için). Nazik olmak için art arda
  // istekler arasına küçük bir bekleme koyuyoruz — onlyfy'ı gereksiz yormamak için.
  const full = [];
  let detailFailures = 0;
  for(const b of basics){
    try{
      const res = await fetch(b.url, {
        signal: AbortSignal.timeout(10000),
        // DÜZELTME: node'un varsayılan fetch User-Agent'ı bazı CDN/WAF korumalarında
        // (Cloudflare vb.) şüpheli görünüp sessizce boş/hata sayfası döndürebiliyor —
        // sıradan bir tarayıcı gibi görünmek için gerçekçi bir User-Agent ekliyoruz.
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36' }
      });
      if(!res.ok){
        detailFailures++;
        console.log(`  ⚠️  Detay sayfası HTTP ${res.status} döndürdü: ${b.url}`);
        full.push({ title: b.title, company: subdomain, location: b.location, datePosted: b.datePosted, employmentType: b.employmentType, description: '', url: b.url });
        await new Promise(r => setTimeout(r, 200));
        continue;
      }
      const html = await res.text();
      if(html.length < 200){
        console.log(`  ⚠️  Detay sayfası beklenenden çok kısa döndü (${html.length} karakter): ${b.url}`);
      }
      full.push({
        title: b.title,
        company: subdomain,
        location: b.location,
        datePosted: b.datePosted,
        employmentType: b.employmentType,
        // guessRequirements zaten HTML'i kendi içinde düz metne indiriyor (summarize() ile aynı
        // yöntem) — ham HTML'i olduğu gibi geçiriyoruz, diğer ATS entegrasyonlarıyla tutarlı.
        description: html,
        url: b.url,
      });
    }catch(e){
      detailFailures++;
      console.log(`  ⚠️  Detay sayfası çekilemedi (${e.message}): ${b.url}`);
      // Detay sayfası çekilemezse ilanı YİNE DE dahil et (başlık+konum en azından var),
      // sadece açıklama boş kalır — hiç dahil etmemekten iyidir.
      full.push({ title: b.title, company: subdomain, location: b.location, datePosted: b.datePosted, employmentType: b.employmentType, description: '', url: b.url });
    }
    await new Promise(r => setTimeout(r, 200));
  }
  if(detailFailures){
    console.log(`  ℹ️  ${detailFailures}/${basics.length} ilanın detay sayfası çekilemedi ya da boş döndü — bunlar için deg/de/en/exp/wm tahmini yapılamadı (hepsi "estimated" kalacak).`);
  }
  return full;
}

// 19.10: ilanın şirketteki yayın günü → 'YYYY-MM-DD' (site "vor X Tagen veröffentlicht" ve 60 günlük ömür sınırı için).
// ISO / epoch / Workday "Posted 5 Days Ago" / "Posted 30+ Days Ago" / "vor 3 Tagen" kabul; makul aralık dışı → null.
function postedDay(v){
  if(v == null || v === '') return null;
  const now = Date.now(); let ms = null;
  if(typeof v === 'number') ms = v < 1e12 ? v * 1000 : v;
  else {
    const s = String(v).trim();
    const rel = s.match(/(?:posted\s+)?(\d+)\+?\s*(day|days|tag|tagen|tage)\b/i);
    if(/\b(today|heute)\b/i.test(s)) ms = now;
    else if(/\b(yesterday|gestern)\b/i.test(s)) ms = now - 86400000;
    else if(rel) ms = now - Number(rel[1]) * 86400000;
    else { const d = Date.parse(s); if(Number.isFinite(d)) ms = d; else { const m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/); if(m) ms = Date.UTC(+m[3], +m[2] - 1, +m[1]); } }
  }
  if(!Number.isFinite(ms) || ms > now + 86400000 || ms < now - 730 * 86400000) return null;
  return new Date(ms).toISOString().slice(0, 10);
}
async function fetchAtsJobs(ats){
  if(ats.type === 'workday') return fetchWorkdayJobs(ats);
  if(ats.type === 'greenhouse') return fetchGreenhouseJobs(ats.token, ats.apiHost);
  if(ats.type === 'lever') return fetchLeverJobs(ats.token, ats.eu);
  if(ats.type === 'recruitee') return fetchRecruiteeJobs(ats.token);
  if(ats.type === 'workable') return fetchWorkableJobs(ats.token);
  if(ats.type === 'personio') return fetchPersonioJobs(ats.token, ats.tld);
  if(ats.type === 'smartrecruiters') return fetchSmartRecruitersJobs(ats.token);
  if(ats.type === 'onlyfy') return fetchOnlyfyJobs(ats.subdomain, ats.token);
  if(ats.type === 'bamboohr') return fetchBambooJobs(ats);
  if(ats.type === 'bmw') return fetchBmwJobs(ats);
  if(ats.type === 'bain') return fetchBainJobs(ats);
  if(ats.type === 'mckinsey') return fetchMcKinseyJobs(ats);
  if(ats.type === 'schoenherr') return fetchSchoenherrJobs(ats);
  if(ats.type === 'mediamarkt') return fetchMediaMarktJobs(ats);
  if(ats.type === 'hofer') return fetchHoferJobs(ats);
  if(ats.type === 'spar') return fetchSparJobs(ats);
  if(ats.type === 'dm') return fetchDmJobs(ats);
  if(ats.type === 'austrian') return fetchAustrianJobs(ats);
  if(ats.type === 'avature') return fetchAvatureJobs(ats);
  if(ats.type === 'rolandberger') return fetchRolandBergerJobs(ats);
  if(ats.type === 'yello') return fetchYelloJobs(ats);
  if(ats.type === 'henkel') return fetchHenkelJobs(ats);
  if(ats.type === 'successfactors') return fetchSuccessFactorsJobs(ats);
  if(ats.type === 'microsoft') return fetchMicrosoftJobs(ats);
  if(ats.type === 'strabag') return fetchStrabagJobs(ats);
  if(ats.type === 'sagedpw') return fetchSagedpwJobs(ats);
  if(ats.type === 'horvath') return fetchHorvathJobs(ats);
  if(ats.type === 'binder') return fetchBinderJobs(ats);
  return [];
}

// McKinsey & Company — liste cevabı zaten tam açıklamayı taşıyor, tek istek yeterli (sayfalama
// için start/pageSize ile). "numFound" toplam sonucu söylüyor, ona göre durup gereksiz istek
// atmıyoruz.
async function fetchMcKinseyJobs(ats){
  const { origin, basePath, cities, lang } = ats;
  const PAGE_SIZE = 50; // DevTools'ta 20 görülmüştü, daha büyük deneyip API'nin kabul edip
                         // etmediğine bakıyoruz — kabul etmezse zaten döngü numFound'a göre
                         // doğru sayıda istek atmaya devam eder, veri kaybı olmaz.
  const all = [];
  let start = 1;
  let numFound = null;
  for(let page = 0; page < 15; page++){
    const url = `${origin}${basePath}?pageSize=${PAGE_SIZE}&start=${start}&cities=${encodeURIComponent(cities)}&lang=${encodeURIComponent(lang)}`;
    let data;
    try{
      // DÜZELTME (22-24 Eylül'de 3 gün üst üste 0 sonuç): bu istekte User-Agent header'ı hiç
      // yoktu — bazı WAF/bot korumaları header'sız isteği otomatik reddediyor. Diğer entegrasyonlarda
      // (BMW gibi) zaten kullanılan tarayıcı User-Agent'ı buraya da eklendi. Ayrıca hata artık
      // sessizce yutulmuyor, console.log ile gerçek sebep (HTTP kodu/istisna mesajı) yazdırılıyor —
      // bir sonraki sessiz "0 sonuç" durumunda results dosyasındaki log'dan sebep görülebilsin diye.
      const res = await fetch(url, {
        signal: AbortSignal.timeout(10000),
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36', Accept: 'application/json', Origin: 'https://www.mckinsey.com', Referer: 'https://www.mckinsey.com/careers/search-jobs' } // 02.10: API gateway.mckinsey.com'a taşındı
      });
      if(!res.ok){
        console.log(`  ⚠️  McKinsey API HTTP ${res.status} döndürdü (sayfa ${page}): ${url}`);
        return page === 0 ? null : all;
      }
      data = await res.json();
    }catch(e){
      console.log(`  ⚠️  McKinsey API isteği başarısız (sayfa ${page}): ${e.message}`);
      return page === 0 ? null : all;
    }

    if(numFound === null) numFound = data.numFound || 0;
    const docs = Array.isArray(data.docs) ? data.docs : [];
    if(!docs.length) break;
    all.push(...docs);
    start += docs.length;
    if(all.length >= numFound) break;
  }
  if(!all.length) return null;
  return all.map(j => ({
    title: j.title || null,
    company: 'McKinsey & Company',
    // cities zaten "cities=Vienna" ile filtrelenmiş geliyor ama diğer entegrasyonlarla tutarlı
    // olsun ve buildCityRegex her zaman doğru eşleşsin diye tüm diziyi birleştirip location
    // yapıyoruz (Bain'de yaptığımızla aynı yaklaşım).
    location: Array.isArray(j.cities) ? j.cities.join(', ') : (j.cities || null),
    datePosted: j.postedToLinkedInDate || null,
    description: [j.whoYouWillWorkWith, j.whatYouWillDo, j.yourBackground].filter(Boolean).join(' '),
    url: j.jobApplyURL || null,
  }));
}

// Schönherr Rechtsanwälte — kendi sitesindeki Umbraco CMS "JobFiltersSurface/GetJobList" uç
// noktası. JSON DEĞİL, sunucu-taraflı render edilmiş HTML fragmanı dönüyor (Eren'in Network
// sekmesinde bulduğu ham cevap): her ilan bir "job-a-cta" bloğu, içinde başlık (<h3><a>...</a></h3>,
// href zaten onlyfy'daki gerçek ilan sayfası), konum ("Austria| Vienna" gibi ülke|şehir biçiminde,
// ayraçtan sonraki kısmı alıyoruz), ve iki "editor-output" paragrafı (birincisi departman, ikincisi
// istihdam türü — sıraları TÜM örneklerde tutarlıydı, ama garanti değil, o yüzden ikisini de
// "departmentNames" olarak birleştirip mapDepartmentToNiche'e bırakıyoruz, tekini kaçırırsak diğeri
// yine de niche tahminine yardımcı olur). Açıklama/gereksinim metni YOK — onlyfy'ın SPA'sı içeriği
// sayfa yüklendikten SONRA ayrı bir (henüz bulunamamış) API çağrısıyla dolduruyor, bu uç nokta ondan
// bağımsız. description boş bırakılıyor, guessRequirements zaten boş girdide her şeyi "estimated"
// işaretliyor — hiç ilan vermemekten iyi, en azından gerçek başlık+konum+departman+doğru link var.
function parseSchoenherrJobCards(html){
  const out = [];
  const blockRe = /<div class="job-a-cta[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/g;
  let block;
  while((block = blockRe.exec(html))){
    const chunk = block[1];
    const titleMatch = chunk.match(/<h3[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if(!titleMatch) continue;
    const url = titleMatch[1].trim();
    const title = decodeHtmlEntities(titleMatch[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
    // Konum: "sr-only">location</span> etiketinden SONRA, bir sonraki etiketten ÖNCE gelen düz
    // metin — "Austria| Vienna" gibi. "|" varsa sonrasını (gerçek şehir) alıyoruz, yoksa olduğu gibi.
    const locMatch = chunk.match(/sr-only">location<\/span>\s*<\/span>\s*([^<]+)</i);
    const locRaw = locMatch ? locMatch[1].trim() : '';
    const location = locRaw.includes('|') ? locRaw.split('|').pop().trim() : (locRaw || null);
    // "editor-output" paragrafları — sırayla departman, istihdam türü.
    const paras = [...chunk.matchAll(/<div class="editor-output">\s*<p>\s*([\s\S]*?)\s*<\/p>/gi)]
      .map(m => decodeHtmlEntities(m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()))
      .filter(Boolean);
    const department = paras[0] || null;
    const employmentType = paras[1] || null;
    out.push({ title, url, location, department, employmentType });
  }
  return out;
}
async function fetchSchoenherrJobs(ats){
  const { origin, search } = ats;
  const url = `${origin}/umbraco/surface/JobFiltersSurface/GetJobList${search || ''}`;
  let html;
  try{
    const res = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36' }
    });
    if(!res.ok){
      console.log(`  ⚠️  Schönherr GetJobList HTTP ${res.status} döndürdü: ${url}`);
      return null;
    }
    html = await res.text();
  }catch(e){
    console.log(`  ⚠️  Schönherr GetJobList isteği başarısız: ${e.message}`);
    return null;
  }
  const cards = parseSchoenherrJobCards(html);
  if(!cards.length){
    console.log(`  ⚠️  Schönherr GetJobList 200 döndü ama hiç ilan kartı bulunamadı (sayfa yapısı değişmiş olabilir).`);
    return null;
  }

  // DÜZELTME (Eren'in bulduğu gerçek endpoint): onlyfy'ın normal /job/{id} sayfası içeriği
  // client-side JS ile dolduruyordu ("All jobsEN" boş kalıyordu — bkz. yukarıdaki uzun not), ama
  // Eren DevTools'ta asıl İÇERİĞİ sunucu-taraflı döndüren gerçek uç noktayı buldu:
  // /job/show/{id}/full?lang=en&mode=candidate — id, normal /job/{id} linkindeki AYNI id (test
  // edildi, ayrı bir eşleme adımı gerekmiyor). Artık her ilan için bunu da çekip tam açıklamayı
  // (Das erwartet Sie / Sie zeichnet aus / Das bieten wir Ihnen) alıyoruz — Schönherr'in deg/de/en/
  // exp/wm alanlarının HEPSİ "estimated" kalma zorunluluğu artık yok.
  // DÜZELTME (kendi hatam — çıktıda evidence hep boş çıkıyordu): detay içeriği "www.schoenherr.eu"
  // (Umbraco'nun origin'i, yukarıdaki "origin" değişkeni) üzerinde DEĞİL, "schoenherr.onlyfy.jobs"
  // üzerinde yaşıyor — ikisi FARKLI alan adı. Yanlışlıkla Umbraco'nun origin'ini kullanmışım, istek
  // sessizce 404/boş dönüp catch'e düşüyordu. Doğru origin'i her kartın kendi onlyfy linkinden
  // (c.url) çıkarıyoruz.
  const enriched = [];
  for(const c of cards){
    let description = '';
    const idMatch = (c.url || '').match(/\/job\/([^\/?]+)/);
    const onlyfyOrigin = (() => { try{ return new URL(c.url).origin; }catch(e){ return null; } })();
    if(idMatch && onlyfyOrigin){
      try{
        const res = await fetch(`${onlyfyOrigin}/job/show/${idMatch[1]}/full?lang=en&mode=candidate`, {
          signal: AbortSignal.timeout(10000),
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36' }
        });
        if(res.ok){
          const detailHtml = await res.text();
          const cleanedHtml = detailHtml
            .replace(/<script[\s\S]*?<\/script>/gi, ' ')
            .replace(/<style[\s\S]*?<\/style>/gi, ' ')
            .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
          description = decodeHtmlEntities(cleanedHtml).replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
        }
      }catch(e){ /* detay çekilemedi — açıklamasız devam, hiç veri kaybetmeden */ }
      await new Promise(r => setTimeout(r, 200)); // nezaket: art arda hızlı istek atmayalım
    }
    enriched.push({ ...c, description });
  }

  return enriched.map(c => ({
    title: c.title,
    company: 'Schönherr Rechtsanwälte',
    location: c.location,
    description: c.description || '',
    url: c.url,
    departmentNames: c.department ? [c.department] : [],
    employmentTypeRaw: c.employmentType || null,
  }));
}

// MediaMarkt Austria — Eren'in DevTools Network'te bulduğu gerçek istek: Azure Cognitive Search
// üzerinden POST /indexes/mms-prod/docs/search, "api-key" header'ıyla (salt-okunur "query key",
// sitenin kendi ön-yüzü de bunu tarayıcıda açıkça kullanıyor). Cevap zaten TAM açıklamayı HTML
// olarak taşıyor (tasks/profile/description alanları) — ayrı bir detay sayfası çekmeye gerek yok,
// tek istek (birkaç sayfa halinde, "skip" ile) yeterli. "mms-prod" index'i birden fazla marka/ülke
// karışık tutuyor gibi göründüğü için Azure'un kendi filtresine ("brand eq ...") ek olarak, diğer
// tüm entegrasyonlarla tutarlı şekilde şehir eşleştirmesini de KENDİ tarafımızda (addresses[].city
// üzerinden) tekrar uyguluyoruz — API'nin filtresine körü körüne güvenmiyoruz.
const MEDIAMARKT_SEARCH_URL = 'https://searchui.search.windows.net/indexes/mms-prod/docs/search?api-version=2020-06-30';
const MEDIAMARKT_API_KEY = '6BBD74F1CBD41E5B0232FB05C5B78ED9';
function stripHtmlToPlainText(raw){
  if(!raw) return '';
  return decodeHtmlEntities(raw)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|li|br|tr|h[1-6])\s*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*/g, '\n')
    .trim();
}
async function fetchMediaMarktJobs(ats){
  const brand = ats.brand || 'MediaMarktAT';
  const PAGE_SIZE = 50;
  const all = [];
  // DÜZELTME (ilk denemede boş döndü): "brand eq '...'" filtresi muhtemelen Azure index'inde
  // filtrelenebilir (filterable) olarak işaretlenmemiş bir alan — bu durumda Azure 400 Bad Request
  // döndürür, biz de bunu "bu site değil" sanıp sessizce null'a düşüyorduk. Bunun yerine Eren'in
  // DevTools'ta yakaladığı GERÇEK, çalıştığı KANITLANMIŞ filtre alanlarını (language + addresses
  // içindeki country) kullanıyoruz — marka (brand) filtresini API'ye sormak yerine, cevap geldikten
  // SONRA kendi tarafımızda (JS'te) uyguluyoruz. Şehir filtresi zaten runAtsPath'te ayrıca (location
  // alanına göre) uygulanıyor, burada tekrar etmiyoruz.
  for(let page = 0; page < 12; page++){
    let data;
    try{
      const res = await fetch(MEDIAMARKT_SEARCH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': MEDIAMARKT_API_KEY },
        body: JSON.stringify({
          search: '*',
          filter: `language eq 'de_DE' and (addresses/any(jt: jt/country eq 'AUT'))`,
          top: PAGE_SIZE,
          skip: page * PAGE_SIZE,
        }),
        signal: AbortSignal.timeout(10000),
      });
      if(!res.ok){
        // Teşhis için: sessizce null'a düşmeden önce durumu görelim (sadece bu entegrasyona özgü,
        // başka hiçbir siteyi etkilemiyor).
        const bodyText = await res.text().catch(() => '');
        console.log(`  [teşhis] MediaMarkt Azure Search isteği başarısız: HTTP ${res.status} — ${bodyText.slice(0, 300)}`);
        return page === 0 ? null : all;
      }
      data = await res.json();
    }catch(e){ return page === 0 ? null : all; }
    const batch = Array.isArray(data.value) ? data.value : [];
    if(!batch.length) break;
    all.push(...batch);
    const total = data['@odata.count'];
    if(typeof total === 'number' && all.length >= total) break;
  }
  const brandFiltered = all.filter(j => !j.brand || j.brand === brand);
  if(!brandFiltered.length) return null;

  return brandFiltered.map(j => {
    const addr = Array.isArray(j.addresses) && j.addresses.length ? j.addresses[0] : null;
    const location = addr ? [addr.city, addr.country].filter(Boolean).join(', ') : null;
    // Açıklama üç parçaya bölünmüş geliyor (tasks/profile/description) — description zaten
    // hepsini içeriyor gibi görünüyor ama garantiye almak için tasks+profile'ı da ekleyip
    // birleştiriyoruz, en azından hiç veri kaybetmemek için.
    const rawDescription = [j.tasks, j.profile, j.description].filter(Boolean).join(' ') || j.description || '';
    return {
      title: j.title || null,
      company: 'MediaMarkt Austria',
      location,
      description: stripHtmlToPlainText(rawDescription),
      url: j.link || null,
      departmentNames: [j.category, j.businessArea].filter(Boolean),
    };
  });
}

// =====================================================================================
// 30.09: HOFER + SPAR (büyük market zincirleri). İkisinin de liste sayfası JS ile yükleniyor, genel
// crawler sadece ilk 4-7 linki görüyordu (HOFER 974, SPAR 1.505 ilandan 2'şer tane geliyordu).
// Sitelerin kendi ön yüzlerinin çağırdığı JSON uç noktalarını kullanıyoruz:
//   HOFER: GET https://karriere.hofer.at/rest/jobs/search  (tek istekte tüm ilanlar)
//   SPAR : GET https://bfs.spar-ics.com/fact-finder/rest/v5/search/jobs_at?query=*&page=N&hitsPerPage=500
// Mağaza işleri (aynı ilan yüzlerce filialde) "rol + eyalet" başına TEK ilana gruplanıyor
// (ör. "Verkäufer Feinkost – 23 Filialen in der Steiermark"); ofis/IT/SCM/Trainee/Praktikum ilanları
// tek tek alınıyor. Lehrling (çırak) ilanları ve Initiativbewerbung alınmıyor.
// =====================================================================================
const RETAIL_UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36', 'Accept': 'application/json, text/html' };
const BL_CODES = { W: 'Wien', NOE: 'Niederösterreich', OOE: 'Oberösterreich', STKM: 'Steiermark', K: 'Kärnten', S: 'Salzburg', T: 'Tirol', V: 'Vorarlberg', B: 'Burgenland' };
// Posta kodundan eyalet (yaklaşık — sınır bölgelerinde birkaç istisna var, konum listesi ayrıca şehir adlarını taşıyor).
function bundeslandFromZip(zip){
  const z = parseInt(String(zip || '').trim(), 10);
  if(!z || z < 1000 || z > 9999) return null;
  if(z < 2000) return 'Wien';
  if(z < 4000) return (z >= 2421 && z <= 2491) ? 'Burgenland' : 'Niederösterreich';
  if(z < 5000) return 'Oberösterreich';
  if(z < 6000) return ((z >= 5120 && z <= 5145) || (z >= 5230 && z <= 5283)) ? 'Oberösterreich' : 'Salzburg'; // Braunau/Mattighofen bölgesi OÖ
  if(z < 7000) return z >= 6700 ? 'Vorarlberg' : 'Tirol';
  if(z < 8000) return 'Burgenland';
  if(z < 9000) return 'Steiermark';
  return z >= 9900 ? 'Tirol' : 'Kärnten';
}
const BL_PREP = { 'Steiermark': 'in der Steiermark', 'Wien': 'in Wien' };
const blIn = bl => BL_PREP[bl] || `in ${bl}`;
// Bir grup ilanı → tek Whittle ilanı. rep = temsilci ilan (link + metin), members = gruptaki tüm ilanlar.
function retailGroupItem({ company, role, bl, members, rep, repText, types }){
  const cityCount = new Map();
  members.forEach(m => { if(m.city) cityCount.set(m.city, (cityCount.get(m.city) || 0) + 1); });
  const cities = [...cityCount.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
  const top = cities.slice(0, 6);
  const n = members.length;
  // "Teilzeit für 12-24 Stunden/Woche", "12-21 h", "Vollzeit/Teilzeit" … → "Teilzeit, Vollzeit (8–38,5 Std./Woche)"
  const base = new Set(); let lo = Infinity, hi = 0;
  (types || []).forEach(t => {
    const s = String(t);
    (s.match(/vollzeit|teilzeit|geringfügig/gi) || []).forEach(x => base.add(x[0].toUpperCase() + x.slice(1).toLowerCase()));
    (s.match(/\d+(?:,\d+)?/g) || []).map(v => parseFloat(v.replace(',', '.'))).filter(v => v > 0 && v <= 45).forEach(v => { lo = Math.min(lo, v); hi = Math.max(hi, v); });
  });
  if(!base.size && hi) base.add(hi >= 38 ? 'Vollzeit' : 'Teilzeit');
  const hrs = hi ? ` (${lo === hi ? lo : `${lo}–${hi}`} Std./Woche)`.replace(/(\d)\.(\d)/g, '$1,$2') : '';
  const typeLine = base.size ? `Beschäftigungsausmaß: ${[...base].join(', ')}${hrs}.` : '';
  const head = `${n > 1 ? `Offene Stellen in ${n} Filialen ${blIn(bl)}` : `Offene Stelle ${blIn(bl)}`}: ${cities.slice(0, 25).join(', ')}${cities.length > 25 ? ` und ${cities.length - 25} weitere Orte` : ''}. ${typeLine}`;
  return {
    title: `${role}${/\(m\/w\/d\)/.test(role) ? '' : ' (m/w/d)'}`,
    company,
    location: [...top, bl].filter((x, i, a) => a.indexOf(x) === i).join(' | '),
    datePosted: rep.date || null,
    description: `${head}\n\n${repText || ''}`,
    url: rep.url,
    departmentNames: rep.dept ? [rep.dept] : [],
  };
}
async function fetchJsonLdText(url){
  try{
    const res = await fetch(url, { headers: { ...RETAIL_UA, Accept: 'text/html' }, signal: AbortSignal.timeout(12000) });
    if(!res.ok) return '';
    const html = await res.text();
    const jp = findJobPostings(extractJsonLd(html))[0];
    if(jp && jp.description) return stripHtmlToPlainText(String(jp.description));
    const main = (html.match(/<main[\s\S]*?<\/main>/i) || [html])[0];
    return stripHtmlToPlainText(main).slice(0, 6000);
  }catch(e){ return ''; }
}
const isLehre = t => /lehrling|lehrstelle|\blehre\b|apprentice/i.test(t || '');


// 04.10: Avature kariyer siteleri. Liste: .../SearchJobs[?filtre] (sayfalama &jobOffset=N), ilan linkleri .../JobDetail/<slug>/<id>.
// Detay: alanlar "article__content__view__field__value" bloklarında; yoksa JSON-LD, o da yoksa GDPR/çerez metni atılmış <main>.
async function fetchAvatureJobs(ats){
  const u = new URL(ats.url);
  if(!/SearchJobs/i.test(u.pathname)) u.pathname = u.pathname.replace(/\/$/, '') + '/SearchJobs';
  // 05.10: Frequentis varsayılan listede sadece 4 öne çıkan ilan gösteriyordu (önceki tarama 42) → liste modu + sayfa başına 100.
  if(!u.searchParams.has('listFilterMode')) u.searchParams.set('listFilterMode', '1');
  const per = 100; u.searchParams.set('jobRecordsPerPage', String(per));
  const seen = new Map();
  // 07.10: UniCredit jobRecordsPerPage=100'ü yok sayıp 15 döndürüyor; offset 100 artınca 15–99 arası atlanıyordu (41 → 13).
  // Offset artık sayfada gerçekten gelen ilan sayısı kadar ilerliyor.
  for(let off = 0, page = 0; page < 20; page++){
    // 15.10: Siemens sayfalamayı jobOffset değil folderOffset ile yapıyor (sayfa başı sabit 6) — ikisi birden gönderiliyor.
    const pu = new URL(u); if(off){ pu.searchParams.set('jobOffset', String(off)); pu.searchParams.set('folderOffset', String(off)); }
    let html; try{ const r = await fetch(pu.toString(), { headers: { ...RETAIL_UA, Accept: 'text/html' }, signal: AbortSignal.timeout(20000) }); if(!r.ok){ console.log(`  ⚠️  Avature HTTP ${r.status} (${pu.hostname}, offset ${off})`); break; } html = await r.text(); }catch(e){ console.log(`  ⚠️  Avature: ${e.message}`); break; }
    const onPage = new Set([...html.matchAll(/href="([^"]*\/JobDetail\/[^"]+)"/gi)].map(x => x[1].split('?')[0])).size;
    // 07.10: L'Oréal 06.10'dan beri 0 — listFilterMode/jobRecordsPerPage=100 eklenmesiyle aynı gün. İlk sayfa boşsa
    // bir kez config'teki orijinal URL ile deneniyor.
    if(!onPage && !off && !u._retried && pu.toString() !== ats.url){ u._retried = true; console.log('  ↪︎ Avature: parametresiz orijinal URL deneniyor'); const o = new URL(ats.url); if(!/SearchJobs/i.test(o.pathname)) o.pathname = o.pathname.replace(/\/$/, '') + '/SearchJobs'; u.search = o.search; u.pathname = o.pathname; page--; continue; }
    if(!onPage && !off) console.log(`  [teşhis] Avature sayfasında JobDetail linki yok (${html.length} bayt${/captcha|cloudflare|access denied/i.test(html) ? ', bot koruması olabilir' : ''}).`);
    const before = seen.size, re = /<a\b[^>]*href="([^"]*\/JobDetail\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi; let m;
    while((m = re.exec(html))){
      const href = m[1].replace(/&amp;/g, '&'), abs = href.startsWith('http') ? href : u.origin + href;
      const title = decodeHtmlEntities(stripHtmlToPlainText(m[2])).trim();
      if(!title || title.length < 4 || /^(mehr|more|learn more|details|apply|bewerben)/i.test(title)) continue;
      const key = abs.split('?')[0];
      if(!seen.has(key)){ const tail = html.slice(m.index, m.index + 1500); const lm = tail.match(/class="[^"]*(?:location|Location)[^"]*"[^>]*>([\s\S]*?)<\/(?:span|div|p)>/); seen.set(key, { title, url: key, location: lm ? decodeHtmlEntities(stripHtmlToPlainText(lm[1])).trim() : '' }); }
    }
    if(seen.size === before || !onPage) break;
    off += onPage;
    await sleep2(300);
  }
  if(!seen.size) return null;
  const BOILER = /this portal protects your privacy[\s\S]*?(?=\n\n|$)|dieses portal schützt[\s\S]*?(?=\n\n|$)|we use cookies[\s\S]*?(?=\n\n|$)|wir verwenden cookies[\s\S]*?(?=\n\n|$)/gi;
  const out = [];
  for(const it of seen.values()){
    let description = '', location = it.location;
    try{
      const r = await fetch(it.url, { headers: { ...RETAIL_UA, Accept: 'text/html' }, signal: AbortSignal.timeout(15000) });
      if(r.ok){
        const h = await r.text();
        // 15.10: değer bloklarında iç içe <div> var (Siemens) — ilk </div>'de kesilince açıklama yarıda kalıyordu → dengeli eşleşme.
        const vals = [...h.matchAll(/<div\b[^>]*class="[^"]*article__content__view__field__value[^"]*"[^>]*>/g)].map(x => stripHtmlToPlainText(balancedInner(h, x.index)).trim()).filter(x => x.length > 2);
        description = vals.join('\n');
        if(description.length < 300){ const jp = findJobPostings(extractJsonLd(h))[0]; if(jp && jp.description) description = stripHtmlToPlainText(String(jp.description)); }
        if(description.length < 300) description = stripHtmlToPlainText((h.match(/<main[\s\S]*?<\/main>/i) || [h])[0]).replace(BOILER, '').trim();
        // 15.10: Siemens — "Location(s)" etiketi + değer bloğu (etiketsiz genel regex dil seçicisinden "English" yakalıyordu).
        if(!location){ const lm = h.match(/field__label[^>]*>\s*(?:Location\(s\)|Locations?|Standorte?|Arbeitsort)\s*<\/div>\s*<div\b[^>]*field__value[^>]*>([\s\S]{0,4000}?)<\/div>/i); if(lm){ const v = stripHtmlToPlainText(lm[1]).replace(/^•\s*/, '').replace(/\s+/g, ' ').trim(); if(v.length > 2) location = v; } }
        if(!location){ const lm = h.match(/(?:Standort|Location|Ort|Arbeitsort)\s*<\/[^>]+>\s*<[^>]+>\s*([^<]{2,80})</i); if(lm) location = decodeHtmlEntities(lm[1]).trim(); }
        if(!location){ const tm = (it.title + ' ' + description.slice(0, 3000)).match(/\b(Wien|Vienna|Graz|Linz|Salzburg|Innsbruck|Klagenfurt)\b/); if(tm) location = tm[1] + ', Österreich'; }
        // Frequentis başlıkları lokasyon koduyla başlıyor (VIE-…); UniCredit/L'Oréal listeleri URL'de zaten Avusturya'ya süzülü.
        if(!location && /^VIE\b/.test(it.title)) location = 'Wien, Österreich';
        if(!location && /(careers\.unicredit\.eu|careers\.loreal\.com)$/.test(u.hostname)) location = 'Österreich';
      }
    }catch(e){}
    out.push({ title: it.title, company: null, location: location || null, datePosted: null, description: description.slice(0, 9000), url: it.url, departmentNames: [] });
    await sleep2(200);
  }
  const short = out.filter(x => x.description.length < 300).length;
  console.log(`  Avature: ${out.length} ilan (${short} tanesinde metin kısa).`);
  return out;
}

// 02.10: SuccessFactors (RMK) — liste: <a class="jobTitle-link" href="/job/…/123/">, konum: <span class="jobLocation">.
// Detay: <span class="jobdescription"> ya da itemprop="description"; yoksa JSON-LD / <main>. Bir şey bulamazsa null →
// çağıran eski tarayıcı taramasına düşüyor (hiçbir şirket kaybedilmiyor).
// Açılış etiketinden başlayıp aynı türdeki iç içe etiketleri sayarak eşleşen kapanışa kadar olan iç HTML'i döner.
function balancedInner(html, start){
  const open = html.slice(start).match(/^<([a-z0-9]+)/i); if(!open) return '';
  const tag = open[1].toLowerCase(), re = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
  re.lastIndex = start; let depth = 0, m, innerStart = -1;
  while((m = re.exec(html))){
    if(m[1]) { depth--; if(depth === 0) return html.slice(innerStart, m.index); }
    else if(!/\/>$/.test(m[0])) { depth++; if(innerStart < 0) innerStart = m.index + m[0].length; }
    if(re.lastIndex - start > 200000) break;
  }
  return innerStart > 0 ? html.slice(innerStart, innerStart + 20000) : '';
}
// 05.10: BambooHR. Liste: GET /careers/list → {result:[{id, jobOpeningName, location:{city,state}, atsLocation:{city,country}}]}.
// Detay: GET /careers/{id}/detail → {result:{jobOpening:{description (HTML), ...}}}. Boş/başarısızsa null → genel tarama.
async function fetchBambooJobs(ats){
  const origin = `https://${ats.sub}.bamboohr.com`;
  let list;
  try{ const r = await fetch(`${origin}/careers/list`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20000) }); if(!r.ok){ console.log(`  ⚠️  BambooHR HTTP ${r.status}`); return null; } list = (await r.json()).result || []; }
  catch(e){ console.log(`  ⚠️  BambooHR: ${e.message}`); return null; }
  const loc = o => o ? [o.city, o.state, o.country].filter(x => typeof x === 'string' && x).join(', ') : '';
  const out = [];
  for(const j of list){
    let description = '', location = loc(j.atsLocation) || loc(j.location);
    try{
      const r = await fetch(`${origin}/careers/${j.id}/detail`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
      if(r.ok){ const d = ((await r.json()).result || {}).jobOpening || {}; description = stripHtmlToPlainText(String(d.description || '')); location = location || loc(d.atsLocation) || loc(d.location); }
    }catch(e){}
    out.push({ title: j.jobOpeningName || null, company: null, location: location || null, datePosted: j.datePosted || null, description: description.slice(0, 9000), url: `${origin}/careers/${j.id}`, departmentNames: [].concat(j.departmentLabel || []) });
    await sleep2(200);
  }
  console.log(`  BambooHR: ${out.length} ilan.`);
  return out.length ? out : null;
}

async function fetchSuccessFactorsJobs(ats){
  const seen = new Map();
  for(let start = 0, page = 0; page < 30; start += 25, page++){
    const url = ats.search ? ats.search + (ats.search.includes('?') ? '&' : '?') + 'startrow=' + start : ats.base + (start ? `${start}/` : '') + '?q=&sortColumn=referencedate&sortDirection=desc';
    let html;
    try{ const r = await fetch(url, { headers: { ...RETAIL_UA, Accept: 'text/html' }, signal: AbortSignal.timeout(20000) }); if(!r.ok){ console.log(`  ⚠️  SuccessFactors HTTP ${r.status}: ${url}`); break; } html = await r.text(); }
    catch(e){ console.log(`  ⚠️  SuccessFactors: ${e.message}`); break; }
    const before = seen.size;
    const rowRe = /<a[^>]+href="([^"]*\/job\/[^"]+)"[^>]*class="[^"]*jobTitle-link[^"]*"[^>]*>([\s\S]*?)<\/a>|<a[^>]+class="[^"]*jobTitle-link[^"]*"[^>]*href="([^"]*\/job\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    while((m = rowRe.exec(html))){
      const href = (m[1] || m[3]).replace(/&amp;/g, '&'), title = decodeHtmlEntities(stripHtmlToPlainText(m[2] || m[4])).trim();
      const abs = href.startsWith('http') ? href : ats.origin + href;
      if(!title || seen.has(abs)) continue;
      // 03.10: RBI'de konum "jobLocation"da değil → birkaç bilinen RMK sınıfı deneniyor.
      const tail = html.slice(m.index, m.index + 2500), lm = tail.match(/class="[^"]*(?:jobLocation|jobFacility|colLocation|jobGeoLocation)[^"]*"[^>]*>([\s\S]*?)<\/(?:span|td|div)>/) || tail.match(/data-careersite-propertyid="(?:location|city)"[^>]*>([\s\S]*?)<\/(?:span|td|div)>/);
      // 06.10: RBI'de "jobFacility" bölüm adı ("Corporate und Investment Banking"), Uni Wien'de fakülte adı veriyordu → konum gibi
      // görünmeyen değer atılıyor, aşağıda detay sayfası / metinden konum aranıyor.
      let locTxt = lm ? decodeHtmlEntities(stripHtmlToPlainText(lm[1])).trim() : '';
      if (locTxt && !/,|\b(AT|AUT|DE|CH)\b|wien|vienna|graz|linz|salzburg|innsbruck|klagenfurt|österreich|austria|remote/i.test(locTxt)) locTxt = '';
      seen.set(abs, { title, url: abs, location: locTxt });
    }
    if(seen.size === before) break;           // yeni ilan yok → son sayfa
    const total = Number((html.match(/paginationLabel[\s\S]{0,200}?<b>\s*(\d+)\s*<\/b>/) || [])[1] || 0);
    if(total && seen.size >= total) break;
    await sleep2(250);
  }
  if(!seen.size){ console.log('  SuccessFactors: liste sayfasında ilan linki bulunamadı — tarayıcı taramasına düşülüyor.'); return null; }
  const out = [];
  for(const it of seen.values()){
    let description = '', location = it.location;
    try{
      const r = await fetch(it.url, { headers: { ...RETAIL_UA, Accept: 'text/html' }, signal: AbortSignal.timeout(15000) });
      if(r.ok){
        const html = await r.text();
        // 03.10: Post'ta 211 ilanın metni sadece "Das sind wir" geldi — eski regex iç içe <span>'lerde ilk kapanışta
        // duruyordu. Artık etiket derinliği sayılarak tüm blok alınıyor ve adaylar arasından en uzunu seçiliyor.
        // Öncelik sırası: jobdescription → itemprop → JSON-LD → jobDisplay → <main>; 300+ karakterli ilk aday, yoksa en uzunu.
        const cands = [], blk = re => { const mm = re.exec(html); return mm ? stripHtmlToPlainText(balancedInner(html, mm.index)) : ''; };
        cands.push(blk(/<span[^>]+class="[^"]*jobdescription[^"]*"[^>]*>/i), blk(/<(?:span|div)[^>]+itemprop="description"[^>]*>/i));
        { const jp = findJobPostings(extractJsonLd(html))[0]; cands.push(jp && jp.description ? stripHtmlToPlainText(String(jp.description)) : ''); }
        cands.push(blk(/<div[^>]+class="[^"]*jobDisplay[^"]*"[^>]*>/i), stripHtmlToPlainText((html.match(/<main[\s\S]*?<\/main>/i) || [''])[0]));
        description = cands.find(x => x.length >= 300) || cands.sort((a, b) => b.length - a.length)[0] || '';
        if(!location){ const lm = html.match(/itemprop="addressLocality"[^>]*>([^<]+)/i) || html.match(/class="[^"]*jobGeoLocation[^"]*"[^>]*>([^<]+)/i) || html.match(/itemprop="addressCountry"[^>]*content="([^"]+)"/i) || html.match(/data-careersite-propertyid="(?:location|city)"[^>]*>\s*([^<]+)/i); if(lm) location = decodeHtmlEntities(lm[1]).trim(); }
        if(!location){ const jp = findJobPostings(extractJsonLd(html))[0]; const jl = jp && [].concat(jp.jobLocation || [])[0]; const ad = jl && jl.address; if(ad) location = [ad.addressLocality, ad.addressRegion, ad.addressCountry && (ad.addressCountry.name || ad.addressCountry)].filter(x => typeof x === 'string' && x).join(', '); }
        // Son çare: konum hiçbir yerde yoksa metindeki Avusturya şehri (RBI: 50 ilanın hepsinde konum boştu → hepsi elendi).
        if(!location){ const tm = description.slice(0, 3000).match(/\b(Wien|Vienna|Graz|Linz|Salzburg|Innsbruck|Klagenfurt|St\. Pölten)\b/); if(tm) location = tm[1] + ', Österreich'; }
      }
    }catch(e){}
    out.push({ title: it.title, company: ats.company || null, location: location || null, datePosted: null, description: description.slice(0, 9000), url: it.url, departmentNames: [] });
    await sleep2(200);
  }
  const short = out.filter(x => x.description.length < 300).length;
  console.log(`  SuccessFactors: ${out.length} ilan (${short} tanesinde metin kısa).`);
  return out;
}

// 01.10: Austrian Airlines (Lufthansa Group portalı). ParentOrganization 5909/5975/5974 = Austrian Airlines AG +
// Tochterfirmen (sitenin kendi "Austrian" filtresiyle aynı). Detay sayfasında JSON-LD var ama description
// HTML-escaped (&lt;p&gt;) geliyor → önce entity çözüp sonra düz metne çeviriyoruz. Gehalt satırı ayrıca ekleniyor.
// ---- 02.10: Danışmanlık / kurumsal okuyucular ----
const AT_LOC_RE = /vienna|wien|austria|österreich|graz|linz|salzburg|innsbruck|klagenfurt/i;
const sleep2 = ms => new Promise(r => setTimeout(r, ms));
// Roland Berger: sitenin kendi arama API'si (e-spirit) tüm ilanları konumlarıyla veriyor; çok şehirli ilanlar
// SmartRecruiters'ta Almanya'ya kayıtlı olduğu için SR'nin country=at filtresi sadece 2 ilan buluyordu (sitede 12).
async function fetchRolandBergerJobs(){
  let data;
  try{
    const r = await fetch('https://rolandberger-search-api.e-spirit.cloud/v1/prepared_search/JoinJobs/execute/?language=en&query=*&rows=500', { headers: RETAIL_UA, signal: AbortSignal.timeout(20000) });
    if(!r.ok){ console.log(`  ⚠️  Roland Berger API HTTP ${r.status}`); return null; }
    data = await r.json();
  }catch(e){ console.log(`  ⚠️  Roland Berger API: ${e.message}`); return null; }
  const rows = (data.results || []).filter(x => AT_LOC_RE.test([].concat(x.location || []).join(' ')));
  const out = [];
  for(const x of rows){
    const title = [].concat(x.title || x.positionProfile___alternativejobtitle || [])[0];
    const sr = [].concat(x.positionProfile___webAddress || [])[0] || '';
    const id = (sr.match(/RolandBerger\/(\d+)/) || [])[1];
    let description = '';
    if(id){
      try{
        const d = await fetch(`https://api.smartrecruiters.com/v1/companies/RolandBerger/postings/${id}`, { signal: AbortSignal.timeout(10000) });
        if(d.ok){ const j = await d.json(); const sec = j.jobAd && j.jobAd.sections; if(sec) description = Object.values(sec).map(s => s && s.text).filter(Boolean).join(' '); }
      }catch(e){}
      await sleep2(150);
    }
    out.push({ title, company: 'Roland Berger', location: 'Wien', datePosted: null, description, url: id ? `https://jobs.smartrecruiters.com/RolandBerger/${id}` : (x.link || sr), departmentNames: [].concat(x.audiences || []) });
  }
  console.log(`  Roland Berger: ${out.length} Avusturya ilanı (toplam ${(data.results || []).length}).`);
  return out;
}
// Yello (Kearney): /job_boards/{n}/search?query=Vienna JSON içinde HTML liste döndürüyor; detay sayfası sunucu-render.
async function fetchYelloJobs(ats){
  const seen = new Map();
  for(const q of ['Vienna', 'Austria']){
    try{
      const r = await fetch(`${ats.origin}/job_boards/${ats.board}/search?query=${q}`, { headers: { ...RETAIL_UA, 'X-Requested-With': 'XMLHttpRequest' }, signal: AbortSignal.timeout(20000) });
      if(!r.ok){ console.log(`  ⚠️  Yello HTTP ${r.status}`); continue; }
      const j = await r.json(), html = String(j.html || '');
      const re = /<li class="search-results__item"[\s\S]*?<\/li>/g; let m;
      while((m = re.exec(html))){
        const li = m[0], a = li.match(/href="([^"]+)"[^>]*>([^<]+)</);
        if(!a) continue;
        const plain = stripHtmlToPlainText(li);
        if(!AT_LOC_RE.test(plain)) continue;
        const url = ats.origin + a[1].replace(/&amp;/g, '&').split('?')[0];
        if(!seen.has(url)) seen.set(url, { title: decodeHtmlEntities(a[2]).trim(), url, plain });
      }
    }catch(e){ console.log(`  ⚠️  Yello: ${e.message}`); }
  }
  if(!seen.size) return null;
  const out = [];
  for(const it of seen.values()){
    let description = '';
    try{ const d = await fetch(it.url, { headers: { ...RETAIL_UA, Accept: 'text/html' }, signal: AbortSignal.timeout(12000) }); if(d.ok){ const t = stripHtmlToPlainText(await d.text()); const i = t.search(/job description/i); description = (i > -1 ? t.slice(i + 15) : t).slice(0, 8000); } }catch(e){}
    // 02.10: ilk canlı taramada 20 ilanın hepsinde metin boş geldi → JSON-LD dene, o da yoksa liste satırını kullan.
    // 03.10: Accept'te application/json önce olunca Yello (Rails) sayfa yerine "{}" döndürüyordu → 20 ilanın metni "{}" idi.
    if(description.length < 300){ try{ const ld = await fetchJsonLdText(it.url); if(ld && ld.length > description.length) description = ld; }catch(e){} }
    if(description.length < 300) console.log(`  ⚠️  Yello detay metni kısa (${description.length}): ${it.url}`);
    out.push({ title: it.title, company: ats.company || 'Kearney', location: 'Wien', datePosted: null, description: description || it.plain, url: it.url, departmentNames: [] });
    await sleep2(200);
  }
  console.log(`  ${ats.company}: ${out.length} Avusturya ilanı.`);
  return out;
}
// Henkel: AJAX listesi konum filtresini yok sayıyor → tüm liste (≈1000, sayfa 20) çekilip "Austria" içerenler alınıyor.
async function fetchHenkelJobs(){
  const base = 'https://www.henkel.com/ajax/collection/en/2083458-2083458/queryresults/asJson?ignoreDefaultFilterTags=true&loadCount=20&startIndex=';
  const hits = [];
  for(let start = 0, total = Infinity; start < Math.min(total, 3000); start += 20){
    let j;
    try{ const r = await fetch(base + start, { headers: RETAIL_UA, signal: AbortSignal.timeout(15000) }); if(!r.ok){ console.log(`  ⚠️  Henkel HTTP ${r.status}`); break; } j = await r.json(); }catch(e){ console.log(`  ⚠️  Henkel: ${e.message}`); break; }
    total = j.resultsTotal || 0;
    const res = j.results || []; if(!res.length) break;
    res.filter(x => /austria|österreich|vienna|wien/i.test(x.location || '')).forEach(x => hits.push(x));
    await sleep2(120);
  }
  const out = [];
  for(const x of hits){
    const url = 'https://www.henkel.com' + x.link;
    const text = await fetchJsonLdText(url);
    out.push({ title: x.title, company: 'Henkel', location: (String(x.location).match(/Austria,\s*([^,]+)/) || [])[1] || 'Wien', datePosted: null, description: text, url, departmentNames: [] });
    await sleep2(150);
  }
  console.log(`  Henkel: ${out.length} Avusturya ilanı.`);
  return out;
}

async function fetchAustrianJobs(){
  const q = { SearchParameters: { FirstItem: 1, CountItem: 500, Sort: [], MatchedObjectDescriptor: ['ID','PositionTitle','PositionURI','PositionLocation.CountryName','PositionLocation.CityName','ParentOrganizationName','PublicationStartDate'] },
    SearchCriteria: [{ CriterionName: 'ParentOrganization', CriterionValue: [5909, 5975, 5974] }], LanguageCode: 'DE' };
  let data;
  try{
    const res = await fetch('https://api-apply.lufthansagroup.careers/search/?data=' + encodeURIComponent(JSON.stringify(q)),
      { headers: { ...RETAIL_UA, Origin: 'https://www.lufthansagroup.careers', Referer: 'https://www.lufthansagroup.careers/' }, signal: AbortSignal.timeout(20000) });
    if(!res.ok){ console.log(`  ⚠️  Austrian API HTTP ${res.status}`); return null; }
    data = await res.json();
  }catch(e){ console.log(`  ⚠️  Austrian API isteği başarısız: ${e.message}`); return null; }
  const items = ((data && data.SearchResult && data.SearchResult.SearchResultItems) || []).map(i => i.MatchedObjectDescriptor).filter(j => j && j.PositionTitle && j.PositionURI);
  const decode = x => String(x).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&amp;/g, '&');
  const out = [];
  for(const j of items){
    const loc = (j.PositionLocation || [])[0] || {};
    if(loc.CountryName && !/österreich|austria/i.test(loc.CountryName)) continue;
    if(isLehre(j.PositionTitle)) continue;
    let text = '', salary = '';
    try{
      const res = await fetch(j.PositionURI, { headers: RETAIL_UA, signal: AbortSignal.timeout(12000) });
      if(res.ok){
        const html = await res.text();
        const jp = findJobPostings(extractJsonLd(html))[0];
        if(jp && jp.description) text = stripHtmlToPlainText(decode(jp.description));
        const flat = stripHtmlToPlainText(html);
        const m = flat.match(/Gehalt:?\s*(EUR[^\n]{3,80})/i);
        if(m) salary = `Gehalt: ${m[1].trim()}\n`;
      }
    }catch(e){}
    out.push({ title: String(j.PositionTitle).trim(), company: 'Austrian Airlines', location: loc.CityName || 'Wien',
      datePosted: j.PublicationStartDate || null, description: salary + text, url: j.PositionURI, departmentNames: [] });
    await new Promise(r => setTimeout(r, 200));
  }
  console.log(`  Austrian Airlines API: ${out.length} ilan.`);
  return out;
}

async function fetchHoferJobs(ats){
  const origin = ats.origin || 'https://karriere.hofer.at';
  let data;
  try{
    const res = await fetch(`${origin}/rest/jobs/search`, { headers: RETAIL_UA, signal: AbortSignal.timeout(20000) });
    if(!res.ok){ console.log(`  ⚠️  HOFER API HTTP ${res.status}`); return null; }
    data = await res.json();
  }catch(e){ console.log(`  ⚠️  HOFER API isteği başarısız: ${e.message}`); return null; }
  const jobs = (data && Array.isArray(data.jobs) ? data.jobs : []).filter(j => j && j.title && j.url);
  console.log(`  HOFER API: ${jobs.length} ilan (tek tek).`);
  const STORE = /^(filialteam|filialleitung)$/i;
  const rows = jobs
    .filter(j => !isLehre(j.title) && !/lehre/i.test(j.career_level_title || '') && !guessGenericApplication(j.title))
    .map(j => ({
      title: String(j.title).replace(/​/g, '').replace(/\s+/g, ' ').trim(),
      city: j.city ? String(j.city).trim() : null,
      zip: j.zip, area: j.area_of_activity_title || '', level: j.career_level_title || '',
      type: j.shift_type || j.shift || '',
      url: `${origin}/${String(j.url).replace(/^\//, '')}`, id: String(j.job_id || j.url),
      dept: j.area_of_activity_title || null,
    }));
  const groups = new Map(); const singles = [];
  for(const r of rows){
    if(STORE.test(r.area)){
      const bl = bundeslandFromZip(r.zip) || 'Österreich';
      const k = `${r.title}|${bl}`;
      if(!groups.has(k)) groups.set(k, { role: r.title, bl, members: [] });
      groups.get(k).members.push(r);
    } else singles.push(r);
  }
  const out = [];
  for(const g of groups.values()){
    const rep = [...g.members].sort((a, b) => a.id.localeCompare(b.id))[0]; // sabit temsilci → aynı link her gün
    const repText = await fetchJsonLdText(rep.url);
    out.push(retailGroupItem({ company: 'HOFER', role: g.role, bl: g.bl, members: g.members, rep, repText, types: g.members.map(m => m.type).filter(Boolean) }));
    await new Promise(r => setTimeout(r, 150));
  }
  for(const s of singles){
    const text = await fetchJsonLdText(s.url);
    out.push({ title: s.title, company: 'HOFER', location: [s.city, bundeslandFromZip(s.zip)].filter(Boolean).join(' | ') || 'Österreich',
      datePosted: null, description: `${s.type ? `Beschäftigungsausmaß: ${s.type}.\n` : ''}${text}`, url: s.url, departmentNames: s.dept ? [s.dept] : [] });
    await new Promise(r => setTimeout(r, 150));
  }
  console.log(`  HOFER: ${groups.size} mağaza grubu + ${singles.length} tekil ilan (Lehrling hariç).`);
  return out;
}

// SPAR mağaza ilanlarının başlıkları çok dağınık ("Verkäufer Feinkost 20-38,5 Std./Wo - Ligist", "IM61 Mitarbeiter
// Obst & Gemüse , 30 Std./Woche") — gruplamak için ortak bir role indiriyoruz.
function sparStoreRole(title){
  const x = String(title || '').toLowerCase();
  if(/trainee|praktik|ferial/.test(x)) return null; // tekil kalsın
  if(/(stv\.?|stellvertret)/.test(x) && /(filial|markt)leit|leitung/.test(x)) return 'Stellvertretende Filialleitung';
  if(/(filial|markt)leit/.test(x)) return 'Filialleitung';
  if(/abteilungsleit|bereichsleit/.test(x)) return 'Abteilungsleitung Verkauf';
  if(/samstag/.test(x)) return 'Samstagskraft Verkauf';
  if(/kassa|kasse|check-?out/.test(x)) return 'Mitarbeiter Kassa';
  if(/koch|küche|kuech|kitchen|abwäsch|abwasch/.test(x)) return 'Küchenmitarbeiter Gastronomie';
  if(/service|restaurant|gastro|café|cafe|kaffee|barista|imbiss/.test(x)) return 'Servicemitarbeiter Gastronomie';
  if(/reinigung/.test(x)) return 'Reinigungskraft';
  if(/kühlung|frischdienst|molkerei/.test(x)) return 'Mitarbeiter Frische & Kühlung';
  if(/feinkost|brot|gebäck|käse|fisch|wurst|fleisch|metzger|fleischer|bäcker|konditor/.test(x)) return 'Verkäufer Feinkost';
  if(/obst|gemüse/.test(x)) return 'Verkäufer Obst & Gemüse';
  if(/getränk|leergut|wein/.test(x)) return 'Mitarbeiter Getränke';
  if(/non-?food|hartware|textil|drogerie|parfum|elektro/.test(x)) return 'Mitarbeiter Non-Food';
  if(/regal|waren|lager|verräum|nachtschicht|trockensortiment/.test(x)) return 'Mitarbeiter Warenverräumung';
  return 'Verkäufer Allrounder';
}
// "Trainee Filiale (m/w/d) 38,5 Std./Wo" / "Lagermitarbeiter (m/w/d) 20-32 Std./Wo in Dornbirn" → "Trainee Filiale"
function normRetailTitle(t){
  return String(t || '')
    .replace(/\((m\/w\/d|w\/m\/d|d\/w\/m|m\/w\/x|w\/m\/x)\)/gi, ' ')
    .replace(/,?\s*\b(IM|MM)\d+\b/g, ' ')
    .replace(/[,\s]*\d+(?:,\d+)?\s*(?:[-–]|bis)?\s*(?:\d+(?:,\d+)?)?\s*(?:Std\.?|Stunden)\s*\/?\s*(?:Wo(?:che)?\.?)?/gi, ' ')
    .replace(/\s+[-–|]\s+.*$/, '')
    .replace(/\s+in\s+[A-ZÄÖÜ][\wäöüß.\-]+$/, '')
    .replace(/\s+/g, ' ').replace(/[,\s]+$/, '').trim();
}
// 02.10: dm API "Invalid time value" ile tamamen düştü — tarih artık sayı (ms) ya da metin olabilir; geçersizse null.
function safeIsoDate(v){
  if(v == null || v === '') return null;
  const d = new Date(/^\d{10,13}$/.test(String(v)) ? Number(v) : v);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}
// 02.10: SPAR API GitHub sunucularından 403 (bot koruması). Gerçek tarayıcıda spar.at açılıp aynı istek
// sayfanın içinden yapılıyor (sitenin kendi çağrısıyla aynı).
async function sparFetchViaBrowser(urls){
  let browser;
  try{
    browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const pg = await browser.newPage();
    await pg.setUserAgent(RETAIL_UA['User-Agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36');
    await pg.goto('https://www.spar.at/karriere/jobboerse', { waitUntil: 'networkidle2', timeout: 60000 });
    const out = [];
    for(const u of urls){
      const r = await pg.evaluate(async (x)=>{ try{ const res = await fetch(x, { credentials: 'omit' }); return { ok: res.ok, status: res.status, body: res.ok ? await res.json() : null }; }catch(e){ return { ok: false, status: String(e) }; } }, u);
      if(!r.ok){ console.log(`  ⚠️  SPAR (tarayıcı) ${r.status}`); break; }
      out.push(r.body);
      const pc = r.body && r.body.paging && r.body.paging.pageCount;
      if(!pc || out.length >= pc) break;
    }
    return out;
  }catch(e){ console.log(`  ⚠️  SPAR tarayıcı yedeği başarısız: ${e.message}`); return []; }
  finally{ if(browser) await browser.close().catch(()=>{}); }
}
async function fetchSparJobs(){
  const all = [];
  for(let page = 1; page <= 10; page++){
    let data;
    try{
      const res = await fetch(`https://bfs.spar-ics.com/fact-finder/rest/v5/search/jobs_at?query=*&page=${page}&hitsPerPage=500&sort=publication-date:desc`, { headers: { ...RETAIL_UA, 'Origin': 'https://www.spar.at', 'Referer': 'https://www.spar.at/karriere/jobboerse' }, signal: AbortSignal.timeout(20000) }); // 01.10: GitHub'dan 0 geldi — sitenin kendi isteği gibi Origin/Referer
      if(!res.ok){
        console.log(`  ⚠️  SPAR API HTTP ${res.status}${res.status === 403 ? ' — tarayıcı yedeği deneniyor' : ''}`);
        if(res.status === 403 && page === 1){
          const pages = await sparFetchViaBrowser(Array.from({ length: 10 }, (_, k) => `https://bfs.spar-ics.com/fact-finder/rest/v5/search/jobs_at?query=*&page=${k + 1}&hitsPerPage=500&sort=publication-date:desc`));
          pages.forEach(d => { const hits = Array.isArray(d && d.hits) ? d.hits.map(h => h.masterValues).filter(Boolean) : []; all.push(...hits); });
        }
        break;
      }
      data = await res.json();
    }catch(e){ console.log(`  ⚠️  SPAR API isteği başarısız: ${e.message}`); break; }
    const hits = Array.isArray(data.hits) ? data.hits.map(h => h.masterValues).filter(Boolean) : [];
    all.push(...hits);
    const pc = data.paging && data.paging.pageCount;
    if(!hits.length || (pc && page >= pc)) break;
  }
  if(!all.length) return null;
  console.log(`  SPAR API: ${all.length} ilan (tek tek).`);
  const cat = j => [].concat(j.category || []).join(' / ');
  const rows = all
    .filter(j => j.title && j.url && String(j.country || 'AT').toUpperCase() === 'AT')
    .filter(j => !/lehrling|initiativ/i.test(cat(j)) && !isLehre(j.title) && !guessGenericApplication(j.title))
    .map(j => {
      const districts = [].concat(j.district || []).filter(Boolean);
      return {
        title: String(j.title).replace(/\s+/g, ' ').trim(), city: j.city ? String(j.city).trim() : null, zip: j.zipcode,
        bl: (districts.length === 1 && BL_CODES[districts[0]]) || bundeslandFromZip(j.zipcode) || null,
        cat: cat(j), type: j.type || '', url: j.url, id: String(j.id || j.url), date: j['publication-date'] || null,
        brand: [].concat(j['business-type'] || []).join('/'),
        text: [j.description && j.description !== j.title ? j.description : '',
          (j.requirements || []).length ? `Was du mitbringst:\n• ${j.requirements.join('\n• ')}` : '',
          (j.benefits || []).length ? `Was wir bieten:\n• ${j.benefits.join('\n• ')}` : '',
          j.start ? `Beginn: ${j.start}` : '', j.type ? `Beschäftigungsausmaß: ${j.type}` : ''].filter(Boolean).join('\n\n'),
        dept: cat(j) || null,
      };
    });
  const STORE = /^(verkauf|gastronomie)$/i;
  const groups = new Map(); const singles = [];
  for(const r of rows){
    const role = STORE.test(r.cat) ? sparStoreRole(r.title) : null;
    if(role){
      const bl = r.bl || 'Österreich';
      const k = `${role}|${bl}`;
      if(!groups.has(k)) groups.set(k, { role, bl, members: [] });
      groups.get(k).members.push(r);
    } else singles.push(r);
  }
  const out = [];
  for(const g of groups.values()){
    const rep = [...g.members].sort((a, b) => a.id.localeCompare(b.id))[0];
    out.push(retailGroupItem({ company: 'SPAR Österreich', role: g.role, bl: g.bl, members: g.members, rep, repText: rep.text, types: g.members.map(m => m.type).filter(Boolean) }));
  }
  // Tekil ilanlarda da aynı başlık aynı eyalette 2+ kez geçiyorsa (ör. "Trainee Filiale" 8 filialde) grupla.
  const sg = new Map();
  singles.forEach(r => { const k = `${normRetailTitle(r.title)}|${r.bl || 'Österreich'}`; if(!sg.has(k)) sg.set(k, []); sg.get(k).push(r); });
  const realSingles = [];
  for(const [k, members] of sg){
    if(members.length < 2){ realSingles.push(members[0]); continue; }
    const rep = [...members].sort((a, b) => a.id.localeCompare(b.id))[0];
    const [role, bl] = k.split('|');
    out.push(retailGroupItem({ company: 'SPAR Österreich', role: role || rep.title, bl, members, rep, repText: rep.text, types: members.map(m => m.type).filter(Boolean) }));
  }
  for(const s of realSingles){
    out.push({ title: s.title, company: 'SPAR Österreich', location: [s.city, s.bl].filter(Boolean).join(' | ') || 'Österreich',
      datePosted: s.date, description: s.text, url: s.url, departmentNames: s.dept ? [s.dept] : [] });
  }
  console.log(`  SPAR: ${out.length - realSingles.length} grup + ${realSingles.length} tekil ilan (Lehrling/Initiativ hariç).`);
  return out;
}

// 30.09: dm drogerie markt — dm-jobs.at kendi arama API'sini kullanıyor (liste sayfası JS ile, genel crawler 9/434 görüyordu).
// Parametre sırası sitenin kendi isteğiyle BİREBİR aynı tutuluyor (farklı sırada HTML dönüyor). Hızlı art arda isteklerde
// site sonuçları kısabiliyor (count birden 2'ye düşüyor) → istekler arası 1.5 sn, tutarsız cevapta bir kez daha deneniyor.
// Lehre (271 ilan) alınmıyor; mağaza/stüdyo işleri (Verkauf, Regal, Friseur, Kosmetik …) "departman + eyalet" başına gruplanıyor.
async function fetchDmJobs(){
  const mk = page => `https://www.dm-jobs.at/api/job/search?q&perPage=50&country=at&region&geoRadius=30&category&city&department&jobType&workHours&workPlaceType&jobSectors&jobSector&jobLevels&page=${page}&orderBy`;
  const get = async page => {
    for(let attempt = 0; attempt < 2; attempt++){
      try{
        const res = await fetch(mk(page), { headers: RETAIL_UA, signal: AbortSignal.timeout(20000) });
        if(res.ok && /json/.test(res.headers.get('content-type') || '')){
          const j = await res.json();
          if(Array.isArray(j.jobs) && (j.count || 0) > 20) return j;
        }
      }catch(e){}
      await new Promise(r => setTimeout(r, 5000));
    }
    return null;
  };
  const all = []; let count = null;
  for(let page = 1; page <= 20; page++){
    const j = await get(page);
    if(!j){ console.log(`  ⚠️  dm API sayfa ${page} alınamadı`); break; }
    count = j.count; all.push(...j.jobs);
    if(j.jobs.length < 50 || all.length >= count) break;
    await new Promise(r => setTimeout(r, 1500));
  }
  if(!all.length) return null;
  console.log(`  dm API: ${all.length}/${count} ilan (tek tek).`);
  const rows = all
    .filter(j => j && j.title && j.link && j.jobType !== 'Lehrverhältnis' && !isLehre(j.title) && !guessGenericApplication(j.title))
    .map(j => {
      const a = (j.addresses || [])[0] || {};
      const sal = j.custSalaryOf ? `Gehalt: ab € ${j.custSalaryOf} ${j.custSalaryBruttoNetto || 'brutto'} (${j.custSalaryType || 'Monatsgehalt'}, Vollzeitbasis 38,5 Std./Woche).` : '';
      return {
        title: String(j.title).replace(/\s+/g, ' ').trim(), city: a.city || a.altCity || null, zip: a.postalCode,
        cat: j.category || '', dept: j.department || j.category || null, type: [j.workHours, j.workHoursValue].filter(Boolean).join(' '),
        url: j.link, id: String(j.jobId || j.id), date: safeIsoDate(j.datePosted),
        text: [stripHtmlToPlainText(j.tasks || ''), stripHtmlToPlainText(j.profile || ''), stripHtmlToPlainText(j.benefits || ''), sal,
          j.workHoursValue ? `Beschäftigungsausmaß: ${j.workHours || ''} ${j.workHoursValue}` : ''].filter(Boolean).join('\n\n'),
      };
    });
  const STORE = /^dm (filiale|friseurstudio|kosmetikstudio)$/i;
  const groups = new Map(); const singles = [];
  for(const r of rows){
    if(STORE.test(r.cat) && r.dept){
      const bl = bundeslandFromZip(r.zip) || 'Österreich';
      const k = `${r.dept}|${bl}`;
      if(!groups.has(k)) groups.set(k, { role: r.dept, bl, members: [] });
      groups.get(k).members.push(r);
    } else singles.push(r);
  }
  const out = [];
  for(const g of groups.values()){
    const rep = [...g.members].sort((a, b) => a.id.localeCompare(b.id))[0];
    out.push(retailGroupItem({ company: 'dm drogerie markt', role: g.role, bl: g.bl, members: g.members, rep, repText: rep.text, types: g.members.map(m => m.type).filter(Boolean) }));
  }
  for(const s of singles){
    out.push({ title: s.title, company: 'dm drogerie markt', location: [s.city, bundeslandFromZip(s.zip)].filter(Boolean).join(' | ') || 'Österreich',
      datePosted: s.date, description: s.text, url: s.url, departmentNames: s.dept ? [s.dept] : [] });
  }
  console.log(`  dm: ${groups.size} mağaza/stüdyo grubu + ${singles.length} tekil ilan (Lehre hariç).`);
  return out;
}

// Bain & Company — kendi dahili "jobsearch" API'si. Liste cevabı Phenom'dan bile iyi: her ilan
// zaten TAM açıklamayı (JobDescription, HTML) taşıyor — ayrıca detay sayfası çekmeye gerek yok.
// Cevabın tam zarfını (hangi anahtarın altında dizi olduğunu) görmedik — Phenom'daki gibi JSON
// ağacını GEZEREK "JobId" + "JobTitle" taşıyan nesneleri buluyoruz, zarftan bağımsız çalışır.
function findBainJobObjects(node, out = []){
  if(!node) return out;
  if(Array.isArray(node)){ node.forEach(n => findBainJobObjects(n, out)); return out; }
  if(typeof node !== 'object') return out;
  if(node.JobId && node.JobTitle) out.push(node);
  else Object.values(node).forEach(v => findBainJobObjects(v, out));
  return out;
}
async function fetchBainJobs(ats){
  const { origin, filters } = ats;
  // DÜZELTME (Eren'in denemesinde görüldü): Node'un düz fetch()'i buradan 403 alıyor — Bain'in
  // bot koruması (muhtemelen TLS/parmak izi kontrolü) tarayıcı olmayan istekleri reddediyor.
  // Çözüm: isteği Node'dan değil, Puppeteer'ın açtığı GERÇEK Chrome sekmesinin İÇİNDEN
  // (page.evaluate + fetch) atıyoruz — bot korumasının gördüğü şey artık gerçek bir tarayıcı.
  let browser;
  try{
    browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36');
    // Önce normal bir Bain sayfasına gidiyoruz — bot koruması genelde önce bir sayfa
    // yüklemesi/çerez bekliyor, hiç sayfa açmadan direkt API'ye gidince 403 veriyordu.
    await page.goto(`${origin}/de/careers/find-a-role/`, { waitUntil: 'networkidle2', timeout: 30000 });

    const seen = new Set();
    const all = [];
    const PAGE_SIZE = 20;
    const MAX_PAGES = 15;
    for(let p = 0; p < MAX_PAGES; p++){
      const url = `${origin}/de/api/jobsearch/keyword/get?start=${p * PAGE_SIZE}&results=${PAGE_SIZE}&filters=${encodeURIComponent(filters)}&searchValue=`;
      const data = await page.evaluate(async (u) => {
        try{
          const res = await fetch(u);
          if(!res.ok) return null;
          return await res.json();
        }catch(e){ return null; }
      }, url);
      if(!data){
        // DÜZELTME (22-24 Eylül'de 3 gün üst üste 0 sonuç): gerçek hata sebebi page.evaluate
        // İÇİNDE yutuluyordu (browser context'ten Node'a taşınmıyordu) — bu yüzden "neden 0"
        // hiç görünmüyordu. En azından "hangi sayfada/hangi URL'de başarısız oldu" bilgisini
        // Node tarafında logluyoruz; muhtemel sebep bot koruması (403) — Puppeteer kullanmamıza
        // rağmen GitHub Actions'ın datacenter IP'si yine de tanınıp engellenmiş olabilir.
        console.log(`  ⚠️  Bain API isteği boş/başarısız döndü (sayfa ${p}), muhtemel 403/bot koruması: ${url}`);
        if(p === 0){ await browser.close(); return null; } // sayfa 0 bile başarısızsa Bain değil/engelli
        break;
      }
      const jobs = findBainJobObjects(data);
      if(!jobs.length) break;
      let newOnThisPage = 0;
      for(const j of jobs){
        if(seen.has(j.JobId)) continue;
        seen.add(j.JobId);
        all.push(j);
        newOnThisPage++;
      }
      if(newOnThisPage === 0) break;
    }
    await browser.close();
    if(!all.length) return null;
    // DÜZELTME (24 Eylül — Eren'in fark ettiği "boş req" sorunu): Bain'in API'sinde gerçek ilanların
    // yanında "EmployeeType": "Program" etiketli genel tanıtım kayıtları da dönüyor (Bainworks,
    // Jumpstart, Power of 4, Spark, True North Scholarship gibi) — bunlar belirli bir pozisyon değil,
    // onlarca şehri birden kapsayan program-tanıtım sayfaları, ve Bain'in kendi verisinde
    // "JobDescription": null geliyor (bizim çekme hatamız değil, kaynağında boş). Açıklaması olmayan
    // bir ilan için guessRequirements'ın ürettiği "%100 tahmin" alanlar gerçek sinyal taşımıyor —
    // bunları en baştan eleyip sadece gerçek, açıklaması olan ilanları döndürüyoruz.
    const realJobs = all.filter(j => j.EmployeeType !== 'Program' && j.JobDescription);
    const skipped = all.length - realJobs.length;
    if(skipped) console.log(`  ℹ️  ${skipped} "program" tanıtım kaydı (açıklamasız, ör. Bainworks/Jumpstart) elendi — gerçek ilan değiller.`);
    if(!realJobs.length) return null;
    return realJobs.map(j => ({
      title: j.JobTitle || null,
      company: 'Bain & Company',
      // Location bir DİZİ (aynı ilan çoğu zaman onlarca ofise birden açık) — hepsini birleştirip
      // location metnine koyuyoruz, buildCityRegex zaten alt-string arıyor, "Wien"/"Vienna" içinde
      // geçiyorsa yakalar.
      location: Array.isArray(j.Location) ? j.Location.join(', ') : (j.Location || null),
      datePosted: null,
      description: j.JobDescription || '',
      url: j.Link ? new URL(j.Link, origin).href : null,
    }));
  }catch(e){
    if(browser) await browser.close().catch(() => {});
    return null;
  }
}

// BMW Group (Adobe AEM/Sling "Job Finder" bileşeni). Onlyfy ile AYNI iki aşamalı mantık: önce
// liste uç noktasından (sayfalanarak) ilan ID'lerini topla, sonra her birinin kendi statik detay
// sayfasını (job-description-copy.{id}.html) çek. Konum alanını AYRICA tahmin etmeye gerek yok —
// filterSearch zaten belirli bir şehre/ülkeye göre filtrelenmiş bir istek, o yüzden "citySlug"'ı
// (ör. "wien" → "Wien") doğrudan location olarak kullanıyoruz.
async function fetchBmwJobs(ats){
  const { origin, basePath, localePrefix, citySlug, filterSearch } = ats;
  const cityName = citySlug.charAt(0).toUpperCase() + citySlug.slice(1);
  const seen = new Set();
  const ids = [];
  const MAX_PAGES = 25;
  const BLOCK = 50; // "blockCount" — DevTools'ta 5 görülmüştü, daha büyük bir değer denemeye değer;
                     // API görmezden gelip kendi sabit sayısını dönerse de aşağıdaki döngü zaten
                     // "yeni ilan yoksa dur" mantığıyla doğru çalışır (onlyfy'daki display_length gibi).

  // DÜZELTME (24 Eylül — curl -v ile doğrulandı): BMW'nin sunucusu, Node'un/curl'ün düz HTTP/2
  // isteklerini "INTERNAL_ERROR" ile RESETLİYOR (403 bile değil, protokol seviyesinde bot koruması —
  // muhtemelen TLS/HTTP2 parmak izine bakıyor). Bain'de yaptığımız gibi çözüm: isteği Node'dan değil,
  // Puppeteer'ın açtığı GERÇEK Chrome sekmesinin İÇİNDEN (page.evaluate + fetch) atıyoruz —
  // bot korumasının gördüğü şey artık gerçek bir tarayıcı, resetlenmiyor.
  let browser;
  try{
    browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36');
    // Önce normal bir BMW career sayfasına gidiyoruz — direkt API/statik yola gidince resetleniyordu.
    await page.goto(`${origin}${localePrefix}/`, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});

    for(let pageNum = 0; pageNum < MAX_PAGES; pageNum++){
      const rowIndex = pageNum * BLOCK;
      const listUrl = `${origin}${basePath}?filterSearch=${encodeURIComponent(filterSearch)}&rowIndex=${rowIndex}&blockCount=${BLOCK}`;
      const html = await page.evaluate(async (u) => {
        try{
          const res = await fetch(u);
          if(!res.ok) return null;
          return await res.text();
        }catch(e){ return null; }
      }, listUrl);
      if(html === null){
        console.log(`  ⚠️  BMW jobfinder listesi isteği başarısız/boş döndü (sayfa ${pageNum}): ${listUrl}`);
        break;
      }

      const idRe = /job-description-copy\.(\d+)\.html/g;
      const pageIds = [...new Set([...html.matchAll(idRe)].map(m => m[1]))];
      if(!pageIds.length) break; // bu sayfada hiç ilan yok — sona geldik

      let newOnThisPage = 0;
      for(const id of pageIds){
        if(seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
        newOnThisPage++;
      }
      if(newOnThisPage === 0) break; // tekrar geldi — sayfalama tükendi
    }

    const full = [];
    let detailFailures = 0;
    for(const id of ids){
      const detailUrl = `${origin}${localePrefix}/jobfinder/job-description-copy.${id}.html`;
      const html = await page.evaluate(async (u) => {
        try{
          const res = await fetch(u);
          if(!res.ok) return null;
          return await res.text();
        }catch(e){ return null; }
      }, detailUrl);
      if(html === null){
        detailFailures++;
        console.log(`  ⚠️  Detay sayfası çekilemedi/boş döndü: ${detailUrl}`);
        continue;
      }
      // Başlığı <title> etiketinden çıkarıyoruz — genelde "Başlık | BMW Group Careers" gibi bir
      // ek taşıyor, " | " ya da " - " öncesini alıyoruz. Bulunamazsa ilan yine de dahil edilir,
      // sadece başlık boş kalır (Whittle tarafında elle tamamlanması gerekir).
      const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
      const title = titleMatch ? titleMatch[1].split(/\s*[\|\-–]\s*/)[0].trim() : null;
      full.push({
        title,
        company: 'BMW Group',
        location: cityName,
        datePosted: null, // detay sayfasında var ama ham HTML'de nerede olduğunu doğrulamadık — TAHMİN etmiyoruz, boş bırakıyoruz
        // guessRequirements zaten HTML'i düz metne indiriyor — ham HTML'i olduğu gibi geçiriyoruz.
        description: html,
        url: detailUrl,
      });
      await new Promise(r => setTimeout(r, 200));
    }
    await browser.close();
    if(detailFailures){
      console.log(`  ℹ️  ${detailFailures}/${ids.length} ilanın detay sayfası çekilemedi.`);
    }
    return full;
  }catch(e){
    if(browser) await browser.close().catch(() => {});
    console.log(`  ⚠️  BMW Puppeteer akışı başarısız: ${e.message}`);
    return null;
  }
}

// softgarden ("Karriereseite Pro") diğer ATS'lerden farklı — sabit bir alan adı YOK, her müşteri
// kendi domain'inde barındırıyor (ör. jobs.volksbankwien.at). Ama TÜM softgarden siteleri aynı
// standart yolda (origin + /jobs/jobs.feed.json) tam bir schema.org DataFeed sunuyor — şirketin
// TÜM ilanlarını tek istekte, temiz ve yapılandırılmış olarak. Sabit hostname olmadığı için
// detectAtsFromUrl'e eklenemiyor — bunun yerine herhangi bir URL için "dener", yoksa sessizce
// null döner (zararsız, normal akışa devam edilir).
// Phenom People ("Career Site Builder") — softgarden gibi sabit bir alan adı yok, her müşteri
// kendi domain'inde (careers.{şirket}.com gibi) ama AYNI /widgets uç noktasını ve aynı POST
// payload yapısını kullanıyor gibi görünüyor (BCG'de Eren'in DevTools'ta bulduğu örnek). Resmi/
// belgelenmiş Phenom API'si OAuth2 token istiyor (kullanamayız) — ama bu, sitenin KENDİ arama
// widget'ının çağırdığı, kimlik doğrulama gerektirmeyen dahili uç nokta. Softgarden gibi herhangi
// bir URL için "dener", Phenom değilse ya da yapı uymazsa sessizce null döner, zararsızca normal
// akışa devam edilir. Cevabın tam zarfını (hangi anahtarın altında dizi olduğunu) bilmediğimiz
// için JSON ağacını GEZEREK "title" + ("applyUrl" ya da "jobSeqNo") taşıyan nesneleri buluyoruz —
// findJobPostings'in JSON-LD için yaptığı gezinmeyle aynı mantık.
function findPhenomJobObjects(node, out = []){
  if(!node) return out;
  if(Array.isArray(node)){ node.forEach(n => findPhenomJobObjects(n, out)); return out; }
  if(typeof node !== 'object') return out;
  if(node.title && (node.applyUrl || node.jobSeqNo)) out.push(node);
  else Object.values(node).forEach(v => findPhenomJobObjects(v, out));
  return out;
}
async function fetchPhenomJobs(origin, cityFilter){
  // Phenom'un city filtresi İngilizce şehir adı bekliyor (BCG örneğinde "Vienna", "Wien" değil) —
  // parser'ın zaten sahip olduğu Wien/Vienna eşleştirmesini burada da kullanıyoruz.
  const alias = CITY_ALIASES[(cityFilter || '').toLowerCase()];
  const cityForPayload = alias
    ? alias.charAt(0).toUpperCase() + alias.slice(1)
    : (cityFilter || '').charAt(0).toUpperCase() + (cityFilter || '').slice(1);

  const all = [];
  const seen = new Set();
  const PAGE_SIZE = 20;
  const MAX_PAGES = 15;
  for(let page = 0; page < MAX_PAGES; page++){
    const payload = {
      lang: 'en_global', deviceType: 'desktop', country: 'global', pageName: 'search-results',
      all_fields: ['country','city','category','company','type','jobType'],
      clearAll: false, counts: true, ddoKey: 'refineSearch', from: page * PAGE_SIZE,
      global: true, irs: false, isSliderEnable: false, jdsource: 'facets', jobs: true,
      keywords: '', lang_gen: true, locationData: {}, pageId: 'page17-ds',
      selected_fields: isAustriaMode(cityFilter) ? { country: ['Austria'] } : { city: [cityForPayload] }, siteType: 'external', size: PAGE_SIZE,
      sortBy: '', subsearch: '',
    };
    let data;
    try{
      const res = await fetch(`${origin}/widgets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000),
      });
      if(!res.ok) return page === 0 ? null : all; // ilk sayfa bile başarısızsa Phenom değildir
      data = await res.json();
    }catch(e){ return page === 0 ? null : all; }

    const jobs = findPhenomJobObjects(data);
    if(!jobs.length) break; // sayfa boş — bitti (ya da hiç Phenom değil, ilk sayfaysa null'a düşer)

    let newOnThisPage = 0;
    for(const j of jobs){
      const key = j.jobSeqNo || j.applyUrl;
      if(seen.has(key)) continue;
      seen.add(key);
      all.push(j);
      newOnThisPage++;
    }
    if(newOnThisPage === 0) break; // tekrar geldi, sayfalama tükendi
  }
  if(!all.length) return null; // ilk sayfada da hiç bulunamadıysa Phenom değildir, null döndür

  // DÜZELTME (Eren'in fark ettiği hata): payload'daki selected_fields.city filtresi Phenom
  // tarafında GÜVENİLİR ÇALIŞMIYOR — BCG denemesinde "Vienna" istendiği halde Düsseldorf/München
  // ilanları da karışık geldi. O yüzden kendi tarafımızda da (diğer entegrasyonlarla tutarlı
  // şekilde) location alanına göre GERÇEK filtreyi uyguluyoruz — Phenom'un filtresine güvenmiyoruz.
  const cityFiltered = all.filter(j => j.location && buildCityRegex(cityFilter).test(j.location));

  // Her ilanın applyUrl'inden (varsa) sayısal bir job ID çıkarıp KENDİ detay sayfasından
  // (origin + /global/en/job/{id}) JSON-LD çekmeyi deniyoruz — liste cevabı açıklama metni
  // TAŞIMIYOR (bunu BCG'de gördük), ama BCG'nin detay sayfalarında temiz schema.org/JobPosting
  // JSON-LD olduğunu zaten doğruladık. Bu, BCG'ye ÖZGÜ bir URL kalıbı tahmini — başka bir Phenom
  // sitesinde farklı olabilir, o yüzden başarısız olursa (404 ya da JSON-LD yoksa) sessizce
  // açıklamasız devam ediyoruz, hiç veri kaybetmeden.
  function extractIdFromApplyUrl(applyUrl){
    if(!applyUrl) return null;
    const platinionMatch = applyUrl.match(/[?&]jobId=(\d+)/);
    if(platinionMatch) return platinionMatch[1];
    const talentMatch = applyUrl.match(/\/jobs\/(\d+)/);
    if(talentMatch) return talentMatch[1];
    return null;
  }

  // DÜZELTME (PMI — Eren'in getirdiği ham /widgets cevabıyla doğrulandı): BCG'nin applyUrl'i
  // vardı, PMI'nin cevabında applyUrl HİÇ YOK — ne de tam bir "description" alanı. Onun yerine:
  //   - jobId (ör. "26165") ve locale (ör. "en_GB") var,
  //   - gerçek ilan sayfası kalıbı {origin}/{ülke}/{dil}/job/{jobId}/{başlık-slug} (WebSearch'te
  //     doğrulanan örnek: join.pmicareers.com/gb/en/job/23262/Future-Leaders-Austria-M-F-D),
  //     ülke/dil, locale'in "en_GB" gibi "{dil}_{ÜLKE}" biçiminden çıkarılıyor.
  //   - açıklama olarak sadece kesilmiş "teaser" metinleri var (descriptionTeaser ve
  //     ml_job_parser.descriptionTeaser_ats/_first200/_keyword — hepsi aynı giriş paragrafının farklı
  //     uzunlukta kırpılmış kopyaları). Gerçek/tam açıklama İÇİN detay sayfasını çekip JSON-LD
  //     aramaya devam ediyoruz (BCG'de bu yöntem işe yarıyordu) — bulamazsak en azından en temiz
  //     teaser'ı (descriptionTeaser, kırpılma işareti yok) kullanıyoruz, hiç açıklamasız kalmaktan
  //     iyi. Bu değişiklik SADECE applyUrl/description boşsa devreye giriyor — BCG'nin dolu
  //     applyUrl'i olduğu sürece davranışı değişmiyor.
  function buildPmiStyleDetailUrl(j){
    if(!j.jobId || !j.locale) return null;
    const parts = String(j.locale).split('_');
    if(parts.length !== 2) return null;
    const lang = parts[0].toLowerCase();
    const country = parts[1].toLowerCase();
    const slug = String(j.title || '').trim()
      .replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '') || 'job';
    return `${origin}/${country}/${lang}/job/${j.jobId}/${slug}`;
  }
  const enriched = [];
  for(const j of cityFiltered){
    const id = extractIdFromApplyUrl(j.applyUrl) || j.jobId || j.reqId || j.jobSeqNo || null;
    const guessedDetailUrl = j.applyUrl ? null : (buildPmiStyleDetailUrl(j) || (id ? `${origin}/global/en/job/${id}` : null));
    let description = j.description || j.jobDescription || '';
    const fetchTargetUrl = j.applyUrl || guessedDetailUrl;
    if(fetchTargetUrl && !description){
      try{
        const res = await fetch(fetchTargetUrl, {
          signal: AbortSignal.timeout(8000),
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36' }
        });
        if(res.ok){
          const html = await res.text();
          const jobPostings = findJobPostings(extractJsonLd(html));
          if(jobPostings.length && jobPostings[0].description) description = jobPostings[0].description;
        }
      }catch(e){ /* detay sayfası bulunamadı/farklı yapıda — açıklamasız devam */ }
      await new Promise(r => setTimeout(r, 150));
    }
    // Detay sayfasından da JSON-LD çıkmadıysa (PMI'de böyle — sayfa da muhtemelen client-side
    // render), en azından listedeki en temiz teaser metnini kullanıyoruz — hiç açıklamasız
    // kalmaktan (her alan "estimated" olmaktan) iyi.
    if(!description){
      description = j.descriptionTeaser || (j.ml_job_parser && (j.ml_job_parser.descriptionTeaser_ats || j.ml_job_parser.descriptionTeaser_first200)) || '';
    }
    // DÜZELTME (PMI — Eren'in fark ettiği hata): hem JSON-LD'nin description alanı hem de teaser
    // metinleri çoğunlukla HAM HTML taşıyor (ör. "<br />•    Du befindest dich…", "</strong>") —
    // bu satır olmadan guessRequirements bu ham metni işliyor ve evidence alıntılarının içine
    // "<br />", "•", "</strong>" gibi etiket artıkları karışıyordu (okunmaz + elle doğrulamayı
    // zorlaştırıyordu). Schönherr'de aynı sınıf hatayı çözerken kullandığımız aynı temizliği
    // burada da uyguluyoruz — script/style bloklarını içerikleriyle SİL, sonra kalan etiketleri
    // boşlukla değiştir. Bu, zaten düz metin gelen açıklamaları (BCG gibi) DEĞİŞTİRMİYOR (etiket
    // yoksa hiçbir şey silinmiyor), sadece HTML içeren siteleri (PMI gibi) düzeltiyor.
    // İKİNCİ DÜZELTME (ilk denemede hala sızıyordu — Eren'in gerçek terminaliyle doğrulandı):
    // PMI'nin teaser metni Bitpanda'daki gibi ÇİFT KODLANMIŞ geliyor — gerçek "<br />" yerine
    // literal "&lt;br /&gt;" metni. Etiket temizleme regex'leri gerçek "<...>" karakterlerini
    // arıyor, ama entity çözme (decodeHtmlEntities) bundan SONRA, guessRequirements'ın İÇİNDE
    // çalışıyordu — yani etiketler temizlik sırasında henüz "görünmez" haldeydi, temizlikten
    // SONRA decode edilince tekrar ortaya çıkıp evidence'a sızıyorlardı. Çözüm: entity'leri ÖNCE
    // (etiket temizliğinden önce) çözüyoruz — guessRequirements zaten zararsız bir ikinci
    // decodeHtmlEntities çağrısı daha yapacak ama metin bu noktada zaten düz metin olduğu için
    // hiçbir şeyi değiştirmeyecek.
    if(description){
      description = decodeHtmlEntities(description)
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<\/(p|div|li|br|tr|h[1-6])\s*>/gi, '\n')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<li[^>]*>/gi, '\n• ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n\s*/g, '\n')
        .trim();
    }
    enriched.push({ ...j, description, _fallbackUrl: guessedDetailUrl });
  }

  // DÜZELTME (PMI): company/companyName alanları da boş geliyor — BCG'de doluydu. Hiçbir alan
  // yoksa şirket adını tamamen boş bırakmak yerine, en azından site alan adından kaba bir tahmin
  // türetiyoruz (BMW/diğer entegrasyonlarda kullanılan "companyFromUrl" ile aynı mantık, burada
  // tekrarlandı çünkü o fonksiyon processUrl içinde daha SONRA hesaplanıyor, henüz erişilemiyor).
  const GENERIC_ATS_SUBDOMAINS = /^(www|careers?|jobs?|join|bewerbung|karriere|apply|talent|recruiting)$/i;
  // Alan adından türetilen tahmin bazen kısaltma/çirkin çıkıyor (ör. "join.pmicareers.com" →
  // "Pmi") — bilinen bir origin için burada düzgün tam adı vermek, genel tahmin mantığını
  // bozmadan sadece o siteyi düzeltiyor. Yeni bir Phenom sitesi eklenince company/companyName
  // alanı zaten doluysa bu haritaya hiç bakılmıyor (BCG'de olduğu gibi).
  const COMPANY_NAME_OVERRIDES = { 'https://join.pmicareers.com': 'Philip Morris International' };
  function deriveCompanyFromOrigin(o){
    if(COMPANY_NAME_OVERRIDES[o]) return COMPANY_NAME_OVERRIDES[o];
    try{
      const parts = new URL(o).hostname.split('.');
      const raw = GENERIC_ATS_SUBDOMAINS.test(parts[0]) && parts.length > 2 ? parts[1] : parts[0];
      return raw.replace(/-?gmbh$|-?ag$|-?kg$|careers?$/i,'').replace(/[-_]/g,' ').replace(/\b\w/g, c=>c.toUpperCase()) || null;
    }catch(e){ return null; }
  }

  return enriched.map(j => ({
    title: j.title || null,
    company: j.company || j.companyName || deriveCompanyFromOrigin(origin),
    location: j.location || null,
    datePosted: j.postedDate || j.dateCreated || null,
    description: j.description || '',
    url: j.applyUrl || j._fallbackUrl || null,
  }));
}

async function fetchSoftgardenJobs(origin){
  try{
    const res = await fetch(`${origin}/jobs/jobs.feed.json`, { signal: AbortSignal.timeout(8000) });
    if(!res.ok) return null;
    const data = await res.json();
    if(!data || data['@type'] !== 'DataFeed' || !Array.isArray(data.dataFeedElement)) return null;
    return data.dataFeedElement.map(el => {
      const job = (el && el.item) || {};
      const desc = job.description ? String(job.description).replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim() : '';
      const addr = job.jobLocation && job.jobLocation.address;
      const location = addr
        ? [addr.addressLocality, addr.addressRegion, addr.addressCountry].filter(l => l && l !== '-').join(', ')
        : null;
      return {
        title: job.title || null,
        company: (job.identifier && job.identifier.name) || null,
        location: location || null,
        datePosted: job.datePosted || null,
        description: desc,
        url: job.url || null,
      };
    });
  }catch(e){
    return null;
  }
}

// SmartRecruiters gibi platformların kendi beyan ettiği kıdem seviyesini "junior"/"senior"/null'a
// çevirir — bu bir TAHMİN değil, şirketin kendi verisi, o yüzden guessSeniority'den (başlık tahmini)
// daha güvenilir; varsa öncelik bu alır.
function mapExperienceLevel(raw){
  if(!raw) return null;
  const l = raw.toLowerCase();
  if(/intern|entry|associate|not_applicable/.test(l)) return 'junior';
  if(/mid_senior|senior|director|executive|principal/.test(l)) return 'senior';
  return null;
}

// API'den gelen ilanları al, şehre göre filtrele, deg/de/en/exp/wm tahmin et, Whittle'ın
// "Toplu İçe Aktar"ına yapıştırılabilir JSON olarak yazdır. Döndürdüğü boolean, çağıranın
// (main) eski tarayıcı-tabanlı akışa düşüp düşmeyeceğine karar vermesi için.
// 04.10: ATS API'si boş/hatalı dönünce (Personio'da XML beslemesi kapalı: Taylor Wessing, DEMNER, myneva…;
// Greenhouse'ta API 404: ImmoScout24) panonun HTML sayfasından ilan linkleri toplanıp her ilanın JSON-LD'si okunuyor.
const BOARD_FALLBACK = new Set(['personio', 'greenhouse', 'recruitee', 'lever', 'workable', 'smartrecruiters', 'onlyfy']);
// 15.10: Sıfır ilan veren şirketler için kendi uç noktaları (Microsoft, STRABAG, OeKB, Horváth, Binder Grösswang).
// Hepsi boş/başarısızsa null döner → runAtsPath "API boş" der, şirketin sitedeki ilanları kapanmaz.

// Microsoft (Eightfold PCSX): liste /api/pcsx/search?location=Austria (10'arlı sayfa), detay /api/pcsx/position_details.
async function fetchMicrosoftJobs(){
  const base = 'https://apply.careers.microsoft.com';
  const H = { ...RETAIL_UA, Accept: 'application/json' };
  const seen = new Map();
  for(let start = 0; start < 200; start += 10){
    let d;
    try{ const r = await fetch(`${base}/api/pcsx/search?domain=microsoft.com&query=&location=Austria&start=${start}`, { headers: H, signal: AbortSignal.timeout(20000) }); if(!r.ok){ console.log(`  ⚠️  Microsoft PCSX HTTP ${r.status}`); break; } d = (await r.json()).data || {}; }catch(e){ console.log(`  ⚠️  Microsoft PCSX: ${e.message}`); break; }
    const ps = Array.isArray(d.positions) ? d.positions : [];
    const before = seen.size;
    ps.forEach(p => { if(p && p.id && !seen.has(p.id)) seen.set(p.id, p); });
    if(!ps.length || seen.size === before || (d.count && seen.size >= d.count)) break;
    await sleep2(300);
  }
  if(!seen.size) return null;
  const out = [];
  for(const p of seen.values()){
    let det = {};
    try{ const r = await fetch(`${base}/api/pcsx/position_details?position_id=${p.id}&domain=microsoft.com&hl=en`, { headers: H, signal: AbortSignal.timeout(15000) }); if(r.ok) det = (await r.json()).data || {}; }catch(e){}
    const locs = [].concat(det.locations || p.locations || []).filter(Boolean);
    const ts = det.postedTs || p.postedTs;
    const emp = [].concat(det.efcustomTextEmploymentType || []).join(', ');
    out.push({ title: det.name || p.name, company: 'Microsoft', location: locs.join(' | ') || null,
      datePosted: ts ? new Date(ts * 1000).toISOString().slice(0, 10) : null,
      description: [stripHtmlToPlainText(String(det.jobDescription || '')), emp ? `Employment type: ${emp}` : ''].filter(Boolean).join('\n\n').slice(0, 9000),
      url: `${base}${p.positionUrl || det.positionUrl || '/careers/job/' + p.id}`, departmentNames: det.department ? [det.department] : [] });
    await sleep2(200);
  }
  console.log(`  Microsoft: ${out.length} ilan (Austria).`);
  return out;
}

// STRABAG: liste POST /inc/jobsuche_2026_v2.php (morejobs=0,1,2… her biri ~22 ilanlık HTML parçası, Wien 30 km);
// detayda JSON-LD yok → sayfa metni, çerez/YouTube ve "Wie geht es im Prozess weiter?" sonrası atılıyor.
async function fetchStrabagJobs(){
  const origin = 'https://jobboerse.strabag.at';
  const seen = new Map(); let stale = 0;
  for(let i = 0; i < 12; i++){
    const body = new URLSearchParams({ morejobs: String(i), search: '', taetigkeitsbereich: '', arbeitsbereich: '', beschaeftigungsart: '', jobfamilie: '',
      adresse: 'Wien, Österreich', radius: '30', latPost: '48.2082', lngPost: '16.3738', language: 'AT_DE', divisionID: '', konzernfirma: '',
      status: i === 0 ? '1' : '0', campaign: '', source: 'nosource', referer: '', countryCodes_get: '', letsprogress: '' });
    let h;
    try{ const r = await fetch(`${origin}/inc/jobsuche_2026_v2.php`, { method: 'POST', headers: { ...RETAIL_UA, Accept: 'text/html', 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin, Referer: `${origin}/jobs-overview.php` }, body, signal: AbortSignal.timeout(20000) }); if(!r.ok){ console.log(`  ⚠️  STRABAG HTTP ${r.status}`); break; } h = await r.text(); }catch(e){ console.log(`  ⚠️  STRABAG: ${e.message}`); break; }
    const before = seen.size;
    for(const part of h.split(/<div class="search-entry"/).slice(1)){
      const id = (part.match(/ReqId=(\d+)/) || [])[1]; if(!id || seen.has(id)) continue;
      const tags = [...part.matchAll(/class="search-entry__tag"[^>]*>([\s\S]*?)<\/span>/g)].map(x => decodeHtmlEntities(stripHtmlToPlainText(x[1])).trim());
      const title = decodeHtmlEntities(stripHtmlToPlainText((part.match(/search-entry__headline[^>]*>([\s\S]*?)<\/h4>/) || [])[1] || '')).trim();
      const firm = decodeHtmlEntities(stripHtmlToPlainText((part.match(/search-entry__text[^>]*>([\s\S]*?)<\/p>/) || [])[1] || '')).trim();
      if(title) seen.set(id, { id, title, firm, location: tags.find(t => /:/.test(t) && !/Job-ID/i.test(t)) || '', tags }); // "Österreich: Wien" / "Deutschland: Dresden" — ülke kalsın, AT filtresi ayıklasın
    }
    // morejobs=1 sunucuda 0 ile aynı sayfayı döndürüyor (2, 3 yeni) → "yeni yok" değil, sadece boş sayfada dur.
    if(!/ReqId=\d/.test(h)) break;
    stale = seen.size === before ? stale + 1 : 0; if(stale >= 2) break;
    await sleep2(400);
  }
  if(!seen.size) return null;
  const out = [];
  for(const j of seen.values()){
    if(isLehre(j.title)) continue;
    const url = `${origin}/job-detail.php?ReqId=${j.id}&language=AT_DE&source=nosource`;
    let description = '';
    try{
      const r = await fetch(url, { headers: { ...RETAIL_UA, Accept: 'text/html' }, signal: AbortSignal.timeout(15000) });
      if(r.ok){
        let t = stripHtmlToPlainText((await r.text()).replace(/<(script|style|nav|header|footer|form)\b[\s\S]*?<\/\1>/gi, ' '));
        t = t.replace(/Um die erteilte Einwilligung[\s\S]*?Einwilligen und abspielen/g, ' ').split(/Wie geht es im Prozess weiter\?/)[0];
        const k = t.indexOf(j.title.slice(0, 25)); description = (k > 0 ? t.slice(k) : t).replace(/[ \t]+/g, ' ').trim();
      }
    }catch(e){}
    out.push({ title: j.title, company: 'STRABAG', location: j.location || null, datePosted: null,
      description: [j.firm, j.tags.filter(t => !/Job-ID/i.test(t)).join(' · '), description].filter(Boolean).join('\n').slice(0, 9000), url, departmentNames: [] });
    await sleep2(250);
  }
  console.log(`  STRABAG: ${out.length} ilan (Wien +30 km, Lehre hariç).`);
  return out;
}

// OeKB grubu (sagedpw.at eski başvuru sistemi): liste <a data-ref="job" href="onlinebewerbung_detail.php?…">, şirket grubu
// "blocktitle" başlığında. Detay sade HTML. Initiativbewerbung atlanıyor. Tüm ilanlar Wien (Strauchgasse).
async function fetchSagedpwJobs(ats){
  const listUrl = ats.url, base = listUrl.replace(/[^\/]*$/, '');
  let h;
  try{ const r = await fetch(listUrl, { headers: { ...RETAIL_UA, Accept: 'text/html' }, signal: AbortSignal.timeout(20000) }); if(!r.ok){ console.log(`  ⚠️  sagedpw HTTP ${r.status}`); return null; } h = await r.text(); }catch(e){ console.log(`  ⚠️  sagedpw: ${e.message}`); return null; }
  const jobs = []; let group = '';
  const re = /class="blocktitle"[^>]*>([\s\S]*?)<\/div>|<a\b[^>]*data-ref="job"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g; let m;
  while((m = re.exec(h))){
    if(m[1] !== undefined){ group = decodeHtmlEntities(stripHtmlToPlainText(m[1])).replace(/ /g, ' ').trim(); continue; }
    const title = decodeHtmlEntities(stripHtmlToPlainText(m[3])).replace(/ /g, ' ').trim();
    if(!title || /initiativbewerbung/i.test(title)) continue;
    const url = new URL(m[2].replace(/&amp;/g, '&'), base).toString();
    if(!jobs.some(j => j.url === url)) jobs.push({ title, url, group });
  }
  if(!jobs.length) return null;
  const out = [];
  for(const j of jobs){
    let description = '';
    try{ const r = await fetch(j.url, { headers: { ...RETAIL_UA, Accept: 'text/html' }, signal: AbortSignal.timeout(15000) }); if(r.ok) description = stripHtmlToPlainText((await r.text()).replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')).replace(/[ \t]+/g, ' ').trim(); }catch(e){}
    out.push({ title: j.title, company: null, location: 'Wien, Österreich', datePosted: null,
      description: [j.group, description].filter(Boolean).join('\n').slice(0, 9000), url: j.url, departmentNames: [] });
    await sleep2(250);
  }
  console.log(`  sagedpw: ${out.length} ilan (Initiativbewerbung hariç).`);
  return out;
}

// Horváth: iş listesi <tr data-href="/…/job-detailseite/detail/<id>/"> satırlarında (link <a> değil → genel tarayıcı 0 buluyordu).
// İkinci hücre konum; sadece Avusturya şehirleri alınıyor. Detay sunucu tarafında HTML (<main>).
async function fetchHorvathJobs(ats){
  const u = new URL(ats.url);
  let h;
  try{ const r = await fetch(u.toString(), { headers: { ...RETAIL_UA, Accept: 'text/html' }, signal: AbortSignal.timeout(25000) }); if(!r.ok){ console.log(`  ⚠️  Horváth HTTP ${r.status}`); return null; } h = await r.text(); }catch(e){ console.log(`  ⚠️  Horváth: ${e.message}`); return null; }
  const AT = buildCityRegex('AT'), rows = new Map();
  for(const m of h.matchAll(/<tr[^>]*data-href="([^"]*job-detailseite[^"]*)"[^>]*>([\s\S]*?)<\/tr>/g)){
    const cells = [...m[2].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(x => decodeHtmlEntities(stripHtmlToPlainText(x[1])).replace(/\s+/g, ' ').trim());
    const title = (cells[0] || '').replace(/^\(R\d+\)\s*/, ''), location = cells[1] || '';
    const url = new URL(m[1], u.origin).toString();
    if(title && AT.test(location) && !rows.has(url)) rows.set(url, { title, location, url });
  }
  if(!rows.size) return null;
  const out = [];
  for(const j of rows.values()){
    let description = '';
    try{ const r = await fetch(j.url, { headers: { ...RETAIL_UA, Accept: 'text/html' }, signal: AbortSignal.timeout(15000) }); if(r.ok){ const d = await r.text(); description = stripHtmlToPlainText(((d.match(/<main[\s\S]*?<\/main>/i) || [d])[0]).replace(/<(script|style|nav|form)\b[\s\S]*?<\/\1>/gi, ' ')).replace(/[ \t]+/g, ' ').trim(); } }catch(e){}
    out.push({ title: j.title, company: 'Horváth', location: `${j.location}, Österreich`, datePosted: null, description: description.slice(0, 9000), url: j.url, departmentNames: [] });
    await sleep2(250);
  }
  console.log(`  Horváth: ${out.length} ilan (Avusturya).`);
  return out;
}

// Binder Grösswang: kariyer sayfası P&I "bewerber-web" ilanlarına #hash linkleriyle gidiyor (GWT-RPC, düz HTML yok; genel
// tarayıcı hash'i atınca 7 link tek URL'e iniyordu). Liste kendi sayfasından, metin her ilan headless tarayıcıda açılarak.
async function fetchBinderJobs(ats){
  let h;
  try{ const r = await fetch(ats.url, { headers: { ...RETAIL_UA, Accept: 'text/html' }, signal: AbortSignal.timeout(20000) }); if(!r.ok){ console.log(`  ⚠️  Binder HTTP ${r.status}`); return null; } h = await r.text(); }catch(e){ console.log(`  ⚠️  Binder: ${e.message}`); return null; }
  const jobs = new Map();
  for(const m of h.matchAll(/<a\b[^>]*href="(https:\/\/[a-z0-9-]+\.pi-asp\.de\/bewerber-web[^"]*#position[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)){
    const url = decodeHtmlEntities(m[1]); const txt = decodeHtmlEntities(stripHtmlToPlainText(m[2])).replace(/\s+/g, ' ').trim();
    // Sadece gerçek ilanlar: "(m/w/d)" içeren metin (Initiativbewerbung / "log in here" linkleri aynı sisteme gidiyor).
    if(!/\((?:m\/w\/d|w\/m\/d|m\/f\/d|f\/m\/d|all genders)\)/i.test(txt) || /initiativ/i.test(txt)) continue;
    if(!jobs.has(url)) jobs.set(url, { url, listText: txt });
  }
  if(!jobs.size) return null;
  let browser; const out = [];
  try{
    browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const pg = await browser.newPage();
    await pg.setUserAgent(RETAIL_UA['User-Agent']);
    for(const j of jobs.values()){
      let text = '';
      try{
        await pg.goto('about:blank');
        await pg.goto(j.url, { waitUntil: 'networkidle2', timeout: 45000 });
        await pg.waitForFunction(() => document.body && document.body.innerText.length > 600, { timeout: 15000 }).catch(() => {});
        text = await pg.evaluate(() => document.body.innerText);
      }catch(e){ console.log(`  ⚠️  Binder ilan açılamadı: ${e.message}`); }
      text = String(text || '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
      const title = j.listText.replace(/\s+Wien\s*$/, '').trim(); // "Rechtsanwaltsanwärter*in (m/w/d) - Immobilienrecht" — alan eki kalsın
      out.push({ title, company: 'Binder Grösswang', location: 'Wien, Österreich', datePosted: null, description: (text || j.listText).slice(0, 9000), url: j.url, departmentNames: [] });
    }
  }catch(e){ console.log(`  ⚠️  Binder tarayıcı: ${e.message}`); }
  finally{ if(browser) await browser.close().catch(() => {}); }
  console.log(`  Binder Grösswang: ${out.length} ilan.`);
  return out.length ? out : null;
}

async function fetchBoardHtmlFallback(boardUrl){
  let html = '', base;
  try{ base = new URL(boardUrl); const r = await fetch(boardUrl, { headers: { ...RETAIL_UA, Accept: 'text/html' }, signal: AbortSignal.timeout(20000) }); if(!r.ok) return []; html = await r.text(); }catch(e){ return []; }
  const links = new Map(), re = /<a\b[^>]*href="([^"#]+)"[^>]*>([\s\S]*?)<\/a>/gi; let m;
  while((m = re.exec(html)) && links.size < 60){
    let u; try{ u = new URL(m[1].replace(/&amp;/g, '&'), base); }catch(e){ continue; }
    if(u.hostname !== base.hostname) continue;
    if(!/\/(job|jobs|o|stelle|stellen|position|positions|vacancy|vacancies)\/[^\/?#]{2,}/i.test(u.pathname)) continue;
    const key = u.origin + u.pathname.replace(/\/$/, '');
    if(links.has(key) || key === (base.origin + base.pathname.replace(/\/$/, ''))) continue;
    const first = m[2].split(/<[^>]+>/).map(x => decodeHtmlEntities(x).trim()).filter(Boolean)[0] || '';
    links.set(key, first);
  }
  const out = [];
  for(const [url, anchorTitle] of links){
    let title = anchorTitle, location = '', description = '';
    try{
      const r = await fetch(url, { headers: { ...RETAIL_UA, Accept: 'text/html' }, signal: AbortSignal.timeout(15000) });
      if(r.ok){
        const h = await r.text(), jp = findJobPostings(extractJsonLd(h))[0];
        if(jp){
          title = jp.title || title; description = stripHtmlToPlainText(String(jp.description || ''));
          const jl = [].concat(jp.jobLocation || []).map(x => x && x.address).filter(Boolean);
          location = jl.map(a => [a.addressLocality, a.addressRegion, a.addressCountry && (a.addressCountry.name || a.addressCountry)].filter(x => typeof x === 'string' && x).join(', ')).join(' | ');
        }
        if(description.length < 200) description = stripHtmlToPlainText((h.match(/<main[\s\S]*?<\/main>/i) || [h])[0]).slice(0, 8000);
        if(!location){ const lm = description.slice(0, 3000).match(/\b(Wien|Vienna|Graz|Linz|Salzburg|Innsbruck|Klagenfurt)\b/); if(lm) location = lm[1] + ', Österreich'; }
      }
    }catch(e){}
    if(title) out.push({ title, company: null, location: location || null, datePosted: null, description: description.slice(0, 9000), url, departmentNames: [] });
    await sleep2(200);
  }
  return out;
}
async function runAtsPath(ats, sourceUrl, cityFilter){
  try{
    let jobs = null;
    try{ jobs = await fetchAtsJobs(ats); }catch(e){ console.log(`⚠️  ${ats.type} API çağrısı başarısız: ${e.message}`); }
    if(jobs && jobs.skipToday) return { ok: true, items: [] }; // geçici (bakım) — tarayıcıya düşme
    if((!jobs || !jobs.length) && BOARD_FALLBACK.has(ats.type) && sourceUrl){
      const fb = await fetchBoardHtmlFallback(sourceUrl);
      console.log(`  ↪︎ ${ats.type} API boş — pano HTML'inden ${fb.length} ilan okundu.`);
      if(fb.length) jobs = fb;
    }
    if(!jobs || !jobs.length){
      console.log(`⚠️  ${ats.type} API boş sonuç döndürdü (ilan yok, token/filtre yanlış olabilir, ya da site bot korumasıyla isteği reddetmiş olabilir).`);
      return { ok: false, items: [] };
    }
    const filtered = jobs.filter(j => j.location && buildCityRegex(cityFilter).test(j.location));
    if(!filtered.length){
      console.log(`❌ ${ats.type} API'den ${jobs.length} ilan geldi ama hiçbiri "${cityFilter}" içermiyor (konumu boş/eşleşmeyenler elendi).`);
      console.log(`   [teşhis] örnek konumlar: ${jobs.slice(0, 5).map(j => JSON.stringify(j.location || null)).join(' | ')}`);
      return { ok: true, items: [] }; // API çalıştı, sadece filtre boş döndü — eski akışa düşmenin anlamı yok
    }
    const withGuess = filtered.map(j => {
      const req = guessRequirements(j.description);
      return {
        title: j.title, companyName: j.company, sourceNote: j.location, postedAt: postedDay(j.datePosted),
        // DÜZELTME: eskiden her ilana AYNI externalUrl (sourceUrl — API çağrısını tetikleyen
        // sayfa) atanıyordu, ilanın kendi gerçek linki (j.url, zaten her fetch*Jobs fonksiyonu
        // döndürüyor) yok sayılıyordu. Tek ilan dönen entegrasyonlarda fark etmiyordu ama
        // MediaMarkt/Schönherr/McKinsey gibi TEK çağrıda ONLARCA ilan dönenlerde hepsi aynı linke
        // gidiyordu. j.url varsa onu kullan, yoksa (bazı entegrasyonlarda hâlâ olabilir) eskisi
        // gibi sourceUrl'e düş — geriye dönük hiçbir şeyi bozmuyor.
        externalUrl: j.url || sourceUrl, ...req.guess, estimated: req.estimated, evidence: req.evidence,
        nicheGuess: mapDepartmentToNiche(j.departmentNames) || guessNiche(`${j.title || ''} ${j.description || ''}`),
        seniorityGuess: mapExperienceLevel(j.experienceLevelRaw) || guessSeniority(j.title),
        _rawText: req._text,
      };
    });
    const { included, excluded } = splitByTargetFit(withGuess);
    console.log(`✅ ${ats.type} API üzerinden ${withGuess.length} ilan bulundu (${jobs.length} toplamdan, "${cityFilter}" filtresiyle) → aşağıdaki bloğu Whittle "Toplu İçe Aktar"a yapıştır (senior görünenler çıkarıldı):\n`);
    if(!process.env.CI) console.log(JSON.stringify(included, null, 2)); // 13.10: repo public – GitHub log'larına ilan metni basılmasın
    printExcludedSenior(excluded);
    return { ok: true, items: withGuess };
  }catch(e){
    console.log(`⚠️  ${ats.type} API çağrısı başarısız: ${e.message}`);
    return { ok: false, items: [] };
  }
}

// Yedek plan: JobPosting JSON-LD hiç yoksa (bazı siteler bunu da eklemiyor), sayfada görünen
// ilan başlıklarını en azından TAHMİN ETMEYE çalışıyoruz — link metinlerinden, "Praktikum",
// "Werkstudent", "Intern" gibi kelimeler geçen linkleri toplayarak. Bu kesin değil, ham bir
// yedek — ama hiç veri almaktan iyidir.
async function fallbackScanLinks(page){
  return page.evaluate(() => {
    const textKeywords = /praktik|werkstudent|intern|junior|trainee|stelle|job|mehr erfahren|read more|learn more|view (this )?job|view details|details ansehen/i;
    // DÜZELTME (Generali): Gatsby ile kurulmuş bazı siteler her ilan kartında SADECE jenerik
    // "Mehr erfahren"/"Read more" linki kullanıyor — ne href'te ayırt edici bir segment (/job/,
    // /stelle/ vb.) var, ne link metninde staj/kariyer kelimelerinden biri. Bu jenerik kalıp normalde
    // riskli (bir sayfada ilan dışı "devamını oku" linkleri de yakalanabilir) ama her ilan zaten kendi
    // sayfasında ayrıca işlendiği (JSON-LD/etiketli alan/vb.) için yanlış yakalanan bir link en kötü
    // ihtimalle düşük-güvenli/anlamsız bir kayıt üretir, veriyi bozmaz.
    // DÜZELTME: eskiden sadece LİNK METNİ bu kelimelerden birini içeriyorsa yakalıyorduk — ama
    // "Steuerberater:in International Tax - Transfer Pricing" gibi genel bir ilan başlığı bu
    // kelimelerin hiçbirini içermez, hep atlanıyordu. Artık HREF'in kendisi de kontrol ediliyor
    // (ör. .../job/... , .../jobs/... , .../career/... , .../vacancy/... , .../stelle/...) —
    // DÜZELTME 2: "/career/" ve "/careers/" kalıbı ÇOK genel — EY gibi sitelerde HER kurumsal
    // sayfa (blog, kültür sayfası, etkinlikler vb.) URL'inde "/careers/" geçiyor, bu yüzden gerçek
    // ilan yerine navigasyon linkleri toplanıyordu. Bunları listeden çıkarıp sadece ilan
    // DETAYINA özgü kalıpları bıraktık (ör. .../job/..., .../jobdetail/..., .../stelle/...).
    // DÜZELTME (Helvetia): "/offene-stellen/{slug}/{uuid}" formatı eskiden hiç yakalanmıyordu —
    // "stelle" segmenti tam eşleşme istiyor, "offene-stellen" farklı bir segment. Sonuç: sadece
    // başlığında "Praktikum" gibi bir textKeywords kelimesi geçen ilanlar (şans eseri) yakalanıyor,
    // "Sachbearbeiter", "Vertriebstrainer" gibi diğer TÜM ilanlar sessizce eleniyordu (Helvetia'da
    // 9 Wien ilanından sadece 1'i bulunuyordu). "offene-stellen(?:$)" segmentini de ekliyoruz.
    const hrefKeywords = /\/(job|jobs|jobdetail|job-detail|vacanc|position|stelle|stellenangebot|offene-stellen?)\//i;
    // DÜZELTME (OeKB): bazı eski/legacy başvuru sistemleri (ör. "sagedpw.at" tabanlı OeKB'nin
    // sitesi) ilan detay linklerini path SEGMENTİ olarak değil, query parametresi olarak kodluyor
    // — ör. "onlinebewerbung_detail.php?template=1&objnr=88451". hrefKeywords bunu hiç yakalamıyordu
    // (path'te "stelle"/"job" geçmiyor), textKeywords ise sadece "Stabsstelle"/"Praktikum" gibi
    // İÇİNDE şans eseri anahtar kelime geçen başlıkları yakalayıp "Data Engineer" gibi diğer
    // ilanların hepsini kaçırıyordu. "objnr=" gibi ayırt edici, ilan-sistemi-özel query
    // parametrelerini de bir sinyal olarak EKLİYORUZ (mevcut kontrollerden hiçbirini kaldırmıyoruz,
    // sadece bir OR koşulu daha ekliyoruz — başka hiçbir sitede bir şeyi ELEMEZ, en kötü ihtimalle
    // ilgisiz bir link daha yakalanır ki bu zaten sistemin tolere ettiği bir durum, bkz. Generali notu).
    const hrefQueryKeywords = /[?&](objnr|jobid|job_id|stellenid|positionid|vacancyid)=/i;
    // DÜZELTME 3: bazı sitelerde (ör. BDO) kategori/filtre GEZİNME sayfaları da aynı "/jobs/"
    // yolunun altında yaşıyor (ör. "/jobs/fachbereiche/tax", "/jobs/orte/wien") — bunlar gerçek
    // bir ilan DEĞİL, bir filtre sayfası. Düz-metin fallback bunları yanlışlıkla "ilan" sanıp
    // çöp veri üretiyordu ("Fachbereiche" başlıklı sahte ilanlar gibi). Bunları hariç tutuyoruz.
    // DÜZELTME (OeKB): "objnr=" gibi genel query-parametresi sinyalini eklediğimizde, her ilan
    // detay sayfasındaki "JETZT ONLINE BEWERBEN" (başvuru FORMU) linki de yanlışlıkla ayrı bir
    // "ilan" sanılıp toplandı — o link de aynı objnr'yi taşıyor ama bir iş ilanı DEĞİL, bir form.
    // "formular" (Almanca "form") kelimesi geçen path'leri dışlıyoruz — dar ve güvenli bir terim,
    // gerçek bir ilan URL'inde neredeyse hiç geçmez.
    const navPathExclude = /\/jobs\/(fachbereiche|orte)(\/|$|#|\?)|\/jobs\/?(\?|#|$)|\/(list-of-all-jobs|list-of-jobs|my-basket-of-jobs|all-rss-feeds|my-account|my-subscription)\.aspx|formular|job-?alert|newsletter|registrationmethods|searchjobs\/?(\?|#|$)|\/login|merkliste|impressum|datenschutz/i;
    // (27.09) Bilinen ilan-detay URL kalıpları: rexx "…-j1234.html", Avature "/JobDetail/", SuccessFactors
    // "/job/<slug>/<id>/", Cornerstone "/requisition/<id>", Personio "/job/<id>", WordPress "/jobportal/<id>".
    // Sayfada bunlardan en az biri varsa SADECE bunlar alınıyor — menü/filtre linkleri ilan sanılmasın.
    const strongDetail = /-j\d+\.html|\/jobdetail\/|\/job\/[^\/?#]+\/\d{5,}\/?|\/requisition\/\d+|\/job\/\d{4,}|\/jobportal\/\d+/i;
    // DÜZELTME (Red Bull): bazı SPA'lar ilan kartını metin/href tahminiyle YAKALANAMAYACAK
    // şekilde işaretliyor — "Außendienst Gastronomie / Musketeer" gibi bir başlıkta ne
    // textKeywords'teki kelimelerden biri var, ne href'te bilinen bir segment (/job/, /stelle/
    // vb.) var, o yüzden sessizce eleniyordu. Ama Red Bull kartın <a> elementinin kendisine
    // data-id="job-card" gibi KESİN bir yapısal işaret koyuyor — bu, kelime tahmininden çok daha
    // güvenilir bir sinyal. data-id/data-testid/data-cy/data-qa öznitelik DEĞERİNDE "job" geçen
    // her <a href> elementini, metin/href kalıbı tutmasa bile ilan sayıyoruz.
    function hasJobDataAttr(el){
      if(!el || !el.attributes) return false;
      return Array.from(el.attributes).some(attr =>
        /^data-(id|testid|cy|qa)$/i.test(attr.name) && /job/i.test(attr.value)
      );
    }
    const links = Array.from(document.querySelectorAll('a'));
    const seen = new Set();
    const out = [];
    links.forEach(a => {
      const text = (a.textContent || '').trim();
      const href = a.href || '';
      if(navPathExclude.test(href)) return;
      const matches = (text && textKeywords.test(text)) || hrefKeywords.test(href) || hrefQueryKeywords.test(href) || strongDetail.test(href) || hasJobDataAttr(a);
      if(matches && text && text.length < 120 && !seen.has(href || text)){
        seen.add(href || text);
        out.push({ text, href });
      }
    });
    const strong = out.filter(l => strongDetail.test(l.href || ''));
    return strong.length >= 2 ? strong : out;
  });
}

// SAP SuccessFactors Career Site Builder sayfalarında <h1> genelde ilan başlığı DEĞİL (KPMG'de
// "Kontakt" gibi alakasız bir şey çıktı — muhtemelen sayfanın gizli bir bölümünün h1'i). Gerçek
// başlık, sayfanın görünen metninde "Link zu Stellenbenachrichtigungen" (ya da İngilizce "Job
// Alert Link") ile "Jetzt bewerben" ("Apply now") arasında duruyor — bu iki etiket de Career
// Site Builder'ın sabit arayüz metni, ilan başlığı bunların arasında kalıyor.
function extractSfJobTitle(text){
  const anchors = ['Link zu Stellenbenachrichtigungen', 'Job Alert Link', 'Stellenbeschreibung', 'Job Description'];
  for(const anchor of anchors){
    const re = new RegExp(`${anchor}\\s*(.{3,150}?)\\s*(?:Jetzt bewerben|Apply now|Apply Now)\\b`, 'i');
    const m = text.match(re);
    if(m && m[1].trim().length >= 3) return m[1].trim();
  }
  // Avature (ör. UniCredit) da <h1>'i site logosu için kullanıyor (KPMG'deki gibi yanlış), ama
  // kendi kalıbı ters yönde: başlık, "General Information" bölümünden HEMEN ÖNCE "Apply as {başlık}"
  // şeklinde geliyor.
  const avature = text.match(/Apply as\s+(.{3,150}?)\s+General Information/i);
  if(avature && avature[1].trim().length >= 3) return avature[1].trim();
  // DÜZELTME (24 Eylül — UniCredit): bazı Avature sayfaları "Apply as...General Information"
  // akışına hiç girmiyor, direkt başvuru sihirbazına ("Select resume" adımı) düşüyor — bu durumda
  // başlık, sabit pazarlama başlığı "FOR EUROPE'S FUTURE" ile sihirbazın ilk adımı ("Select resume")
  // arasında kalıyor. Eskiden bu kalıp yakalanamayınca title dump.title'a ("UniCredit" gibi
  // anlamsız bir sekme başlığına) düşüyordu.
  const unicredit = text.match(/FOR EUROPE'S FUTURE\s*(.{3,150}?)\s*Select resume/i);
  if(unicredit && unicredit[1].trim().length >= 3) return unicredit[1].trim();
  return null;
}

// Bazı kurumsal ATS'ler (ör. SAP SuccessFactors Career Site Builder — KPMG'nin bewerbung.kpmg.at
// sayfasında gördüğümüz gibi) JSON-LD koymuyor ama sayfanın görünen metninde çok tutarlı
// "Etiket: Değer" alanları bırakıyor: "Standort(e): Linz Level der Erfahrung: Professional
// Voll- oder Teilzeit: Vollzeit oder Teilzeit" gibi. Bu TAHMİN değil — sayfanın kendi beyanı,
// JSON-LD/Personio kalıpları tutmadığında son bir çare olarak deniyoruz. Platform bağımsız
// (regex etiketlere bakıyor, KPMG'ye özel bir şey değil) — aynı Career Site Builder kalıbını
// kullanan başka kurumsal sitelerde de tutması bekleniyor.
const LABELED_FIELDS = [
  { key: 'startDate', labels: ['Startdatum', 'Start Date', 'Datum'] },
  { key: 'location', labels: ['Standort\\(e\\)', 'Standort', 'Primary Work Location', 'Location\\(s\\)', 'Location', 'Stadt', 'City', 'Dienstort'] },
  { key: 'levelRaw', labels: ['Level der Erfahrung', 'Experience Level', 'Dienstalter', 'Job Type'] },
  { key: 'employmentType', labels: ['Voll-\\s*oder\\s*Teilzeit', 'Employment Type', 'Anstellungsart', 'Positionstyp', 'Working time model', 'Arbeitszeitausmaß'] },
];
// Sadece SINIR olarak kullanılan, değer olarak hiç ÇIKARILMAYAN ek etiketler — yakalamanın
// şirkete özel, bizim listemizde olmayan sonraki alanları da yutup aşırı uzun/kirli bir değer
// üretmesini engellemek için (ör. EY'de "Standort: Vienna Anderer Ort: ... Gehalt: ..." — bunlar
// olmadan "Standort" değeri tüm bu metni yutuyordu).
const BOUNDARY_ONLY_LABELS = ['Anderer Ort', 'Gehalt', 'Salary', 'Jobbeschreibung', 'Job Description', 'Stellenanzeigen ID', 'Requisition ID', 'Job ID', 'Arbeitsmodus', 'Geschlecht', 'Positionstyp', 'Country', 'Competence Line', 'Functional area', 'Contact', 'Company', 'Stundenausmaß', 'Mindestgehalt', 'Category', 'Work Shift', 'Additional Locations', 'Work area\\(s\\)', 'Team', 'Berufsfeld', 'Unternehmen'];
function parseLabeledFields(text){
  const allStopLabels = [...LABELED_FIELDS.flatMap(f => f.labels), ...BOUNDARY_ONLY_LABELS].join('|');
  const result = {};
  for(const field of LABELED_FIELDS){
    for(const label of field.labels){
      // Önce ":" ile dene — daha kesin, düzyazı içinde tesadüfen geçen aynı kelimeyle
      // karışmasını önler (KPMG/EY/OMV/RBI bu şekilde). Bulamazsa ":"sız dene — bazı platformlar
      // (ör. VIG'in kullandığı d.vinci) etiket ile değeri hiç ayraç olmadan yan yana yazıyor
      // ("Stadt Wien Dienstalter mit Berufserfahrung...").
      const reColon = new RegExp(`${label}\\s*:\\s*(.+?)(?=\\s*(?:${allStopLabels})\\s*:|\\s*#|$)`, 'i');
      const reNoColon = new RegExp(`\\b${label}\\s+(.+?)(?=\\s+(?:${allStopLabels})\\b|\\s*#|$)`, 'i');
      const m = text.match(reColon) || text.match(reNoColon);
      if(m){ result[field.key] = m[1].trim().slice(0, 100); break; }
    }
  }
  return Object.keys(result).length ? result : null;
}
// levelRaw (şirketin kendi beyan ettiği metin, ör. "Professional", "Einsteiger:in / Professional")
// junior/senior'a çevirir. Bu da bir eşleme/TAHMİN — şirketin ne demek istediğini kesin bilemeyiz,
// ama "Einsteiger" (giriş seviyesi) kelimesi olmadan sadece "Professional" geçmesi, genelde en
// azından tam yeni mezun/staj seviyesinde olmadığının bir işareti.
function mapLevelRaw(raw){
  if(!raw) return null;
  const l = raw.toLowerCase();
  const hasEntry = /einsteiger|entry|intern|praktik|trainee|graduate|ohne berufserfahrung/.test(l);
  const hasSenior = /professional|senior|manager|expert|director|partner|principal|mit berufserfahrung/.test(l);
  if(hasEntry && !hasSenior) return 'junior';
  if(hasSenior && !hasEntry) return 'senior';
  return null; // "Einsteiger:in / Professional" gibi karma bir bant — belirsiz, elle bakılmalı
}

// Yedek plan 2: Ne JobPosting JSON-LD ne de ilan-linki bulunamazsa, en azından sayfanın GÖRÜNEN
// metnini (başlık + ana içerik) ham olarak döküyoruz — otomatik alan doldurmaz ama en azından
// "tarayıcıda sayfayı aç, oku, kopyala" adımını tek komuta indiriyor.
async function dumpVisibleText(page){
  return page.evaluate(() => {
    const h1 = document.querySelector('h1');
    const h1Text = h1 && h1.textContent.trim();
    // DÜZELTME (OeKB'nin eski başvuru sistemi — sagedpw.at): bazı legacy sitelerde <h1> ya hiç
    // yok ya da boş, gerçek ilan başlığı <h2> gibi başka bir etikette. Eskiden h1 boşsa direkt
    // document.title'a düşülüyordu — ama O DA boş olabiliyor (bu sitede öyleydi), sonuç: başlıksız
    // sayfa, "düşük güvenle TEK ilan" yedeği devreye giremiyordu. h1 → h2 → document.title sırası
    // eklendi. Bu SADECE h1 boş/yoksa devreye giriyor — h1'i olan hiçbir sitede davranış değişmiyor.
    const h2 = document.querySelector('h2');
    const h2Text = h2 && h2.textContent.trim();
    const h3 = document.querySelector('h3');
    const h3Text = h3 && h3.textContent.trim();
    // script/style/nav/footer gibi gürültüyü at, ana içerik alanını tahmin et (title tahmininde de
    // kullanacağımız için text'i BURAYA, title hesabından ÖNCE taşıdık)
    const clone = document.body.cloneNode(true);
    clone.querySelectorAll('script,style,nav,footer,header').forEach(el => el.remove());
    // DÜZELTME: eski limit (4000 karakter) bazı sayfalarda (ör. EY — uzun cookie-banner metni +
    // tekrarlanan dil seçici/menü <nav>/<header> DIŞINDA <div> içinde olduğu için silinmiyor)
    // gerçek ilan içeriğine (Must-haves, dil seviyesi, deneyim şartı gibi) hiç ulaşamadan kesiyordu
    // — guessRequirements() bu yüzden boş dönüyordu. Limit büyütüldü; ekrana basarken ayrıca
    // kısaltılıyor (aşağıda), o yüzden konsolu spamlamıyor.
    // DÜZELTME: Bain gibi devasa navigasyon menüsü olan sitelerde (80+ ofis, 2 kez tekrarlanan
    // erişilebilirlik listesi) 20000 karakter bile yetmiyor — asıl ilan verisi (ör. şehir listesi)
    // bu sınırın dışında kalabiliyor. Daha da büyütüldü.
    const text = clone.textContent.replace(/\s+/g, ' ').trim().slice(0, 60000);
    // 29.09: Apply'daki ilan analizi madde yapısına ihtiyaç duyuyor. Blok öğelerin önüne satır sonu
    // koyup ikinci bir, satırları KORUNMUŞ metin üretiyoruz (sadece _adText için kullanılıyor).
    let lines = '';
    try{
      const c2 = clone.cloneNode(true);
      c2.querySelectorAll('br').forEach(el => el.replaceWith('\n'));
      c2.querySelectorAll('li,p,h1,h2,h3,h4,h5,h6,div,tr,section,article,dt,dd').forEach(el => el.insertAdjacentText('afterbegin', '\n'));
      lines = c2.textContent.replace(/[ \t\u00a0]+/g, ' ').replace(/ *\n[\s]*/g, '\n').trim().slice(0, 60000);
    }catch(e){}
    // DÜZELTME (OeKB — template=1 sayfaları): h1/h2/h3 VE document.title'ın HEPSİ boş olduğu
    // durumlar var (bu sitede öyleydi) — eskiden bu durumda başlıksız kalıp "düşük güvenle TEK
    // ilan" yedeği hiç devreye giremiyordu, ilan tamamen atlanıyordu. Almanca/Avusturya ilanlarında
    // ÇOK yaygın bir kalıp var: başlık, metnin EN BAŞINDA bir cinsiyet-etiketiyle ("(w/m/d)",
    // "(m/w/d)" vb.) bitiyor, hemen ardından boşluksuz asıl metin geliyor — "Data Engineer
    // (w/m/d)Du hast..." gibi. Bunu SADECE h1/h2/h3 hepsi boşsa deniyoruz (document.title'dan bile
    // ÖNCE — çünkü bu site document.title'a jenerik "Onlinebewerbung Detail" gibi ALAKASIZ bir
    // metin koyuyordu, metinden çıkarılan gerçek başlık her zaman ondan daha isabetli). Sadece
    // metnin İLK 150 karakterinde arıyoruz ki yanlışlıkla sayfanın ortasından bir eşleşme almayalım.
    let textBasedTitle = null;
    if(!h1Text && !h2Text && !h3Text){
      const genderTagMatch = text.slice(0, 150).match(/^.{3,100}?\((?:w\/m\/d|m\/w\/d|f\/m\/d|m\/f\/d|w\/m\/x|m\/w\/x|all genders?)\)/i);
      if(genderTagMatch) textBasedTitle = genderTagMatch[0].trim();
    }
    let title = h1Text || h2Text || h3Text || textBasedTitle || document.title;
    // 30.09: ilk başlık çoğu zaman ilan değil: şirket adı (Frequentis), slogan ("Mitmachen und mehr bewegen" —
    // Johanniter) ya da kutu başlığı ("Job details" — Siemens). Sayfanın kendi <title>/og:title'ı ise ilanın adını
    // taşıyor. Önce <title>/og:title içinde geçen bir h1/h2/h3'ü seçiyoruz; yoksa ve ilk başlık şüpheliyse og:title.
    try{
      const og = ((document.querySelector('meta[property="og:title"]') || {}).content || '').trim();
      const site = ((document.querySelector('meta[property="og:site_name"]') || {}).content || '').trim().toLowerCase();
      const docT = (document.title || '').trim();
      const ref = `${og} ${docT}`.toLowerCase().replace(/\s+/g, ' ');
      const heads = [...document.querySelectorAll('h1,h2,h3')].map(h => h.textContent.replace(/\s+/g, ' ').trim()).filter(h => h.length >= 4 && h.length <= 150);
      const hostWord = location.hostname.replace(/^(www|jobs|karriere|careers?)\./, '').split('.')[0].toLowerCase();
      const GENERIC = /^(job ?details?|stellen(angebot|anzeige|beschreibung)|jobangebot|jobbeschreibung|karriere|careers?|jobs?|details?|overview|übersicht|offene stellen|job description|position details)$/i;
      const suspicious = t => !t || GENERIC.test(t) || t.toLowerCase() === site || t.toLowerCase() === hostWord || t.toLowerCase().replace(/[^a-z]/g, '') === hostWord;
      const inRef = heads.find(h => !suspicious(h) && ref.includes(h.toLowerCase()));
      if(inRef) title = inRef;
      else if(suspicious(title) || !heads.length){
        const cleanDoc = docT.split(/\s+[|–]\s+|\s+-\s+(?:job detail|karriere|careers?|jobs?)\b/i)[0].trim();
        const alt = [og, cleanDoc].find(x => x && x.length >= 4 && !suspicious(x));
        if(alt) title = alt;
      }
    }catch(e){}
    return { title, text, lines };
  });
}

// DÜZELTME: bazı kurumsal siteler (ör. Erste Group) meta açıklama etiketine SEO için yapılandırılmış
// bir özet koyuyor: "Company: X, Location: Y, Posted since: Z". Bu, görünen metindeki "Dienstort:"
// taramasından DAHA GÜVENİLİR olabiliyor — özellikle sayfa "benzer ilanlar" gibi başka şehirlerin de
// geçtiği widget'lar içeriyorsa, serbest metin taraması yanlış şehri yakalayabiliyor (Erste'nin
// Altach'taki bir şubesini "Wien" sanması gibi — meta etiketi "Location: Altach" diyordu, gerçek).
async function extractMetaLocation(page){
  try{
    const desc = await page.evaluate(() => {
      const el = document.querySelector('meta[property="og:description"]') || document.querySelector('meta[name="description"]');
      return el ? el.getAttribute('content') : null;
    });
    if(!desc) return null;
    const m = desc.match(/Location:\s*([^,]+?)\s*,\s*(?:Posted|$)/i);
    return m && m[1].trim() ? m[1].trim() : null;
  }catch(e){ return null; }
}

// Bir siteyi denemeden ÖNCE robots.txt'ini kontrol eder — "User-agent: *" bloğunda hedef URL'in
// path'ini kapsayan bir "Disallow:" kuralı varsa, o site otomatik erişimi açıkça istemiyor
// demektir (Deloitte'ta gördüğümüz gibi). Böyle bir durumda o siteyi hiç denemiyoruz. robots.txt
// yoksa/okunamıyorsa engelli SAYMIYORUZ (aşırı temkinli olup çalışan siteleri de engellemeyelim).
async function isDisallowedByRobots(url){
  try{
    const u = new URL(url);
    const robotsUrl = `${u.protocol}//${u.host}/robots.txt`;
    const res = await fetch(robotsUrl, { signal: AbortSignal.timeout(5000) });
    if(!res.ok) return false;
    const text = await res.text();
    let inWildcardBlock = false;
    const disallows = [];
    for(const rawLine of text.split(/\r?\n/)){
      const line = rawLine.split('#')[0].trim(); // yorumları at
      if(!line) continue;
      const sep = line.indexOf(':');
      if(sep === -1) continue;
      const key = line.slice(0, sep).trim().toLowerCase();
      const value = line.slice(sep + 1).trim();
      if(key === 'user-agent') inWildcardBlock = (value === '*');
      else if(inWildcardBlock && key === 'disallow' && value) disallows.push(value);
    }
    const path = u.pathname || '/';
    return disallows.some(rule => path.startsWith(rule));
  }catch(e){
    return false; // robots.txt kontrolü başarısız olursa engelli varsaymıyoruz
  }
}

// Tek bir URL'i işler — direkt/gömülü ATS, JSON-LD, ya da chunk-split akışlarından hangisi
// tutarsa onu kullanır. Her çıkış noktasında { items } döndürür ki hem tekli çalıştırmada hem
// de --batch modunda (main) sonuçlar aynı şekilde toplanabilsin; konsola yazdırma (görünürlük
// için) her zaman olduğu gibi devam ediyor.
// DÜZELTME (1sa39dk süren crawl'ın asıl nedeni — CRAWL_CONCURRENCY şirketler-arası paralelliği
// çözmüştü ama asıl maliyet burada: her ilan linki için (ATS API/softgarden/Phenom yoluyla
// gitmeyen, tarayıcıya düşen HER URL için) YENİ bir Puppeteer tarayıcı süreci açılıp kapatılıyordu.
// Chrome'un soğuk başlatma maliyeti (~1-3sn) + sayfa yükleme, yüzlerce ilan linki üzerinden
// çarpınca sürenin büyük kısmını yiyordu — şirketler arası paralellikten bağımsız bir maliyet.
// Artık isteğe bağlı bir `sharedBrowser` parametresi alıyor: runCrawl tek bir tarayıcıyı bir kere
// açıp tüm ilan linkleri (ve liste sayfası taraması) için yeniden kullanıyor, sadece en sonda
// kapatıyor. Diğer çağıranlar (runBatch, --url modu) hâlâ parametre vermeden çağırıyor — o yollarda
// davranış (kendi tarayıcısını açıp kapatması) hiç değişmedi.
async function processUrl(url, cityFilter, sharedBrowser, ctx){
  if(await isDisallowedByRobots(url)){
    console.log(`🚫 ${new URL(url).host} — robots.txt bu sitede otomatik erişimi yasaklıyor, atlanıyor. Bu şirket için elle giriş ya da doğrudan izin istemek gerekiyor.`);
    return { items: [] };
  }

  // URL'in kendisi zaten bir Greenhouse/Lever adresiyse tarayıcıya hiç gerek yok —
  // doğrudan API'den çek, çok daha hızlı ve güvenilir.
  const directAts = detectAtsFromUrl(url);
  if(directAts){
    directAts.cityFilter = cityFilter;
    // DÜZELTME: bmw gibi "token" alanı olmayan ATS tiplerinde bu satır "undefined" yazdırıyordu —
    // kozmetik bir hataydı (çıktıyı/işlevi etkilemiyordu), ama kafa karıştırıcıydı. Her tipin kendi
    // tanımlayıcı alanını göstersin diye küçük bir seçim yapıyoruz.
    const idLabel = directAts.token || directAts.subdomain || directAts.citySlug || directAts.filters || '';
    // Bain kendi API'si için bile Puppeteer açıyor (bot koruması yüzünden) — diğerlerinden farklı
    // olarak "tarayıcı açılmadan" demek yanlış olur, ona göre mesajı ayırıyoruz.
    const browserNote = directAts.type === 'bain' ? '(bot koruması nedeniyle Puppeteer üzerinden, ama Node fetch değil)' : 'tarayıcı açılmadan doğrudan API kullanılıyor';
    console.log(`ATS tespit edildi (URL'den): ${directAts.type} / "${idLabel}" — ${browserNote}.\n`);
    const result = await runAtsPath(directAts, url, cityFilter);
    if(result.ok) return { items: result.items };
    console.log('API yolu başarısız oldu — bu URL Greenhouse/Lever gibi görünüyor ama API yanıt vermedi, tekrar dene ya da URL/token\'ı kontrol et.\n');
    return { items: [] };
  }

  // softgarden'ın sabit bir alan adı yok, bu yüzden her URL için "dene" — çoğu sitede boş/404
  // dönüp zararsızca devam edecek, ama softgarden ise (Volksbank Wien'de olduğu gibi) tarayıcıya
  // hiç gerek kalmadan TÜM ilanları tek istekte alırız.
  const softgardenOrigin = (() => { try{ return new URL(url).origin; }catch(e){ return null; } })();
  const softgardenJobs = softgardenOrigin ? await fetchSoftgardenJobs(softgardenOrigin) : null;
  if(softgardenJobs){
    const filtered = softgardenJobs.filter(j => j.location && buildCityRegex(cityFilter).test(j.location));
    if(!filtered.length){
      console.log(`❌ softgarden feed'inde ${softgardenJobs.length} ilan bulundu ama hiçbiri "${cityFilter}" içermiyor.`);
      return { items: [] };
    }
    const items = filtered.map(j => {
      const req = guessRequirements(j.description);
      return {
        title: j.title, companyName: j.company, sourceNote: j.location, externalUrl: j.url || url, postedAt: postedDay(j.datePosted),
        ...req.guess, estimated: req.estimated, evidence: req.evidence,
        nicheGuess: guessNiche(`${j.title || ''} ${j.description || ''}`),
        seniorityGuess: guessSeniority(j.title),
        _rawText: req._text,
      };
    });
    const { included, excluded } = splitByTargetFit(items);
    console.log(`ATS tespit edildi (softgarden, feed üzerinden): tarayıcı açılmadan doğrudan JSON feed kullanılıyor.\n`);
    console.log(`✅ softgarden feed'inden ${items.length} ilan bulundu (${softgardenJobs.length} toplamdan, "${cityFilter}" filtresiyle) → aşağıdaki bloğu Whittle "Toplu İçe Aktar"a yapıştır (senior görünenler çıkarıldı):\n`);
    if(!process.env.CI) console.log(JSON.stringify(included, null, 2)); // 13.10: repo public – GitHub log'larına ilan metni basılmasın
    printExcludedSenior(excluded);
    return { items };
  }

  // Phenom People — softgarden ile AYNI mantık: sabit host yok, her URL için dene, olmazsa
  // sessizce devam et. fetchPhenomJobs kendi içinde hem şehir filtresini (Phenom'un payload
  // filtresine güvenmeden, kendi tarafımızda) hem de detay-sayfası açıklama zenginleştirmesini
  // uyguluyor — buraya filtrelenmiş, mümkün olduğunca açıklamalı final liste geliyor.
  const phenomOrigin = softgardenOrigin;
  const phenomJobs = phenomOrigin ? await fetchPhenomJobs(phenomOrigin, cityFilter) : null;
  if(phenomJobs){
    const items = phenomJobs.map(j => {
      const req = guessRequirements(j.description);
      return {
        title: j.title, companyName: j.company, sourceNote: j.location, externalUrl: j.url || url, postedAt: postedDay(j.datePosted),
        ...req.guess, estimated: req.estimated, evidence: req.evidence,
        nicheGuess: guessNiche(`${j.title || ''} ${j.description || ''}`),
        seniorityGuess: guessSeniority(j.title),
        _rawText: req._text,
      };
    });
    const { included, excluded } = splitByTargetFit(items);
    console.log(`ATS tespit edildi (Phenom People, /widgets üzerinden): tarayıcı açılmadan doğrudan API kullanılıyor.\n`);
    console.log(`✅ Phenom People API üzerinden ${items.length} ilan bulundu ("${cityFilter}" filtresiyle, her ilanın kendi detay sayfasından açıklama denendi) → aşağıdaki bloğu Whittle "Toplu İçe Aktar"a yapıştır (senior görünenler çıkarıldı):\n`);
    if(!process.env.CI) console.log(JSON.stringify(included, null, 2)); // 13.10: repo public – GitHub log'larına ilan metni basılmasın
    printExcludedSenior(excluded);
    return { items };
  }

  console.log(`Tarayıcı açılıyor, sayfa yükleniyor: ${url}\n`);
  const browser = sharedBrowser || await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  let page; // DÜZELTME: sharedBrowser kullanırken kapatmamız gereken şey BROWSER değil, sadece bu
  // TEK sayfa — try bloğu içinde tanımlıysa finally'de erişilemez, o yüzden burada hoisting yapıyoruz.
  try{
    page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 }); // DÜZELTME (MediaMarkt): Puppeteer'ın 800x600
    // varsayılanı bazı responsive sitelerde arama widget'ını hiç render etmiyor/mobil bir düzene
    // geçiriyor olabilir — düzgün bir masaüstü boyutu bunu önlüyor, genel bir sağlamlaştırma.
    await page.setUserAgent('Mozilla/5.0 (compatible; WhittleJobPostingReader/1.0)');
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 }).catch(e => {
      if(!/timeout/i.test(e.message)) throw e;
      console.log('  ⚠️  networkidle zaman aşımı — mevcut içerikle devam ediliyor.');
    });
    // Bazı SPA'lar JSON-LD'yi sayfa tam sakinleştikten birkaç saniye sonra ekliyor, küçük bir pay bırakıyoruz.
    await new Promise(r => setTimeout(r, 2000));

    const html = await page.content();
    const blocks = extractJsonLd(html);
    const jobs = findJobPostings(blocks);

    let jsonLdEmptyNote = null, jsonLdOtherLoc = false;
    if(jobs.length > 0){
      const summarized = jobs.map(summarize);
      // DÜZELTME: bu dal (diğer yollardan farklı olarak) şehir filtresi hiç uygulamıyordu — bir
      // sayfada dünyanın her yerinden JSON-LD ilan varsa (ör. bir küresel şirketin "tüm ilanlar"
      // sayfası) hepsi hiç filtrelenmeden basılıyordu. Artık diğer yollarla aynı kurala uyuyor:
      // konumu olmayan ya da cityFilter'a uymayan ilanlar elenir.
      let filtered = summarized.filter(j => j.location && buildCityRegex(cityFilter).test(j.location));
      // 30.09 (Frequentis): JSON-LD'de konum alanı BOŞ ("addressLocality": "") ama sayfa başlığı/URL şehri
      // söylüyor ("… - Wien - 3339", "/JobDetail/VIE-…"). Konumu boş ilanlarda sayfanın <title>'ı + URL'e bak.
      if(!filtered.length && summarized.some(j => !j.location)){
        const hint = `${await page.title().catch(() => '')} ${decodeURIComponent(url).replace(/[\/_-]+/g, ' ')}`.replace(/\bVIE\b/g, 'Wien');
        const cre = buildCityRegex(cityFilter);
        const m = cre instanceof RegExp ? hint.match(cre) : null;
        if(m){
          const city = /vienna/i.test(m[0]) ? 'Wien' : m[0];
          filtered = summarized.filter(j => !j.location).map(j => ({ ...j, location: city }));
          console.log(`  ↪︎ JSON-LD konumu boş — sayfa başlığı/URL'den "${city}" alındı.`);
        }
      }
      // "VIE_ (Junior) System Engineer" → "(Junior) System Engineer" (Frequentis ofis kodu öneki)
      filtered.forEach(j => { if(j.title) j.title = String(j.title).replace(/^[A-Z]{2,4}_\s*/, '').trim(); });
      if(!filtered.length){
        // DÜZELTME: eskiden burada direkt pes edip dönüyorduk — ama bazı sitelerde (ör. UniCredit/
        // Avature) JSON-LD'nin KENDİ konum alanı eksik/farklı kodlanmış olabiliyor, oysa sayfanın
        // GÖRÜNEN metninde (etiketli alan olarak) doğru şehir açıkça yazıyor olabilir. Pes etmek
        // yerine not düşüp aşağıdaki diğer yöntemlere (gömülü ATS/etiketli alan/chunk-split) devam
        // ediyoruz — hiçbiri de bulamazsa en sonda bu notu gösteririz.
        jsonLdEmptyNote = `JSON-LD'de ${jobs.length} ilan bulundu ama hiçbiri "${cityFilter}" içermiyor (konumu boş/eşleşmeyenler elendi) — diğer yöntemler deneniyor...`;
        // 10.10 (PORR): JSON-LD ilanın konumunu AÇIKÇA başka bir yer olarak veriyorsa, son çare "düz metin" yolu
        // footer'daki adres ("… Wien") yüzünden ilanı yine de almasın.
        jsonLdOtherLoc = summarized.some(j => j.location && String(j.location).trim());
        console.log(`❌ ${jsonLdEmptyNote}`);
      } else {
        // DÜZELTME (Red Bull): bazı sitelerde JSON-LD'nin description alanı sadece kısa bir
        // TANITIM paragrafı taşıyor — asıl gereksinim listesi ("Fließende Deutschkenntnisse",
        // "Eingeschrieben an einer Universität" gibi) sayfada AYRI bir bölümde duruyor ve JSON-LD'ye
        // hiç yansımıyor. Sonuç: guessRequirements'a giren metinde hiçbir kalıp yok, deg/de/en/exp
        // hepsi sessizce null/estimated kalıyor. Bir ilan için JSON-LD'den TEK bir eksen bile
        // çıkarılamadıysa (whittleEstimated 5 eksenin hepsini kapsıyorsa), sayfanın TÜM görünen
        // metnini de işin içine katıp bir kez daha deniyoruz — pahalı bir işlem olduğu için sadece
        // gerçekten gerektiğinde (ilk deneme boş çıktığında) çalışıyor.
        let pageText = null;
        for(const j of filtered){
          // DÜZELTME (kendi hatam): wm ekseni metin >50 karakterse HER ZAMAN "onsite" varsayımıyla
          // dolduruluyor (guessRequirements'taki varsayılan) — yani estimated dizisi pratikte hiçbir
          // zaman 5'e ulaşmıyor, en fazla 4 kalıyor. ">=5" eşiği hiç tetiklenmeyen ölü bir kontroldü.
          // wm'yi hariç tutup gerçek içerik eksenlerine (deg/de/en/exp) bakıyoruz.
          const nothingGuessed = Array.isArray(j.whittleEstimated) && j.whittleEstimated.filter(k => k !== 'wm').length >= 4;
          if(!nothingGuessed) continue;
          if(pageText === null){
            try{ pageText = (await dumpVisibleText(page)).text || ''; }
            catch(e){ pageText = ''; }
          }
          if(!pageText) continue;
          const retry = guessRequirements(`${j.descriptionFull || ''} ${pageText}`);
          if(Object.keys(retry.guess).length){
            j.whittleGuess = { deg:null, de:null, en:null, exp:null, wm:null, ...retry.guess };
            j.whittleEstimated = retry.estimated;
            j.whittleEvidence = retry.evidence;
          }
        }
        const items = filtered.map(j => ({
          title: j.title, companyName: j.company,
          deg: j.whittleGuess.deg, de: j.whittleGuess.de, en: j.whittleGuess.en,
          exp: j.whittleGuess.exp, wm: j.whittleGuess.wm, team: j.whittleGuess.team, estimated: j.whittleEstimated,
          evidence: j.whittleEvidence || {},
          _rawText: j.descriptionFull || '', _adLines: j.descriptionLines || null,
          externalUrl: url, sourceNote: j.location, postedAt: postedDay(j.datePosted),
          nicheGuess: guessNiche(`${j.title || ''} ${j.descriptionSnippet || ''}`),
          seniorityGuess: guessSeniority(j.title),
        }));
        const { included, excluded } = splitByTargetFit(items);
        console.log(`✅ ${filtered.length} ilan bulundu (${jobs.length} toplamdan, "${cityFilter}" filtresiyle) → aşağıdaki bloğu Whittle "Toplu İçe Aktar"a yapıştır (senior görünenler çıkarıldı):\n`);
        if(!process.env.CI) console.log(JSON.stringify(included, null, 2)); // 13.10: repo public – GitHub log'larına ilan metni basılmasın
        printExcludedSenior(excluded);
        return { items };
      }
    }

    // JSON-LD yoktu — sayfa Greenhouse/Lever'ı kendi domaininin arkasına gömüyor olabilir
    // (careers.sirket.com gibi). Varsa, kırılgan chunk-split/tıklama tahminine hiç girmeden
    // doğrudan gerçek API'ye geçiyoruz.
    const embeddedAts = await detectEmbeddedAts(page);
    if(embeddedAts){
      console.log(`Sayfaya gömülü ATS tespit edildi: ${embeddedAts.type} / "${embeddedAts.token}" — doğrudan API kullanılıyor.\n`);
      const result = await runAtsPath(embeddedAts, url, cityFilter);
      // 05.10: Unilever'de 156 ilan linkinin HER BİRİ aynı Workday API'sini (93 ilan) tekrar çağırdı → parça 3 saatte iptal oldu.
      // API şirketin tüm ilanlarını zaten verdi; çağıran (runCrawl) kalan linkleri atlasın.
      if(result.ok){ if(ctx) ctx.atsDone = `${embeddedAts.type}/${embeddedAts.token}`; return { items: result.items }; }
      console.log('API yolu başarısız oldu, sayfa kazıma (chunk-split) akışına devam ediliyor...\n');
    }

    // Bazı siteler (McKinsey gibi) konum listesini "+23 More" gibi tıklanması gereken bir
    // toggle'ın arkasına saklıyor — DOM'a hiç eklenmemiş oluyor, metin okuma bunu göremiyor.
    // Genel bir çözüm: böyle bir toggle bulursak tıklayıp kısa bir süre bekliyoruz.
    try{
      const expanded = await page.evaluate(() => {
        const candidates = Array.from(document.querySelectorAll('button, a, span, div'));
        const toggle = candidates.find(el => {
          const t = (el.textContent || '').trim();
          return /^\+\s*\d+\s*(more|mehr)\b/i.test(t) && t.length < 40;
        });
        if(toggle){ toggle.click(); return true; }
        return false;
      });
      if(expanded) await new Promise(r => setTimeout(r, 1500));
    }catch(e){ /* toggle bulunamadı/tıklanamadı, normal akışa devam */ }

    let dump = await dumpVisibleText(page);
    // DÜZELTME: bazı siteler (ör. Schönherr'in kullandığı onlyfy) çok ağır bir JS/SPA — normal
    // bekleme süresinde içerik daha yüklenmemiş oluyor, sayfa metni "All jobsEN" gibi neredeyse
    // boş kalıyor. İçerik şüpheli derecede kısaysa (100 karakterden az), biraz daha bekleyip
    // tekrar okuyoruz — pes etmeden önce son bir şans.
    if(dump.text.trim().length < 100){
      await new Promise(r => setTimeout(r, 4000));
      dump = await dumpVisibleText(page);
    }
    if(dump.text.trim().length < 100){
      // Hâlâ boş/çok kısa — sayfayı TAMAMEN yeniden yükleyip (network tamamen dursun diye
      // 'networkidle0' ile) son bir kez daha deniyoruz. Bazı ağır SPA'larda ilk yüklemede
      // takılan bir kaynak, yeniden yüklemede düzelebiliyor.
      try{ await page.reload({ waitUntil: 'networkidle0', timeout: 30000 }); }catch(e){ /* reload başarısız olursa mevcut sayfayla devam */ }
      await new Promise(r => setTimeout(r, 5000));
      dump = await dumpVisibleText(page);
    }
    // Şirket adını sayfa başlığından (h1) çıkarmak güvenilmez (bazı sitelerde h1 "Offene Stellen"
    // gibi jenerik bir şey oluyor) — URL'in alan adından türetmek daha tutarlı çalışıyor. DÜZELTME:
    // "careers.ey.com" gibi genel bir alt alan adında ilk parça ("careers") şirket adı değil — bu
    // durumda bir sonraki parçayı ("ey") kullanıyoruz.
    const GENERIC_SUBDOMAINS = /^(www|careers?|jobs?|bewerbung|karriere|apply|talent|recruiting)$/i;
    const companyFromUrl = (()=>{
      try{
        const host = new URL(url).hostname; // ör. makaro-gmbh.jobs.personio.de
        const parts = host.split('.');
        const raw = GENERIC_SUBDOMAINS.test(parts[0]) && parts.length > 2 ? parts[1] : parts[0];
        const slug = raw.replace(/-?gmbh$|-?ag$|-?kg$/i,'').replace(/[-_]/g,' ');
        return slug.replace(/\b\w/g, c=>c.toUpperCase());
      }catch(e){ return null; }
    })();
    const cityChunks = splitAndFilterByCity(dump.text, cityFilter);
    if(cityChunks && cityChunks.length > 0){
      const companyGuess = companyFromUrl || (dump.title||'').replace(/^\|?\s*Jobs bei\s*/i,'').trim() || null;
      const parsed = cityChunks.map(c => parseChunk(c, companyGuess));

      // Her ilan için: başlığa tıklamayı dene, açılan/gidilen yerde gereksinim metni ara.
      const listPageUrl = page.url();
      for(const p of parsed){
        if(!p.title) continue;
        try{
          const result = await tryExpandListing(page, p.title);
          if(result.ok){
            const html2 = await page.content();
            const blocks2 = extractJsonLd(html2);
            const jobs2 = findJobPostings(blocks2);
            if(jobs2.length > 0 && jobs2[0].description){
              p.requirements = String(jobs2[0].description).replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().slice(0, 3000);
            } else {
              const dump2 = await dumpVisibleText(page);
              // Orijinal (tıklamadan önceki) metinden FARKLI, yeni görünen kısmı yakalamaya çalış.
              if(dump2.text.length > dump.text.length + 50){
                p.requirements = dump2.text.slice(0, 3000);
              }
            }
            if(result.navigated){ await page.goto(listPageUrl, { waitUntil:'networkidle2', timeout:20000 }); await new Promise(r=>setTimeout(r,1000)); }
          }
        }catch(e){ /* bu ilan için tıklama başarısız oldu, requirements boş kalır */ }
      }

      const items = parsed.map(p => {
        const req = guessRequirements(p.requirements || '');
        return { title: p.title, companyName: p.companyName, sourceNote: p.location, externalUrl: url,
          ...req.guess, estimated: req.estimated, evidence: req.evidence,
          nicheGuess: guessNiche(`${p.title || ''} ${p.requirements || ''}`),
          seniorityGuess: guessSeniority(p.title), _rawText: req._text };
      });
      const { included, excluded } = splitByTargetFit(items);
      console.log(`✅ "${cityFilter}" geçen ${parsed.length} ilan bulundu → aşağıdaki bloğu Whittle "Toplu İçe Aktar"a yapıştır (senior görünenler çıkarıldı):\n`);
      parsed.forEach((p,i)=>{
        if(!p.requirements) console.log(`  (İlan ${i+1}: metin hiç yakalanamadı — tıklama işe yaramamış olabilir)`);
      });
      if(!process.env.CI) console.log(JSON.stringify(included, null, 2)); // 13.10: repo public – GitHub log'larına ilan metni basılmasın
      printExcludedSenior(excluded);
      console.log('\n--- Ham yakalanan metin (tahmin bulunamazsa, içinde ne var diye kontrol et) ---');
      parsed.forEach((p,i)=> console.log(`\nİlan ${i+1}: ${p.requirements ? p.requirements.slice(0,1500) : '(hiç metin yakalanamadı)'}`));
      return { items };
    } else if(cityChunks && cityChunks.length === 0){
      console.log(`❌ Sayfa ilanlara bölünebildi ama hiçbiri "${cityFilter}" içermiyor.`);
      return { items: [] };
    }
    // Son çare: JSON-LD yok, Personio-tarzı chunk-split de tutmadı — ama sayfa yine de
    // "Standort(e): X Level der Erfahrung: Y" gibi etiketli alanlar taşıyor olabilir (SAP
    // SuccessFactors Career Site Builder gibi kurumsal ATS'lerde sık görülen kalıp). Bunu
    // TEK BİR İLAN sayfası olarak değerlendiriyoruz.
    const labeled = parseLabeledFields(dump.text);
    if(labeled && (labeled.location || labeled.levelRaw)){
      let titleGuess = extractSfJobTitle(dump.text) || (dump.title || '').trim() || null;
      // DÜZELTME (ANDRITZ): bu SF varyantında <h1> hem alan ETİKETİNİ ("Bezeichnung:"/"Job title:")
      // hem de gerçek başlığı aynı elementin içinde, aralarında bolca boşluk/satır sonuyla taşıyor —
      // extractSfJobTitle'ın bildiği iki kalıp (KPMG'nin "Link zu Stellenbenachrichtigungen...Jetzt
      // bewerben" çerçevesi, Avature'ın "Apply as...General Information" çerçevesi) burada tutmuyor,
      // bu yüzden ham dump.title'a düşülüyor ve etiket + fazla boşluk direkt başlığa karışıyordu
      // ("Bezeichnung: \n \n\n Proposal Manager..." gibi). Bilinen etiket öneklerini kırpıp iç
      // boşlukları tek boşluğa indiriyoruz — hem bu hem benzer kalıptaki başka siteler için genel.
      if(titleGuess){
        titleGuess = titleGuess
          .replace(/^(Bezeichnung|Job\s*title|Stellenbezeichnung|Stellentitel|Title)\s*:?\s*/i, '')
          .replace(/\s+/g, ' ')
          .trim();
      }
      // DÜZELTME (26.09 — UniCredit: 2 ilanın başlığı sadece "UniCredit"): başlık kalıpları tutmayınca
      // sekme başlığına (= şirket adına) düşülüyordu. Başlık şirket adından ibaretse ilanı atla.
      const normName = x => (x || '').toLowerCase().replace(/[^a-z0-9äöü]/g, '');
      // Çerez/gizlilik banner'ı metni de başlık sanılabiliyor (UniCredit: "This portal protects your privacy...").
      const BOILERPLATE_TITLE = /protects your privacy|cookie|datenschutzerklärung|privacy policy|we use cookies|javascript (is )?(disabled|required)|general data protection/i;
      if(!titleGuess || normName(titleGuess) === normName(companyFromUrl) || BOILERPLATE_TITLE.test(titleGuess) || titleGuess.length > 150){
        console.log(`❌ Başlık çıkarılamadı (sadece "${titleGuess}") — ilan atlanıyor.`);
        return { items: [] };
      }
      // DÜZELTME: Erste Group gibi sitelerde meta açıklama etiketi ("Company: X, Location: Y,
      // Posted since: Z") görünen metindeki "Dienstort:" taramasından daha güvenilir — sayfada
      // "benzer ilanlar" gibi başka şehirlerin de geçtiği bir widget varsa, serbest metin taraması
      // yanlış şehri yakalayabiliyordu (bir Vorarlberg şubesini "Wien" sanmamız gibi). Meta etiketi
      // VARSA ve şehirle uyuşmuyorsa OTORİTER kabul edip direkt eliyoruz — aşağıdaki "sayfanın
      // başka yerinde şehir geçiyor mu" toleransına (Bain-tarzı kısaltılmış liste senaryosu için
      // tasarlandı) bu durumda düşmüyoruz, aksi halde şirket merkezi adresindeki bir "Wien"
      // yüzünden yanlışlıkla geri kabul edilebilir.
      const metaLocation = await extractMetaLocation(page);
      if(metaLocation && !buildCityRegex(cityFilter).test(metaLocation)){
        console.log(`❌ Meta etikette konum "${metaLocation}" — "${cityFilter}" içermiyor, atlanıyor.`);
        return { items: [] };
      }
      // DÜZELTME: bazı sitelerde (ör. Bain — "Abu Dhabi | Amsterdam | ... | Bogota [+45 offices]"
      // gibi kısaltılmış bir özet + DOM'da başka bir yerde tam liste) etiketli alan sadece kısaltılmış
      // özeti yakalayıp gerçek şehri (Wien, listenin devamında) kaçırabiliyor. Etiketteki konum
      // eşleşmezse, pes etmeden önce TÜM sayfa metninde şehir geçiyor mu diye de bakıyoruz.
      let effectiveLocation = metaLocation || labeled.location;
      if(!metaLocation && labeled.location && !buildCityRegex(cityFilter).test(labeled.location)){
        // 10.10 (Boehringer: Tampa/Tokyo ilanları "Österreich" diye girdi): etiket AÇIK bir başka yer söylüyorsa
        // sayfa metnindeki "Österreich" (dil/ülke seçici, footer) yeterli değil. Sadece kısa/belirsiz etikette kabul.
        const vagueLoc = String(labeled.location).trim().length < 4 || /mehrere|multiple|various|verschiedene|diverse|several/i.test(labeled.location);
        if(vagueLoc && buildCityRegex(cityFilter).test(dump.text)){
          effectiveLocation = isAustriaMode(cityFilter) ? 'Österreich' : cityFilter; // etiket kısaltılmıştı ama şehir sayfada geçiyor — güven düşük ama kabul
        } else {
          console.log(`❌ Etiketli alan bulundu ama konum ("${labeled.location}") "${cityFilter}" içermiyor — atlanıyor.`);
          return { items: [] };
        }
      }
      const req = guessRequirements(dump.text);
      const item = {
        title: titleGuess, companyName: companyFromUrl, sourceNote: effectiveLocation || null,
        externalUrl: url, ...req.guess, estimated: req.estimated, evidence: req.evidence,
        nicheGuess: guessNiche(`${titleGuess || ''} ${dump.text}`),
        seniorityGuess: mapLevelRaw(labeled.levelRaw) || guessSeniority(titleGuess),
        levelRaw: labeled.levelRaw || null, employmentTypeRaw: labeled.employmentType || null,
        _rawText: req._text, _adLines: dump.lines || null,
      };
      const { included, excluded } = splitByTargetFit([item]);
      console.log(`✅ Etiketli alanlar bulundu (JSON-LD yoktu ama sayfa yapılandırılmış metin taşıyor) → tek ilan olarak işlendi:\n`);
      if(!process.env.CI) console.log(JSON.stringify(included, null, 2)); // 13.10: repo public – GitHub log'larına ilan metni basılmasın
      printExcludedSenior(excluded);
      return { items: [item] };
    }

    // Son çare (genel, sadece Generali'ye özel değil): JSON-LD yok, Personio kalıbı yok, etiketli
    // alan da yok — ama sayfanın <h1>'i gerçek bir ilan başlığı gibi duruyor (KPMG'deki gibi
    // "Kontakt" değil) VE metinde hedef şehir geçiyor. Bazı siteler (Generali gibi) hiç etiket
    // kullanmıyor, her şeyi "WienTeilzeit / Vollzeitab sofort" gibi bitişik yazıyor — bunlardan
    // temiz alan çıkaramayız ama en azından TEK bir ilan olarak (düşük güvenle) yakalayabiliriz,
    // hiç yakalamamaktan iyidir. GENERIC_PAGE_TITLES'a uyan başlıklar (nav/menü metni) elenir.
    const GENERIC_PAGE_TITLES = /^(offene stellen|alle stellen|jobs?|karriere|kontakt|stellenangebote|open positions|job search|suche|home|start(seite)?|fachbereiche|standorte|entdecke unsere offenen positionen|dein einstieg|jobs \w+|[a-z]{2}_\w+)$/i;
    if(dump.title && dump.title.trim().length > 5 && dump.title.trim().length < 150
       && !GENERIC_PAGE_TITLES.test(dump.title.trim()) && buildCityRegex(cityFilter).test(dump.text) && !jsonLdOtherLoc){
      const req = guessRequirements(dump.text);
      const item = {
        title: dump.title.trim(), companyName: companyFromUrl, sourceNote: isAustriaMode(cityFilter) ? 'Österreich' : cityFilter,
        externalUrl: url, ...req.guess, estimated: req.estimated, evidence: req.evidence,
        nicheGuess: guessNiche(`${dump.title} ${dump.text}`),
        seniorityGuess: guessSeniority(dump.title),
        lowConfidence: true,
        _rawText: req._text, _adLines: dump.lines || null,
      };
      const { included, excluded } = splitByTargetFit([item]);
      console.log(`✅ Düz metin sayfası, hiç etiket/JSON-LD yok — düşük güvenle TEK ilan olarak işlendi (lowConfidence: true, elle doğrula):\n`);
      if(!process.env.CI) console.log(JSON.stringify(included, null, 2)); // 13.10: repo public – GitHub log'larına ilan metni basılmasın
      printExcludedSenior(excluded);
      return { items: [item] };
    }

    if(jsonLdEmptyNote){
      console.log(`⚠️  ${jsonLdEmptyNote} — diğer yöntemler de bir şey bulamadı. Sayfanın görünen metnini dökülüyorum:\n`);
    } else {
      console.log('⚠️  Yapılandırılmış veri bulunamadı. Sayfanın görünen metnini dökülüyorum:\n');
    }
    console.log(`BAŞLIK: ${dump.title}\n`);
    console.log(`İÇERİK (ilk 2000 karakter):\n${dump.text.slice(0, 2000)}\n`);

    const guesses = await fallbackScanLinks(page);
    const usefulGuesses = guesses.filter(g => !/zurück|back|alle stellen|all positions/i.test(g.text));
    if(usefulGuesses.length > 0){
      console.log(`\nAyrıca bulunan ${usefulGuesses.length} olası başka ilan linki (TAHMİN, doğrula — bir liste sayfasındaysan bunun yerine --crawl modunu deneyebilirsin, bu linkleri otomatik toplar ve işler):\n`);
      usefulGuesses.forEach(g => console.log(`  - ${g.text}\n    ${g.href}`));
    }
    return { items: [] };
  } finally {
    // sharedBrowser verildiyse SADECE bu sayfayı kapatıyoruz — tarayıcının kendisi runCrawl'da
    // tüm ilanlar bitene kadar açık kalmalı. Kendi tarayıcımızı açtıysak (sharedBrowser yoksa),
    // eskisi gibi tüm tarayıcıyı kapatıyoruz.
    if(sharedBrowser){ if(page) await page.close().catch(() => {}); }
    else { await browser.close(); }
  }
}

// --crawl <liste-sayfası-url> [şehir]: bir "Tüm İlanlar" liste sayfası verildiğinde, tek tek 72
// URL kopyalamak yerine hepsini KENDİSİ topluyor: sayfadaki ilan linklerini (fallbackScanLinks)
// çekiyor, "Weiter/Next/»" gibi görünen bir sayfalama kontrolü varsa tıklayıp devam ediyor, yeni
// link gelmeyene ya da maxPages'e ulaşana kadar sürüyor. Toplanan her linki processUrl ile
// otomatik işler (JSON-LD / etiketli-alan / vb. hangisi tutarsa). UYARI: sayfalama tespiti
// best-effort bir TAHMİN — "sonraki sayfa" metnini/aria-label'ını arıyor, her sitede aynı
// çalışmayabilir; test edilmesi gerekiyor.
async function crawlListing(listingUrl, maxPages = 25, sharedBrowser){ // 25: "Mehr laden" sitelerinde her tık ~10 ilan getiriyor
  const browser = sharedBrowser || await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const allJobLinks = new Map(); // href -> text, dedup
  const SKIP_TEXT = /alle stellen|all positions|praktikum & traineeship|karriere|benefits|bewerbung bei|datenschutz|impressum|zurück|back|offene stellen/i;
  let page;
  try{
    page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 }); // DÜZELTME (MediaMarkt): Puppeteer'ın 800x600
    // varsayılanı bazı responsive sitelerde arama widget'ını hiç render etmiyor/mobil bir düzene
    // geçiriyor olabilir — düzgün bir masaüstü boyutu bunu önlüyor, genel bir sağlamlaştırma.
    await page.setUserAgent('Mozilla/5.0 (compatible; WhittleJobPostingReader/1.0)');
    // DÜZELTME (26.09 — EY: "Navigation timeout of 30000 ms exceeded", şirket tamamen 0): networkidle2
    // analytics/izleme istekleri hiç susmayan sitelerde hiç gelmiyor, ama sayfa çoğu zaman zaten
    // yüklenmiş oluyor. Süre 60sn'ye çıktı; yine dolarsa hata fırlatmak yerine mevcut DOM'la devam.
    await page.goto(listingUrl, { waitUntil: 'networkidle2', timeout: 60000 }).catch(e => {
      if(!/timeout/i.test(e.message)) throw e;
      console.log('  ⚠️  networkidle zaman aşımı — sayfa yüklenmiş olabilir, mevcut içerikle devam ediliyor.');
    });
    await new Promise(r => setTimeout(r, 4000));

    // TEŞHİS: filtreden önce DOM'da GERÇEKTE kaç ilan linki var — "site zaten sadece N tane
    // render ediyor" ile "filtre hâlâ bir kısmını eliyor" ihtimallerini ayırt etmek için.
    const rawJobLinkCount = await page.evaluate(() => {
      return new Set(Array.from(document.querySelectorAll('a[href]'))
        .map(a => a.href)
        .filter(h => /\/(offene-stellen|jobs?|stelle|vacanc|position)\//i.test(h))).size;
    });
    console.log(`  [teşhis] Filtreden önce DOM'da toplam ilan-benzeri link: ${rawJobLinkCount}`);

    // DÜZELTME (MediaMarkt): bazı SuccessFactors kurulumlarında URL parametreleri SADECE arama
    // formunu ÖN DOLDURUYOR — asıl sorguyu tetikleyen şey kullanıcının "Jobs anzeigen"/"Suchen"/
    // "Search"/"Find Jobs" gibi bir gönder butonuna GERÇEKTEN tıklaması. URL'i doğrudan açmak formu
    // dolu gösteriyor ama sonuç listesi hiç yüklenmiyor (MediaMarkt'ta tam bu oldu — form "Wien"
    // gösteriyordu ama DOM'da tek bir ilan linki bile yoktu). Böyle bir buton varsa bir kez tıklayıp
    // biraz daha bekliyoruz; yoksa (çoğu site zaten URL'den direkt sonuç gösteriyor) bu adım
    // zararsızca hiçbir şey yapmıyor.
    // DÜZELTME (Schönherr): bu tıklama ESKİDEN yukarıdaki teşhisten ÖNCE çalışıyordu — sayfa
    // zaten ilanları gösteriyor olsa bile "search" gibi çok genel bir kelimeyle eşleşen (ör.
    // sayfanın en üstündeki GENEL site arama kutusunun düğmesi) bir şeye tıklayıp sayfayı
    // bambaşka bir duruma (hatta başka bir sayfaya) sürükleyebiliyordu — Schönherr'de tam bu oldu,
    // ilanlar zaten oradaydı ama yanlış tıklama onları kaybettirdi. Artık SADECE yukarıdaki teşhis
    // 0 ilan bulduysa (yani sayfa gerçekten bir arama tetiklenmesini bekliyorsa) tıklamayı
    // deniyoruz — ilanlar zaten görünüyorsa hiç dokunmuyoruz.
    if(rawJobLinkCount === 0){
      try{
        const clickedSearch = await page.evaluate(() => {
          const candidates = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="submit"]'));
          const isSearchSubmit = el => {
            const t = (el.textContent || el.value || '').trim();
            return /^(jobs anzeigen|suchen|search|find jobs|apply filters|filtern)\b/i.test(t);
          };
          const el = candidates.find(isSearchSubmit);
          if(el){ el.scrollIntoView({block:'center'}); el.click(); return true; }
          return false;
        });
        if(clickedSearch){
          console.log('  [teşhis] Bir arama/gönder butonu bulunup tıklandı ("Jobs anzeigen" tarzı) — sonuçların yüklenmesi için ekstra bekleniyor...');
          await new Promise(r => setTimeout(r, 3000));
        }
      }catch(e){ /* buton bulunamadı/tıklanamadı — normal akışa devam */ }
    }

    // DÜZELTME: string karşılaştırması sondaki "/" farkına takılıyordu — liste URL'i "/SearchJobs/"
    // ile bitiyorsa ama sayfadaki bir gezinme linki (ör. "Job search" breadcrumb'ı) "/SearchJobs"
    // (sonda / olmadan) ise, ikisi aynı sayfaya işaret etmesine rağmen isSelfLink YANLIŞLIKLA false
    // dönüyordu — UniCredit'te böyle bir link ("Job search", metninde "job" geçtiği için textKeywords
    // eşleşmesiyle yakalanmıştı) sahte bir "UniCredit" başlıklı ilan olarak paste bloğuna sızdı.
    // Artık sondaki "/" karşılaştırmadan ÖNCE her iki taraftan da temizleniyor.
    const normalizePath = p => (p || '').replace(/\/+$/, '');
    const listingBasePath = (() => { try{ const u = new URL(listingUrl); return normalizePath(u.origin + u.pathname); }catch(e){ return null; } })();
    // DÜZELTME (Wiener Stadtwerke): liste sayfası jobs.wienerstadtwerke.at'te iken, sayfadaki bazı
    // linkler FARKLI bir alt alan adına (www.wienerstadtwerke.at) gidiyordu — bunlar gerçek ilan
    // DEĞİL, "Internet of Trees" gibi genel tanıtım/blog sayfalarıydı, ama başlıklarında "Praktika"/
    // "Jobs" gibi kelimeler geçtiği için ilan sanılıp topluyordu. Artık liste sayfasıyla AYNI
    // hostname'e sahip olmayan linkler baştan eleniyor — bir ilan gerçekten başka bir alt alan
    // adındaysa (nadir), bu link hiç toplanmaz; böyle bir durumla karşılaşılırsa bu kısıtlama
    // gevşetilebilir, ama şu an gördüğümüz tek örnekte kısıtlamak kesinlikle doğruydu.
    const listingHost = (() => { try{ return new URL(listingUrl).hostname; }catch(e){ return null; } })();
    // DÜZELTME: bazı sitelerde (UniCredit/Avature gibi) "Next" butonu SPA içi bir DOM güncellemesi
    // değil, TAM SAYFA YENİLEMESİ tetikliyor — bu da Puppeteer'ın o anki execution context'ini
    // öldürüyor, hemen ardından gelen fallbackScanLinks çağrısı "Execution context was destroyed"
    // hatasıyla TÜM crawl'ı çökertiyor (ilk çalıştırmada zamanlama şans eseri tutmuştu, ikincisinde
    // tutmadı). Artık bu hatayı yakalayıp bir kez daha (biraz daha bekleyerek) deniyoruz; o da
    // olmazsa o sayfayı boş geçip devam ediyoruz — tek bir kırılgan site tüm crawl'ı batırmasın.
    async function safeScanLinks(){
      try{ return await fallbackScanLinks(page); }
      catch(e){
        console.log(`  ⚠️  Sayfa taranırken hata (muhtemelen tam sayfa yenilemesi): ${e.message} — 2sn bekleyip bir kez daha deneniyor...`);
        await new Promise(r => setTimeout(r, 2000));
        try{ return await fallbackScanLinks(page); }
        catch(e2){
          console.log(`  ⚠️  İkinci deneme de başarısız: ${e2.message} — bu sayfa atlanıp devam ediliyor.`);
          return [];
        }
      }
    }
    for(let pageNum = 1; pageNum <= maxPages; pageNum++){
      const links = await safeScanLinks();
      let newCount = 0;
      links.forEach(l => {
        // DÜZELTME: liste sayfası bazen KENDİ URL'ine (farklı sıralama/sorgu parametreleriyle)
        // bir link içeriyor — bu, "ilan" sanılıp RBI'da gördüğümüz gibi sahte "DE_Default"
        // girdisine yol açıyordu. Aynı origin+path'e (sorgu farkı olsa bile) işaret eden
        // linkleri hariç tutuyoruz.
        let isSelfLink = false;
        let isOtherHost = false;
        if(l.href){
          try{
            const u = new URL(l.href);
            if(listingBasePath) isSelfLink = normalizePath(u.origin + u.pathname) === listingBasePath;
            if(listingHost) isOtherHost = baseDomain(u.hostname) !== baseDomain(listingHost) && !isKnownAtsHost(u.hostname);
          }catch(e){ /* geçersiz URL, göz ardı et */ }
        }
        if(l.href && !isSelfLink && !isOtherHost && !allJobLinks.has(l.href) && !SKIP_TEXT.test(l.text)){
          allJobLinks.set(l.href, l.text); newCount++;
        }
      });
      console.log(`  Sayfa ${pageNum}: ${newCount} yeni ilan linki (toplam ${allJobLinks.size})`);

      const sizeBefore = allJobLinks.size;
      const clicked = await page.evaluate(() => {
        // GENİŞLETİLDİ (26.09): "Weiter/Next" dışında "Mehr laden" tarzı butonlar da tanınıyor. PORR,
        // Swietelsky gibi sitelerde bunlar <button> değil <span>/<div> olabiliyor ve metin değişiyor
        // ("Weitere Jobs laden", "Mehr Stellen anzeigen"). Kısa metinli, tıklanabilir görünen öğelere
        // bakılıyor; metni eşleşen en İÇTEKİ öğe seçiliyor (dış kapsayıcının metni de aynı olduğu için).
        const NEXT_TEXT = /^(weiter|next|»|›|nächste( seite)?|load more( jobs| results)?|show more( jobs| results)?|view more|more results|(mehr|weitere)( jobs| stellen| stellenangebote| ergebnisse)?( laden| anzeigen))(\s|$)/i;
        const candidates = Array.from(document.querySelectorAll('a,button,[role="button"],span,div'))
          .filter(el => (el.textContent || '').trim().length <= 40);
        const isNext = el => {
          const t = (el.textContent||'').trim().toLowerCase().replace(/\s+/g, ' ');
          const aria = (el.getAttribute('aria-label')||'').toLowerCase();
          if(el.tagName === 'SPAN' || el.tagName === 'DIV'){
            const clickable = el.onclick || /btn|button|load|more/i.test(String(el.className || '')) || getComputedStyle(el).cursor === 'pointer';
            if(!clickable) return false;
          }
          return NEXT_TEXT.test(t) || /next|weiter|load more|mehr laden|mehr anzeigen/.test(aria);
        };
        const matches = candidates.filter(isNext);
        const el = matches.find(m => !matches.some(o => o !== m && m.contains(o))) || matches[0];
        if(el && !el.disabled && !el.classList.contains('disabled') && el.getAttribute('aria-disabled') !== 'true'){
          el.scrollIntoView({block:'center'}); el.click(); return true;
        }
        return false;
      }).catch(e => { console.log(`  ⚠️  "Next" tıklaması sırasında hata: ${e.message}`); return false; });
      if(!clicked){
        // Tıklanacak bir buton bulunamadı — bazı SF örnekleri sonsuz kaydırma (infinite scroll)
        // kullanıyor, buton hiç yok. Sayfanın sonuna kaydırıp yeni içerik gelip gelmediğine
        // bakıyoruz; yeni link YOKSA gerçekten bitmiş demektir, o zaman döngüden çıkıyoruz.
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(()=>{});
        await new Promise(r => setTimeout(r, 1500));
        const linksAfterScroll = await safeScanLinks();
        let sawNew = false;
        linksAfterScroll.forEach(l => {
          if(l.href && !allJobLinks.has(l.href) && !SKIP_TEXT.test(l.text)){
            let isSelfLink = false;
            let isOtherHost = false;
            try{
              const u = new URL(l.href);
              if(listingBasePath) isSelfLink = normalizePath(u.origin + u.pathname) === listingBasePath;
              if(listingHost) isOtherHost = baseDomain(u.hostname) !== baseDomain(listingHost) && !isKnownAtsHost(u.hostname);
            }catch(e){}
            if(!isSelfLink && !isOtherHost){ allJobLinks.set(l.href, l.text); sawNew = true; }
          }
        });
        if(!sawNew) break;
        console.log(`  Sayfa ${pageNum} (kaydırma): ${allJobLinks.size - sizeBefore} yeni ilan linki (toplam ${allJobLinks.size})`);
        continue;
      }
      // DÜZELTME: sabit 1500ms yerine, tam sayfa yenilemesi durumunda biraz daha pay bırakmak için
      // 2500ms'ye çıkarıldı — sonraki turun safeScanLinks çağrısının erken çarpıp context hatası
      // alma ihtimalini azaltıyor (tam garanti değil, o yüzden safeScanLinks retry'ı hâlâ devrede).
      await new Promise(r => setTimeout(r, 2500));
    }
  } finally {
    // processUrl'deki aynı mantık: sharedBrowser'ı biz açmadıysak kapatmıyoruz, sadece kendi sayfamızı.
    if(sharedBrowser){ if(page) await page.close().catch(() => {}); }
    else { await browser.close(); }
  }
  return [...allJobLinks.keys()];
}

// Bazı platformlar (Workday gibi) şehri doğrudan URL'e gömüyor: .../job/{Şehir}/{Başlık}_{ID}.
// Böyle bir kalıp yakalarsak ve şehir cityFilter'a UYMUYORSA, o linki hiç açmadan (Puppeteer
// başlatmadan) elemek büyük hız kazandırıyor — PwC'nin küresel "Campus Careers" listesi gibi
// yüzlerce linki olan sayfalarda, gerçekte sadece birkaçı hedef şehirde olabiliyor; hepsini tek
// tek açmak dakikalarca sürer ve sunucuyu gereksiz yorar. Şehir URL'de yoksa elemeden geçiyoruz
// (emin olamayız, açıp bakmak daha güvenli).
function urlLooksLikeOtherCity(link, cityFilter){
  // SADECE Workday URL'lerinde uygula — Workday'in kalıbı .../job/{Şehir}/{Başlık}_{ID}, şehir
  // hep ikinci konumda. KPMG (SuccessFactors) gibi platformlarda ise aynı konumda BAŞLIK var
  // (.../job/{Başlık}/{ID}) — bu filtreyi herkese uygularsak KPMG'de başlığı şehir sanıp yanlış
  // elerdik (test ederken tam bunu yakaladık).
  if(!/myworkdayjobs\.com$/i.test(new URL(link).hostname)) return false;
  const m = link.match(/\/job\/([^\/]+)\//i);
  if(!m) return false;
  const seg = decodeURIComponent(m[1]).replace(/[-_]/g, ' ');
  return !buildCityRegex(cityFilter).test(seg);
}

// DÜZELTME (Schönherr): "farklı alan adına giden linkleri ele" kuralı (Wiener Stadtwerke için
// eklenmişti — alakasız blog/tanıtım linklerini elemek için) bazen MEŞRU ilan linklerini de
// eliyor, çünkü birçok şirket ilanlarını KENDİ domain'i DEĞİL, ayrı bir ATS domain'i üzerinden
// gösteriyor (Schönherr → schoenherr.onlyfy.jobs gibi). Bilinen ATS domainlerine giden linkleri bu
// "farklı host" kuralından MUAF tutuyoruz — Wiener Stadtwerke'nin asıl kapsadığı durum (alakasız
// şirket-içi blog/tanıtım alt alan adları) hâlâ elenir, sadece güvenilir ATS'ler istisna.
const KNOWN_ATS_HOST = /\.(greenhouse\.io|lever\.co|recruitee\.com|workable\.com|smartrecruiters\.com|onlyfy\.jobs|personio\.de|personio\.com|bamboohr\.com|avature\.net)$/i;
// 10.10 (Boehringer: liste www.boehringer-ingelheim.com'da, ilanlar jobs.boehringer-ingelheim.com'da): aynı ana alan adı = aynı site.
function baseDomain(h){ const p = String(h || '').toLowerCase().split('.'); const n = /^(gv|co|or|ac|com|org|net)$/.test(p[p.length - 2] || '') ? 3 : 2; return p.slice(-n).join('.'); }
function isKnownAtsHost(hostname){ return KNOWN_ATS_HOST.test(hostname || ''); }

// 28.09: ARTIMLI TARAMA. Avusturya geneline açılınca günde 2000-3000 ilan linki olacak; her gün hepsinin
// detay sayfasını Puppeteer'la açmak hem GitHub Actions dakikalarını hem siteleri gereksiz yoruyor.
// Liste sayfası her gün taranıyor (hangi ilanlar hâlâ açık → kapatma mantığı bozulmuyor), ama bir
// önceki sonuç dosyasında aynı linkten gelmiş ve REFETCH_DAYS'ten yeni bir kayıt varsa detay sayfası
// açılmıyor, önceki kayıt aynen kullanılıyor. Sadece yeni linkler (ve bayatlayanlar) açılıyor.
const REFETCH_DAYS = 7;
let KNOWN_LINKS = new Map(); // link → { items:[...], excluded:bool, fetchedAt }
function loadKnownLinks(outDir){
  const map = new Map();
  try{
    const files = fs.readdirSync(outDir).filter(f => /^whittle-import-\d{4}-\d{2}-\d{2}(-combined)?\.json$/.test(f)).sort();
    // En yeni 3 günün dosyası yeterli (bir gün tarama çökerse bir öncekine düşülsün).
    for(const f of files.slice(-6)){
      let d; try{ d = JSON.parse(fs.readFileSync(path.join(outDir, f), 'utf8')); }catch(e){ continue; }
      for(const it of (d.items || [])){
        if(!it._srcLink || !it._fetchedAt) continue;
        const rec = map.get(it._srcLink);
        if(rec && rec.fetchedAt > it._fetchedAt) continue;
        if(rec && rec.fetchedAt === it._fetchedAt){ if(!rec.items.some(x => x.externalUrl === it.externalUrl)) rec.items.push(it); continue; }
        map.set(it._srcLink, { items: [it], excluded: false, fetchedAt: it._fetchedAt });
      }
      for(const ex of (d.excludedItems || [])){
        if(!ex._srcLink || !ex._fetchedAt || map.has(ex._srcLink)) continue;
        map.set(ex._srcLink, { items: [], excluded: true, fetchedAt: ex._fetchedAt });
      }
    }
  }catch(e){ console.log(`⚠️  Önceki sonuçlar okunamadı (${e.message}) — tüm ilanlar açılacak.`); }
  return map;
}
function knownFresh(link){
  const rec = KNOWN_LINKS.get(link);
  if(!rec) return null;
  // 02.10: Tek linkten birden çok ilan gelmişse (Volksbank: bir ilan linki softgarden feed'ine gidip 52 ilanın
  // hepsini döndürüyor) önbellek kullanılmıyor — yoksa feed 7-10 gün donuyor, kapanan ilanlar açık kalıyor, yeniler gelmiyordu.
  if(rec.items.length > 1) return null;
  const ageDays = (Date.now() - new Date(rec.fetchedAt).getTime()) / 86400000;
  // Hepsi aynı gün bayatlamasın diye linke göre 0-3 gün kaydırma (ilk gün açılan binlerce ilan 8. gün tek seferde yenilenmesin).
  let h = 0; for(const ch of link) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return ageDays <= REFETCH_DAYS + (h % 4) ? rec : null;
}

// 10.10: robots.txt liste/arama sayfasını yasaklayıp sitemap'i serbest bırakan siteler için (PORR: Disallow /*?*tx_solr*).
// Sitemap index'i takip eder (en fazla 2 seviye), sadece pattern'i içeren <loc> linklerini döndürür.
async function sitemapLinks(sitemapUrl, pattern, depth = 0){
  const res = await fetch(sitemapUrl, { headers: { 'User-Agent': 'WhittleBot/1.0 (+https://whittle.at)' }, signal: AbortSignal.timeout(20000) });
  if(!res.ok) throw new Error(`sitemap ${res.status}`);
  const xml = await res.text();
  const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(m => m[1].replace(/&amp;/g, '&'));
  const out = new Set();
  for(const loc of locs){
    if(pattern && loc.includes(pattern)) out.add(loc);
    else if(depth < 2 && /sitemap/i.test(loc) && !(await isDisallowedByRobots(loc))){
      try{ (await sitemapLinks(loc, pattern, depth + 1)).forEach(u => out.add(u)); }catch(e){ console.log(`  sitemap alt dosyası okunamadı: ${loc} (${e.message})`); }
    }
  }
  return [...out];
}
async function runCrawl(listingUrl, cityFilter, opts = {}){
  if(await isDisallowedByRobots(listingUrl)){
    console.log(`🚫 ${new URL(listingUrl).host} — robots.txt bu sitede otomatik erişimi yasaklıyor, taramaya hiç başlanmıyor. Bu şirket için elle giriş ya da doğrudan izin istemek gerekiyor.`);
    return;
  }
  console.log(`Liste sayfası taranıyor: ${listingUrl}\n`);
  // DÜZELTME (asıl yavaşlık kaynağı — bkz. processUrl/crawlListing'deki sharedBrowser notu): bu
  // şirketin liste sayfası + TÜM ilan linkleri için tek bir tarayıcı açıyoruz, en sonda kapatıyoruz.
  // Eskiden her tek ilan linki kendi tarayıcısını açıp kapatıyordu (~1-3sn soğuk başlatma maliyeti
  // × yüzlerce ilan = sürenin büyük kısmı). Şirketler arası paralellik (CRAWL_CONCURRENCY) zaten
  // vardı ama bu, TEK bir şirketin içindeki ilanlar arasında hiç fark etmiyordu.
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const all = [];
  try{
    let jobLinks;
    if(opts.sitemap) jobLinks = await sitemapLinks(opts.sitemap, opts.linkPattern || '');
    else if(opts.pageTemplate){
      // 10.10 (Takeda): sayfalama linkleri crawlListing'in tanımadığı bir yolda (/…/2/{n}) — sayfalar config'ten tek tek geziliyor.
      const set = new Set();
      for(let n = 1; n <= (opts.maxPages || 10); n++){
        const before = set.size;
        (await crawlListing(opts.pageTemplate.replace('{n}', n), 1, browser)).forEach(u => set.add(u));
        if(set.size === before) break; // yeni link gelmediyse son sayfa
      }
      jobLinks = [...set];
      console.log(`📄 Sayfa şablonundan ${jobLinks.length} ilan linki.`);
    }
    else jobLinks = await crawlListing(listingUrl, 25, browser);
    if(opts.sitemap) console.log(`🗺️  Sitemap'ten ${jobLinks.length} ilan linki (${opts.linkPattern || 'tümü'}).`);
    const toVisit = jobLinks.filter(link => !urlLooksLikeOtherCity(link, cityFilter));
    const skipped = jobLinks.length - toVisit.length;
    console.log(`\n${jobLinks.length} ilan linki bulundu${skipped ? ` (URL'deki şehir bilgisiyle ${skipped} tanesi "${cityFilter}" olmadığı için önceden elendi, ${toVisit.length} kaldı)` : ''}. Şimdi her biri tek tek işlenecek...\n${'='.repeat(60)}`);
    let reused = 0;
    const today = new Date().toISOString().slice(0, 10);
    const ctx = { atsDone: null, start: Date.now() };
    const BUDGET_MS = 25 * 60 * 1000; // 05.10: tek şirkete en fazla 25 dk (bir şirket tüm parçayı kilitlemesin)
    for(const [i, link] of toVisit.entries()){
      if(ctx.atsDone){ console.log(`\n↪︎ İlanlar zaten gömülü ${ctx.atsDone} API'sinden alındı — kalan ${toVisit.length - i} link atlanıyor.`); break; }
      if(Date.now() - ctx.start > BUDGET_MS){ console.log(`\n⏱️  Şirket için 25 dk sınırı doldu — kalan ${toVisit.length - i} link atlandı.`); break; }
      const known = knownFresh(link);
      if(known){
        // Önceki kayıt: ham alanlarıyla geri koy (ek alanlar/AI yeniden cache'ten uygulanıyor).
        known.items.forEach(it => all.push({ ...it }));
        if(known.excluded) all.push({ _srcLink: link, _fetchedAt: known.fetchedAt, _knownExcluded: true, title: null });
        reused++;
        continue;
      }
      console.log(`\n[${i+1}/${toVisit.length}] ${link}`);
      console.log('-'.repeat(60));
      try{
        const { items } = await processUrl(link, cityFilter, browser, ctx);
        items.forEach(it => { it._srcLink = link; it._fetchedAt = today; });
        all.push(...items);
      }catch(e){
        console.log(`⚠️  Bu ilan işlenirken hata: ${e.message} — atlanıp bir sonrakine geçiliyor.`);
      }
      await new Promise(r => setTimeout(r, 400)); // nezaket: siteyi arka arkaya çok hızlı yormayalım
    }
    if(reused) console.log(`\n♻️  ${reused}/${toVisit.length} ilan son ${REFETCH_DAYS} günde zaten açılmıştı — detay sayfası tekrar açılmadı.`);
  } finally {
    await browser.close();
  }
  // DÜZELTME (Eren'in fark ettiği BCG'nin 272 ilanı — gerçekte 12 tane): bazı sitelerde (BCG'de
  // olduğu gibi) "liste sayfası" aslında aynı Phenom/softgarden feed'ine giden BİRDEN FAZLA farklı
  // link içeriyor (ör. hem "BCG Platinion" hem "BCG" bölümleri, her biri kendi linkiyle aynı
  // yerdeki TÜM açık pozisyonları döndürüyor). crawlListing bu linkleri farklı sanıp hepsini
  // ziyaret ediyor, her ziyarette processUrl aynı feed'i BAŞTAN SONA tekrar çekiyor — sonuçta
  // aynı 12 gerçek ilan, ziyaret edilen link sayısı kadar (burada ~22-24 kez) tekrarlanmış oluyor.
  // Kök nedeni (hangi linklerin aynı feed'e çıktığını önceden bilmek) çözmek yerine, daha güvenli
  // ve genel bir çözüm: aynı externalUrl'e sahip ilanları burada, tek bir yerde eleyip tekilleştiriyoruz
  // — bu, BCG'ye özel değil, aynı sorunu yaşayan başka bir şirket için de otomatik çalışır.
  const seenUrls = new Set();
  const deduped = all.filter(it => {
    const key = it.externalUrl || null;
    if(key === null) return true; // externalUrl'i olmayanı (ör. lowConfidence tek ilan) elemeden bırak
    if(seenUrls.has(key)) return false;
    seenUrls.add(key);
    return true;
  });
  if(deduped.length !== all.length){
    console.log(`\n🧹 ${all.length - deduped.length} tekrarlanan ilan (aynı externalUrl) elendi — ${all.length} → ${deduped.length}.`);
  }
  console.log(`\n${'='.repeat(60)}\n✅ CRAWL SONUCU: ${deduped.length} ilan işlendi → tek blok halinde Whittle "Toplu İçe Aktar"a yapıştır (senior görünenler çıkarıldı):\n`);
  const { included, excluded } = splitByTargetFit(deduped);
  if(!process.env.CI) console.log(JSON.stringify(included, null, 2)); // 13.10: repo public – GitHub log'larına ilan metni basılmasın

  const junior = deduped.filter(it => it.seniorityGuess === 'junior');
  const unclear = deduped.length - junior.length - excluded.length;
  console.log(`\n📊 Kıdem tahmini (TAHMİN): ${junior.length} junior/staj görünümlü, ${excluded.length} senior/kıdemli görünümlü (paste bloğundan çıkarıldı), ${unclear} belirsiz (bloğa dahil).`);
  printExcludedSenior(excluded);
  return { items: deduped };
}

// ---- AI soft-field katmanı (Eren onayladı) ----
// team/cust/phys/shift zaten yukarıdaki guessRequirements içinde regex ile deneniyor; bu katman
// SADECE regex'in boş bıraktığı alanlar + tamamen yoruma dayalı olan (regex'le yakalanamayacak)
// autonomy/variety/competitive/creative/leadership/mobile eksenleri için, İKİNCİ ÇARE olarak devreye
// giriyor. Cache dosyası results/ altında olduğu için GitHub Actions'ın zaten her gün commit'lediği
// "results/*.json" paternine dahil oluyor, workflow dosyasında ayrı bir değişikliğe gerek yok —
// daha önce (herhangi bir çalıştırmada) işlenmiş bir ilan BİR DAHA AI'ya gitmiyor. Ayrıca tüm
// çalıştırma için sabit bir üst sınır var (MAX_AI_CALLS_PER_RUN) — cache/regex ne kadar iyi
// çalışırsa çalışsın, maliyet bu tavanın üstüne asla çıkamıyor.
// 28.09: alan listeleri, prompt, doğrulama ve applyFieldValue ai-fields.js'e taşındı (merge'deki Batch API de kullanıyor).
const { SOFT_FIELD_KEYS, HARD_FIELD_KEYS, EXTRA_AI_KEYS, AI_FIELD_KEYS, isFieldMissing, AI_ENUMS, validateAiFields, applyFieldValue, aiExtractFields, cacheEntryFrom, DAILY_AI_LIMIT } = require('./ai-fields');
const AI_CACHE_FILE = path.join(__dirname, 'results', 'ai-soft-cache.json');
// Eren'in kararı: 80 kalsın (en kötü ihtimalde ~$4.5/ay tavan) — gerekirse bakiyeyi kendisi
// yükler. Gerçek tahmin (~50 yeni ilan/gün) bu tavanın altında olduğu için normal günlerde
// maliyet çok daha düşük (~$2.7/ay) kalır, 80 sadece güvenlik payı.
const MAX_AI_CALLS_PER_RUN = DAILY_AI_LIMIT; // 28.09: 80 → 180 (Batch API ile ~€10/ay tavan, bkz. ai-fields.js)

function loadAiCache(){
  try{
    if(fs.existsSync(AI_CACHE_FILE)) return JSON.parse(fs.readFileSync(AI_CACHE_FILE, 'utf8'));
  }catch(e){
    console.log(`⚠️  AI cache dosyası okunamadı (${e.message}) — sıfırdan başlanıyor (daha önce işlenmiş ilanlar bir kez daha AI'ya gidebilir, veri kaybı değil, sadece fazladan maliyet — MAX_AI_CALLS_PER_RUN yine de tavan koyuyor).`);
  }
  return {};
}
function saveAiCache(cache, file){
  try{ fs.writeFileSync(file || AI_CACHE_FILE, JSON.stringify(cache, null, 2)); }
  catch(e){ console.log(`⚠️  AI cache dosyası yazılamadı (${e.message}).`); }
}

// Cache: { externalUrl: { alan: değer|null } }. null = "soruldu, metinde yok" → bir daha sorulmaz.
// DÜZELTME (26.09): eskiden bir ilan cache'te varsa TÜMÜYLE atlanıyordu. Artık alan bazında:
// cache'te hiç sorulmamış eksik alan kaldıysa (ör. eskiden sadece soft alanlar sorulmuştu, şimdi
// deg/de/en/exp/wm de soruluyor) SADECE o alanlar için yeni çağrı yapılıyor, sonuç birleştiriliyor.
async function enrichFieldsForItems(items, cache, budget, callAi = aiExtractFields, rules = null){
  for(const item of items){
    if(!item.externalUrl) continue; // cache anahtarı yok, atla
    const cached = cache[item.externalUrl] || null;
    const missing = AI_FIELD_KEYS.filter(k => isFieldMissing(item, k));
    const cq = (cached && cached._q) || {};
    if(cached && cached.cat) item.aiCat = cached.cat; // 28.09: AI alan sınıflandırması (merge'deki batch'ten)
    if(cached){ for(const k of missing){ if(k in cached) applyFieldValue(item, k, cached[k], true, cq[k]); } }
    let toAsk = missing.filter(k => !cached || !(k in cached));
    // 28.09: Öğrenilmiş kurallar (ücretsiz) — AI'dan ÖNCE. Bir alanı bulursa o alan AI'ya sorulmuyor;
    // hepsini bulursa çağrı hiç yapılmıyor, kota yeni ve zor ilanlara kalıyor.
    if(rules && toAsk.length && item._rawText){
      const hits = learning.matchLearnedRules(item._rawText, rules, toAsk);
      for(const [k, h] of Object.entries(hits)){
        applyFieldValue(item, k, h.value, false, h.phrase, true);
        budget.learnedHits = (budget.learnedHits || 0) + 1;
      }
      toAsk = toAsk.filter(k => !(k in hits));
    }
    if(!toAsk.length){
      if(!cached) cache[item.externalUrl] = {}; // keyword/kurallar her şeyi bulmuş — "işlendi" diye işaretle
      continue;
    }
    if(!item._rawText) continue; // metin yok
    // 28.09 Batch modu (GitHub'da): burada AI çağrılmıyor, istek kuyruğa yazılıyor; merge-results.js tüm
    // parçaların kuyruğunu önceliğe göre sıralayıp TEK bir Batch API isteğiyle (%50 indirimli) gönderiyor.
    if(budget.queue){
      const hardMissing = toAsk.filter(k => ['deg','de','en','exp','wm','emp'].includes(k)).length;
      budget.queue.push({ url: item.externalUrl, title: item.title, text: String(item._rawText).slice(0, 12000), keys: toAsk, company: item._company || item.companyName || null, priority: hardMissing * 10 + toAsk.length });
      continue;
    }
    if(budget.remaining <= 0) continue; // bu çalıştırmanın AI kotası bitti
    budget.remaining--;
    const aiResult = await callAi(item.title, item._rawText, toAsk);
    if(aiResult === null) continue; // key yok / hata — cache'e yazılmaz, tekrar denenir
    const q = aiResult._q || {};
    for(const k of toAsk){ applyFieldValue(item, k, aiResult[k], true, q[k]); }
    cache[item.externalUrl] = cacheEntryFrom(cached, aiResult, item._company || item.companyName); // _c: "farklı şirket" eşiği için
  }
}

// --crawl-batch <şirketler.json>: --batch'in liste-sayfası (crawl) versiyonu. Config dosyası
// [{ "name":"KPMG", "url":"https://...", "city":"Wien" }, ...] formatında bir dizi. Her şirket
// için runCrawl çalıştırılır (yani her biri kendi liste sayfasını tarayıp içindeki tüm ilan
// linklerine tek tek girer), sonuçlar TEK bir JSON'da birleştirilir. GitHub Actions gibi bir
// otomasyon ortamından çalıştırılmak üzere tasarlandı — bu yüzden sonucu konsola yazmanın yanında
// results/whittle-import-<TARİH>.json dosyasına da yazıyor (otomasyonun "çıktıyı nereden alacağım"
// sorusuna cevap bu dosya). Bir şirket hata verirse (site kapalı, robots.txt engeli vb.) o şirket
// atlanır, özet raporda "başarısız" olarak listelenir, kalan şirketler için tarama devam eder.
// Aynı anda kaç şirket paralel taransın. Her şirket kendi sitesine karşı zaten "nezaket" bekleme
// süreleri uyguluyor (aynı domain'e art arda hızlı istek atmayalım diye) — ama bu bekleme SADECE
// tek bir site için anlamlıydı, FARKLI şirketler (farklı sunucular) arasında sıraya girip
// beklemenin hiçbir faydası yoktu, sadece toplam süreyi şişiriyordu (400 ilan ≈ 2.5 saat, tamamen
// sıralı çalıştığı için). 4'lü gruplar halinde paralel çalıştırınca aynı iş ~4 kat daha kısa sürede
// bitiyor (GitHub Actions standart runner'ı 2 CPU/7GB RAM veriyor, 4 headless Chrome bunun için
// sorun değil — zaten sürenin çoğu CPU değil, ağ isteği/uyku beklemesi). 2000 dk/ay private-repo
// kotasına rahatça sığması için seçildi; gerekirse artırılabilir.
const CRAWL_CONCURRENCY = 4;

/* =========================================================
   YENİ ALANLAR (26.09): emp (çalışma şekli), certs (sert yeterlilik şartları), employerType
   Hepsi ücretsiz keyword katmanı — AI kotasını kullanmıyor. Sitedeki deriveEmpFromTitle ile
   AYNI başlık kuralları.
========================================================= */
function empFromTitle(title){
  const t = (title || '').toLowerCase();
  const out = [];
  if(/praktik|\bintern\b|internship|ferialjob|ferialpraxis/.test(t)) out.push('praktikum');
  if(/teilzeit|werkstudent|student job|studentische|\btz\b|part[\s-]?time|\b[1-3]?\d\s?(-\s?\d+\s?)?(h|std|stunden|wst)\b/.test(t)) out.push('teilzeit');
  if(/geringfügig|minijob|aushilf|fallweise/.test(t)) out.push('geringfuegig');
  if(/vollzeit|\bvz\b|full[\s-]?time/.test(t)) out.push('vollzeit');
  if(/lehrling|lehrberuf|\blehre\b|lehrstelle|apprentice|duale akademie/.test(t)) out.push('lehre');
  return out;
}
function empFromText(text){
  const t = (text || '').toLowerCase();
  const out = [];
  if(/vollzeit|full[\s-]?time|\b(38[,.]5|40)\s?(std|stunden|wochenstunden|h)\b/.test(t)) out.push('vollzeit');
  if(/teilzeit|part[\s-]?time|\b(1\d|2\d|30)\s?(std|stunden|wochenstunden|h)\s?(\/|pro|per|je)?\s?(woche|week)/.test(t)) out.push('teilzeit');
  if(/geringfügig/.test(t)) out.push('geringfuegig');
  return out;
}
// Sert şart kalıpları. "von Vorteil / wünschenswert / idealerweise" bağlamındaki eşleşmeler şart sayılmaz.
const CERT_PATTERNS = {
  fsB: /(führerschein|lenkberechtigung)\s*(der\s*)?(klasse\s*)?b\b|\bb[\s-]?führerschein|driv(ing|er'?s) licen[cs]e\s*(class\s*)?b\b/,
  fsC: /(führerschein|lenkberechtigung)\s*(der\s*)?(klasse\s*)?c(e|1)?\b|\bc95\b|\bc[\s-]?führerschein/,
  fsD: /(führerschein|lenkberechtigung)\s*(der\s*)?(klasse\s*)?d\b|\bd[\s-]?schein\b|\bd95\b/,
  stapler: /staplerschein|stapler(fahrer)?[\s-]?(schein|berechtigung|führerschein|ausbildung)|forklift licen/,
  lap: /lehrabschluss|\blap\b|abgeschlossene lehre|gesellenbrief|facharbeiterbrief|meisterprüfung/,
  heimhilfe: /heimhilfe/,
  pa: /pflegeassistenz|pflegeassistent/,
  pfa: /pflegefachassistenz|pflegefachassistent|\bpfa\b/,
  dgkp: /\bdgkp\b|diplomierte[rs]?\s*(gesundheits- und krankenpfleg|pflege)|gehobene[nrs]? dienst(es)? für gesundheits/,
  elementar: /bafep|bakip|elementarpädagogische ausbildung|ausbildung (zur|zum) elementarpädagog|kolleg für elementarpädagogik/,
  sfk: /sicherheitsfachkraft[\s-]?(ausbildung|zertifikat|kurs)|ausbildung zur sicherheitsfachkraft|sfk[\s-]?ausbildung/,
};
const OPTIONAL_CUE = /vorteil|wünschenswert|idealerweise|nice to have|\bplus\b|gerne gesehen|erwünscht|optional|weiterbildung|nicht erforderlich|z\.\s?b\.|\betwa\b/;
// Eşleşmenin bulunduğu cümle/madde (., •, ; veya satır sonuna kadar) — ipucu sadece AYNI maddede aranır.
function clauseAround(t, i, len){
  const before = t.slice(Math.max(0, i - 120), i);
  const after = t.slice(i + len, i + len + 120);
  const b = Math.max(before.lastIndexOf('. '), before.lastIndexOf('•'), before.lastIndexOf(';'), before.lastIndexOf('\n'));
  const aIdx = after.search(/\. |•|;|\n/);
  return before.slice(b + 1) + t.substr(i, len) + (aIdx === -1 ? after : after.slice(0, aIdx));
}
const NURSE_ORDER = ['heimhilfe','pa','pfa','dgkp'];
function certsFromText(title, text){
  const t = ((title || '') + ' \n ' + (text || '')).toLowerCase();
  const found = new Set();
  for(const [key, re] of Object.entries(CERT_PATTERNS)){
    const g = new RegExp(re.source, 'g');
    let m;
    while((m = g.exec(t))){
      const win = clauseAround(t, m.index, m[0].length) + ' ' + t.slice(Math.max(0, m.index - 40), m.index);
      if(!OPTIONAL_CUE.test(win)){ found.add(key); break; }
      if(g.lastIndex === m.index) g.lastIndex++;
    }
  }
  // Pflege: "DGKP oder PFA" gibi — herhangi biri yeter, en düşük seviye şarttır.
  const nurse = NURSE_ORDER.filter(k=> found.has(k));
  if(nurse.length > 1) nurse.slice(1).forEach(k=> found.delete(k));
  // C/D ehliyeti B'yi zaten içerir.
  if(found.has('fsB') && (found.has('fsC') || found.has('fsD'))) found.delete('fsB');
  return [...found];
}
const EMPLOYER_TYPE_RULES = [
  [/bitpanda|start-?up|gostudent|refurbed|tourradar|n26/i, 'startup'],
  [/magistrat|stadt wien(?! ?(energie|werke|linien))|bundesministerium|\bams\b|bildungsdirektion|gemeinde|landesregierung|republik österreich|universität|\btu wien\b/i, 'public'],
  [/rotes kreuz|caritas|diakonie|volkshilfe|hilfswerk|samariter|\be\.\s?v\.|verein|\bngo\b/i, 'ngo'],
  // Site 4 tür ayırıyor: Unternehmen (Konzern/KMU/Beratung), Start-up, Öffentlicher Dienst, NGO.
  [/kpmg|pwc|\bbdo\b|\bey\b|ernst|deloitte|\bbcg\b|mckinsey|\bbain\b|schönherr|kanzlei|agentur|consulting|erste|raiffeisen|\brbi\b|uniqa|\bomv\b|red bull|helvetia|öbb|\bpost\b|unicredit|generali|vienna insurance|\bvig\b|andritz|stadtwerke|wiener linien|wien energie|magenta|\ba1\b|becton|philip morris|\bpmi\b|mediamarkt|lindt|volksbank|amundi|bmw|siemens|verbund|spar\b|rewe|billa|voestalpine|strabag|porr/i, 'konzern'],
];
function employerTypeFor(company){
  if(company && company.employerType) return company.employerType;
  const n = (company && company.name) || '';
  for(const [re, type] of EMPLOYER_TYPE_RULES) if(re.test(n)) return type;
  return null;
}
// (27.09 test crawl'ı) Genel crawler bazen ilan yerine sitenin gezinme sayfalarını ("Job Alert",
// "Aktuelle Stellenangebote", "Newsletter", "Privacy policy") ilan sanıyor, bazen de başlığa sayfa
// artığı yapışıyor ("All Select how often… Apply now » IT Solutions Expert … About the role").
const JUNK_TITLE = /^(job ?alert|jobalert|newsletter|praktika|praktikum|jobs?|karriere|stellenangebote|aktuelle (jobs|stellenangebote).*|unsere job-angebote.*|finde deinen job.*|international job opportunities|privacy policy|job details|mitmachen.*|[a-zäöü]+ intern|traineeprogramme.*|arbeiten für.*|jobs bei.*|praktika bei.*|hier bist du .*|spendenkonto|notschlafstelle.*|.*notschlafstelle.*|winternotquartier.*|kontaktstelle .*|.* hilft:?|es g.hört .*|step2job|datenschutz-präferenz.*|cookie.*|bewerben|jetzt bewerben|jobs plus ausbildung|zivildien.*|praktikum bei der .*|unser .* berufslexikon|neue chancen.*|work mode .*|do you want to switch the language.*|.* posted da.*)$/i;
function cleanTitle(t){
  // (27.09) Stadt Wien başlıkları ayrıştırılmış Unicode'la geliyor ("fu" + birleşik ¨): NFC'ye çevir,
  // yoksa "für", "Ärzt" gibi kelimeler hiçbir kurala uymuyor.
  let x = String(t || '').normalize('NFC').replace(/\s+/g, ' ').trim();
  x = x.replace(/^.*apply now »\s*/i, '').replace(/\s+about the role.*$/i, '');
  x = x.replace(/^zurück zu allen stellen/i, '').trim();
  return x;
}
function isJunkTitle(t){
  const x = String(t || '').trim();
  // 28.09: sayfa uyarıları/cümleler ilan başlığı sanılıyordu ("Bitte beachten Sie, dass Sie Videos …").
  const sentenceLike = x.split(/\s+/).length > 12 && /[.!?]$/.test(x);
  // 30.09: başlık sadece şirket adıysa ("UniCredit") gerçek ilan değil
  if(/^(unicredit|uniqa|raiffeisen|erste|kpmg|pwc|deloitte|ey|bdo|öbb|oebb|billa|spar|hofer|rewe|a1|magenta|omv|verbund|post|generali|helvetia|wienerberger|andritz)(\s+(bank|group|austria|österreich|ag|gmbh))*$/i.test(x)) return true;
  return !x || x.length < 4 || x.length > 140 || JUNK_TITLE.test(x) || /auf diese stelle bewerben|€ pro monat/i.test(x) || /\bresults?\)? found\b|ergebnisse gefunden|^\d+\s+(jobs?|stellen|treffer|ergebnisse|results?)\b/i.test(x) // 10.10: Takeda '831 result(s) found'
    || /bitte beachten sie|please note that|cookies?\b|javascript|videos auf dieser|videos on this website|enable (javascript|cookies)/i.test(x) || sentenceLike;
}
// Başlıkta Wien dışı bir şehir açıkça yazıyorsa (ör. "Customer Support Agent (Toronto)") ilan Wien'de
// değil — sayfanın başka bir yerinde "Wien" geçtiği için şehir filtresinden kaçabiliyor.
const FOREIGN_CITY_IN_TITLE = /\b(toronto|london|berlin|münchen|munich|hamburg|frankfurt|köln|cologne|düsseldorf|stuttgart|zürich|zurich|basel|bern|genf|geneva|barcelona|madrid|paris|mailand|milan|prag|prague|budapest|warschau|warsaw|bukarest|bratislava|ljubljana|zagreb|belgrad|sofia|australia|usa|germany|deutschland|schweiz|switzerland|italien|italy|slovakia|slowakei|czech|tschechien|hungary|ungarn|poland|polen|romania|rumänien)\b/i;
const OTHER_CITY_IN_TITLE = /\b(toronto|london|berlin|münchen|munich|hamburg|zürich|zurich|barcelona|madrid|paris|prag|prague|budapest|warschau|warsaw|bukarest|bratislava|graz|linz|salzburg|innsbruck|klagenfurt|st\.? ?pölten|wels|villach|dornbirn|bregenz|feldkirch|bludenz|kufstein|wörgl|lienz|schwaz|imst|landeck|spittal|wolfsberg|leoben|kapfenberg|judenburg|knittelfeld|hartberg|weiz|gleisdorf|leibnitz|deutschlandsberg|steyr|gmunden|vöcklabruck|ried im innkreis|braunau|schärding|freistadt|perg|hallein|zell am see|bischofshofen|amstetten|krems|zwettl|horn|hollabrunn|mistelbach|melk|scheibbs|lilienfeld|neunkirchen|wiener neustadt|eisenstadt|oberwart|güssing|jennersdorf|tirol|vorarlberg|oberösterreich|steiermark|kärnten|burgenland|australia|usa)\b/i;
// Şirket adı sayfadan değil alan adından türetildiyse ("Univie", "Ait", "DOCO1", "Wien") companies.json'daki düzgün ad kullanılır.
function isSlugCompanyName(name, url){
  const n = String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if(!n) return true;
  const u = String(url || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return n.length <= 20 && u.includes(n);
}
// Başlıkta Wien dışı bir posta kodu ("4693 Desselbrunn") ya da başka bir fabrika ("Werk Haiding") geçiyorsa
// ilan Wien'de değil — şirket merkezi Wien'de olduğu için konum alanı yanlışlıkla "Wien" görünebiliyor.
function isNonViennaTitle(t){
  const x = String(t || '');
  const m = x.match(/\b([1-9]\d{3})\s+[A-ZÄÖÜ][\wäöüß.\-]+/);
  if(m && !/^1[0-2]\d0$/.test(m[1])) return true;
  return /\bwerk\s+(?!wien)[a-zäöüß]{4,}/i.test(x);
}
// Başlık sayfanın genel başlığıysa ("Arbeiten für Wien – viel mehr als nur ein Job!") gerçek başlığı
// ilan metninden ya da URL'deki jobTitle parametresinden kurtar (jobs.wien.gv.at'te 40 ilan böyleydi).
// 29.09: Whittle Apply için temiz ilan metni (_adText). Ham metin çoğu zaman çerez bandı + menü ile başlıyor
// (KPMG/SuccessFactors) ve Datenschutz/Impressum ile bitiyor. Gürültüyü kırpıp ilk 7000 karakteri tutuyoruz —
// böylece öğrenci Apply'da metni kendisi yapıştırmak zorunda kalmıyor.
function cleanAdText(raw, title){
  // 29.09 (2): satır yapısı korunuyor. HTML açıklamalarda (JSON-LD/ATS) blok etiketleri satır sonuna,
  // sayfa dökümlerinde _adLines zaten satırlı geliyor. Apply bu satırları madde olarak okuyor.
  let t = decodeHtmlEntities(String(raw || '')).normalize('NFC')
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\s*br\s*\/?>/gi, '\n').replace(/<\s*\/?\s*(li|p|h[1-6]|div|tr|ul|ol|section|dt|dd)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|\u00a0/g, ' ').replace(/&amp;/g, '&').replace(/&euro;/gi, '€')
    .replace(/[ \t]+/g, ' ').replace(/ *\n\s*/g, '\n').trim();
  if(!t) return '';
  const ck = t.search(/cookie/i);
  if(ck > -1 && ck < 2500){
    const key = String(title || '').slice(0, 25);
    const starts = [key && t.lastIndexOf(key), t.search(/stellenbeschreibung|job description|deine aufgaben|ihre aufgaben|your tasks|das erwartet dich/i)].filter(i => i > ck);
    if(starts.length) t = t.slice(Math.min(...starts));
  }
  // 01.10: Satır sonu/nokta olmayan düzleşmiş metinde (KPMG/SuccessFactors) "cümle" binlerce karaktere yayılıyordu:
  // sondaki çerez notu, öncesindeki Kompetenzen/Profil bölümünü de siliyordu. Kesilen parça artık çerez kelimesinin en fazla 30 karakter öncesinden başlıyor.
  t = t.replace(/[^.!?\n]{0,30}(cookie|javascript aktivieren|enable javascript|datenschutz-präferenz)[^.!?\n]{0,200}[.!?]?/gi, ' ');
  const tail = t.search(/\b(impressum|datenschutzerklärung|privacy policy|alle rechte vorbehalten|all rights reserved|©)/i);
  if(tail > 1500) t = t.slice(0, tail);
  // 30.09: onlyfy (Magenta) gibi sayfalarda CSS/JS satırları metne karışıyordu — kod gibi görünen satırlar atılıyor.
  const CODE_LINE = /[{};]\s*$|^[.#@][\w-]|^\/[*\/]|^\*\/|function\s*\(|=>|^(var|const|let)\s|:\s*#[0-9a-f]{3,6}\b|^[\\\/_`>| -]{3,}$/i;
  t = t.split('\n').filter(l => { const x = l.trim(); return x.length > 300 || !CODE_LINE.test(x); }).join('\n');
  if(t.replace(/\s+/g, ' ').trim().length < 200) return ''; // gerçek ilan metni yok — Apply kendi okumayı denesin
  // 01.10: KPMG/RBI gibi portallarda ilk binlerce karakter menü + tanıtım; "Qualifikationen" bölümü 3.500 sınırının
  // dışında kalıyordu (Apply'da Muss listesi boş). İlk bölüm başlığının biraz öncesinden başla, 7.000'e kadar tut.
  // 09.10: başlıklar sadece SATIR BAŞINDA sayılıyor — "…runden dein Profil ab" cümlesi başlık sanılıp metnin sadece son kısmı (benefits) kalıyordu (NAVAX).
  const head = t.search(/^[ \t•·*-]*(?:(deine|ihre|your)\s+(aufgaben|rolle|role|tasks)|das erwartet dich|was dich erwartet|aufgaben\s*:?$|your role|what you(?:'|’)ll do|dein profil|ihr profil|qualifikationen|das bringst du mit|what you bring|requirements)/im);
  if(head > 800) t = t.slice(Math.max(0, head - 400));
  return t.replace(/[ \t]+/g, ' ').replace(/ *\n\s*/g, '\n').trim().slice(0, 7000);
}
// 01.10: İlan EU/EWR vatandaşlığı ya da kısıtsız çalışma izni istiyor mu? (Stadt Wien, WIGEV, bazı bankalar.)
// Whittle'da "çalışma iznine ihtiyacım var" diyen öğrencilere bu ilanlar gösterilmiyor (requiresPermit=true).
// 12.10: Başlangıç tarihi (AI'sız, ucuz kural). Belirli ay > "ab sofort". Bulamazsa undefined → AI'ya "start" sorulur.
const START_MONTHS = { 'jänner':1,'januar':1,'january':1,'jan':1,'februar':2,'feber':2,'february':2,'feb':2,'märz':3,'maerz':3,'march':3,'april':4,'apr':4,'mai':5,'juni':6,'june':6,'juli':7,'july':7,'august':8,'aug':8,'september':9,'sept':9,'sep':9,'oktober':10,'october':10,'okt':10,'oct':10,'november':11,'nov':11,'dezember':12,'december':12,'dez':12,'dec':12 };
function guessStart(text){
  const t = String(text || '').toLowerCase();
  const now = new Date(), cy = now.getFullYear(), cm = now.getMonth() + 1;
  const ym = (y, m)=>{ if(!y){ y = m >= cm ? cy : cy + 1; } return `${y}-${String(m).padStart(2,'0')}`; };
  const mn = Object.keys(START_MONTHS).sort((a,b)=> b.length - a.length).join('|');
  const lead = '(?:\\bab\\b|beginn\\w*|eintritt\\w*|start\\w*|starttermin|from|starting|commencing|dienstantritt)';
  let m = t.match(new RegExp(lead + '[^.\\n]{0,25}?\\b(\\d{1,2})\\.\\s?(\\d{1,2})\\.\\s?(20\\d\\d)\\b'));
  if(m){ const mo = Number(m[2]); if(mo >= 1 && mo <= 12) return ym(Number(m[3]), mo); }
  m = t.match(new RegExp(lead + '[^.\\n]{0,25}?\\b(' + mn + ')\\b\\.?\\s*(20\\d\\d)?'));
  if(m) return ym(m[2] ? Number(m[2]) : null, START_MONTHS[m[1]]);
  if(/ab sofort|zum (ehest|nächst)möglichen (zeitpunkt|termin)|nächstmöglich|as soon as possible|\basap\b|immediate start|start(ing)? immediately|per sofort/.test(t)) return 'asap';
  return undefined;
}
// 12.10: İlan, üniversite/FH şartına ALTERNATİF olarak okul türü kabul ediyor mu ("HTL, FH oder Uni", "HAK oder Studium").
// Sitede: Ausbildung'da HTL/HAK seçen biri bu ilanlarda Bachelor şartından elenmiyor.
function schoolOkFrom(text){
  const t = String(text || ''), out = new Set();
  const re = /\b(HTL|HAK|HAS|Handelsakademie|HLW|HBLA)\b/g; let m;
  while((m = re.exec(t))){
    const ctx = t.slice(Math.max(0, m.index - 90), m.index + 90);
    if(!/\bFH\b|Fachhochschul|\bUni\b|Universit|Studium|Hochschul/i.test(ctx)) continue;
    const k = /HTL/i.test(m[1]) ? 'htl' : /HLW|HBLA/i.test(m[1]) ? 'bhs' : 'hak';
    out.add(k);
  }
  return out.size ? [...out] : undefined;
}
// 12.10: İlan açıkça Pflichtpraktikum / zorunlu staj olarak yapılabileceğini söylüyor → sitede rozet.
const PFLICHT_RE = /pflichtpraktik|pflicht-praktik|verpflichtende[sn]? praktikum|curriculare?s? praktikum|praktikum im rahmen (deines|ihres|eines|des) studium|mandatory internship|compulsory internship|curricular internship|internship (as part of|required by) (your|the) (studies|curriculum|degree)/i;
const WORK_PERMIT_RE = /\b(eu|ewr|eea)[- ]?(staatsbürgerschaft|bürger(?:schaft)?|staatsangehörigkeit|citizenship|citizen|passport)\b|österreichische staatsbürgerschaft|staatsbürgerschaft eines eu|(uneingeschränkte[nr]?|unbeschränkte[nr]?|freie[nr]?) (zugang|zutritt) zum (österreichischen |eu-? ?)?arbeitsmarkt|(gültige|aufrechte) (arbeits|beschäftigungs)(bewilligung|erlaubnis)|arbeitserlaubnis (für österreich )?(ist )?(erforderlich|voraussetzung|notwendig)|(valid|existing) (eu |austrian )?work permit|right to work in (austria|the eu)|unrestricted access to the (austrian|eu|european) labou?r market|no (visa )?sponsorship|available for work visa sponsorship\?\s*no/i;
function needsWorkPermit(text){ return WORK_PERMIT_RE.test(String(text || '').replace(/\s+/g, ' ')); }
// 23.10: Wochenstunden-Sätze aus dem VOLLEN Text (_rawText wird auf 4000 Zeichen gekürzt – Stunden stehen oft am Ende).
function hoursSnippets(text){
  const s = String(text || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;| /g, ' ').replace(/\s+/g, ' ');
  const re = /[^.!?]{0,80}\b\d{1,2}(?:[,.]\d)?\s*(?:(?:-|–|bis|to)\s*\d{1,2}(?:[,.]\d)?)?\s*(?:wochenstunden|wochenstd|stunden|std\.?|h\s*\/|hours?)[^.!?]{0,60}/gi;
  const out = []; let m;
  while((m = re.exec(s)) && out.join(' ').length < 400){ if(/woche|week|wk|vollzeit|teilzeit|full|part/i.test(m[0])) out.push(m[0].trim()); }
  return out.length ? out.join(' | ').slice(0, 400) : null;
}
function salarySnippets(text){
  const s = String(text || '').replace(/<[^>]+>/g, ' ').replace(/&euro;/gi, '€').replace(/&nbsp;|\u00a0/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
  // Cümle sınırı: . ! ? — ama rakamlar arasındaki nokta (3.713,75) sınır sayılmıyor.
  const re = /(?:[^.!?]|\.(?=\d)){0,160}(?:€|\bEUR\b|\bEuro\b)(?:[^.!?]|\.(?=\d)){0,160}/gi;
  const cue = /brutto|gross|gehalt|entgelt|entlohnung|salary|vergütung|kollektivvertrag|\bkv\b|monat|month|jahr|year|stunde|hour|überzahlung|mindest/i;
  const out = [];
  let m;
  while((m = re.exec(s)) && out.join(' ').length < 600){ if(cue.test(m[0])) out.push(m[0].trim()); }
  return out.length ? out.join(' | ').slice(0, 600) : null;
}
function recoverTitle(title, rawText, url){
  if(!isJunkTitle(title)) return title;
  const t = String(rawText || '');
  const m = t.match(/(?:Folgende Stelle wollen wir besetzen|Wir suchen|Stellenbezeichnung|Position)\s*:?\s*(.{4,140}?)\s+(?:Jetzt bewerben|Bewerben|Apply now)/i);
  if(m && !isJunkTitle(cleanTitle(m[1]))) return cleanTitle(m[1]);
  try{
    const q = new URL(url).searchParams.get('jobTitle') || new URL(url).searchParams.get('title');
    if(q){ const x = cleanTitle(decodeURIComponent(q).replace(/-/g, ' ')); if(!isJunkTitle(x)) return x; }
  }catch(e){ /* geçersiz URL */ }
  return title;
}
// 30.09: bazı sitelerde konum alanına paragraf giriyor ("Wien betreibt der Wiener Gesundheitsverbund insgesamt
// 7 Kliniken…", "Wien (Allgemein) Wir haben das klare Ziel…"). Uzun/cümle gibi konumlardan yer adlarını ayıklıyoruz.
const AT_PLACE_TOKEN_RE = new RegExp(`(?<![a-zäöüß])(?:${AT_PLACES})(?![a-zäöüß])`, 'gi');
function cleanLocation(loc){
  const raw = String(loc || '').replace(/\s+/g, ' ').trim();
  if(!raw) return raw;
  const parts = raw.split('|').map(x => x.trim()).filter(Boolean);
  const looksSentence = x => x.length > 60 || x.split(' ').length > 8;
  if(!parts.some(looksSentence)) return raw;
  const good = parts.filter(x => !looksSentence(x) && !/^\d+\s*(locations?|standorte?)$/i.test(x));
  const goodLc = good.join(' ').toLowerCase();
  const found = [];
  parts.filter(looksSentence).forEach(x => (x.match(AT_PLACE_TOKEN_RE) || []).forEach(m => {
    const n = m.charAt(0).toUpperCase() + m.slice(1).toLowerCase();
    if(!/^(österreich|oesterreich|austria)$/i.test(n) && !goodLc.includes(n.toLowerCase()) && !found.some(f => f.toLowerCase() === n.toLowerCase())) found.push(n);
  }));
  const out = [...good, ...found.slice(0, 3)];
  return out.length ? out.join(' | ') : 'Österreich';
}
function addExtraFields(item, company){
  if(item && item._knownExcluded) return item; // artımlı tarama: daha önce elenmiş link, yer tutucu
  if(item && item.sourceNote) item = { ...item, sourceNote: cleanLocation(item.sourceNote) };
  item = { ...item, title: cleanTitle(item.title), _rawText: item._rawText ? String(item._rawText).normalize('NFC') : item._rawText };
  item.title = recoverTitle(item.title, item._rawText, item.externalUrl);
  if(company && company.name && (isSlugCompanyName(item.companyName, company.url) || /^ingka\b/i.test(item.companyName || ''))){
    item.companyName = company.name;
  }
  const titleEmp = empFromTitle(item.title);
  const emp = titleEmp.length ? titleEmp : empFromText(item._rawText);
  const out = { ...item };
  // 29.09: Avusturya modunda konumu bilinmeyen ilan ("Österreich") başlıkta yer adı taşıyorsa onu kullan
  // ("Zugbegleiter:in Quereinstieg, Tirol" → Tirol). ÖBB'de ~165 ilan böyleydi, her eyalette görünüyordu.
  if(isAustriaMode(item._city) && (!item.sourceNote || /^(österreich|oesterreich|austria|at)$/i.test(String(item.sourceNote).trim()))){
    const re = new RegExp(buildCityRegex('AT').source, 'gi'); let m, place = null;
    while((m = re.exec(item.title || ''))){ if(!/^(austria|österreich|oesterreich)$/i.test(m[0])){ place = m[0]; break; } }
    if(place) out.sourceNote = place;
  }
  out.emp = emp.length ? emp : null;
  // Metin yoksa sertifika şartı hakkında bir şey bilemeyiz (null); metin varsa ve hiçbir şart
  // geçmiyorsa [] (bilinen: şart yok). Başlıkta geçen şart (ör. "Autobuslenker mit D-Schein") her durumda sayılır.
  const certs = certsFromText(item.title, item._rawText);
  out.certs = certs.length ? certs : (item._rawText ? [] : null);
  out.employerType = employerTypeFor(company);
  return out;
}

// shard: { index, total } — GitHub Actions'ta liste N paralel işe bölünüyor (tek iş 3 saat sınırını
// aşmasın diye). Şirketler sırayla dağıtılıyor (0,4,8… → 1. parça; 1,5,9… → 2. parça), böylece
// listede yan yana duran büyük şirketler aynı parçaya yığılmıyor. Her parça kendi sonuç dosyasını,
// kendi AI kota payını (80/N) ve kendi cache kopyasını yazıyor; merge-results.js hepsini birleştiriyor.

// 13.10: Detay sayfası önbelleği (GitHub Actions dakikası). Dünkü taramada İLAN olarak görülen bir URL'in HTML sayfası
// 7 gün boyunca yeniden indirilmez, önbellekten verilir. Liste sayfaları / API cevapları önbelleğe girmez: sadece sonunda
// bir ilanın externalUrl'i olduğu anlaşılan HTML sayfaları saklanıyor. Yeni ilanlar ve 7 günden eski kayıtlar normal çekilir.
const zlib = require('zlib');
const DETAIL_CACHE_DAYS = 7;
function installDetailCache(file){
  let cache = {};
  try{ cache = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8')); }catch(e){}
  const now = Date.now(), fresh = {};
  for(const [u, v] of Object.entries(cache)) if(v && v.at && now - Date.parse(v.at) < DETAIL_CACHE_DAYS * 864e5) fresh[u] = v;
  let seen = {};
  const stats = { hit: 0, fetched: 0, loaded: Object.keys(fresh).length };
  const orig = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || String(input);
    const method = String((init && init.method) || (input && typeof input === 'object' && input.method) || 'GET').toUpperCase();
    if(method === 'GET' && fresh[url]){ stats.hit++; const v = fresh[url]; return new Response(v.body, { status: 200, headers: { 'content-type': v.ct || 'text/html' } }); }
    const res = await orig(input, init);
    if(method === 'GET' && res.ok){
      stats.fetched++;
      try{ const ct = res.headers.get('content-type') || ''; if(/html/i.test(ct)){ const body = await res.clone().text(); if(body.length < 1500000) seen[url] = { body, ct, at: new Date().toISOString() }; } }catch(e){}
    }
    return res;
  };
  return {
    stats,
    // items: o ana kadar bulunan bütün ilanlar. İlan olmayan (liste sayfası vb.) indirilenler bellekten atılıyor.
    save(items){
      const urls = new Set(); for(const it of items || []){ const u = it && (it.externalUrl || it.url); if(u) urls.add(u); }
      const keep = {}, nextSeen = {};
      for(const u of urls){ if(seen[u]){ keep[u] = seen[u]; nextSeen[u] = seen[u]; } else if(fresh[u]) keep[u] = fresh[u]; }
      seen = nextSeen;
      try{ fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(keep))); }catch(e){ console.log(`⚠️  Detay önbelleği yazılamadı: ${e.message}`); }
      return Object.keys(keep).length;
    }
  };
}
async function runCrawlBatch(configFile, shard){
  const fullConfig = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  const config = shard ? fullConfig.filter((_, i) => i % shard.total === shard.index - 1) : fullConfig;
  const detailCache = process.env.WHITTLE_DETAIL_CACHE ? installDetailCache(process.env.WHITTLE_DETAIL_CACHE) : null;
  if(detailCache) console.log(`🗂️  Detay önbelleği: ${detailCache.stats.loaded} ilan sayfası (≤ ${DETAIL_CACHE_DAYS} gün) yüklendi.`);
  const shardTag = shard ? `-shard${shard.index}` : '';
  if(shard) console.log(`🧩 Parça ${shard.index}/${shard.total}: ${config.length}/${fullConfig.length} şirket bu işte taranacak.`);
  const aiCacheOut = shard ? path.join(__dirname, 'results', `ai-soft-cache${shardTag}.json`) : AI_CACHE_FILE;
  const MAX_AI_THIS_RUN = shard ? Math.floor(MAX_AI_CALLS_PER_RUN / shard.total) + (shard.index === 1 ? MAX_AI_CALLS_PER_RUN % shard.total : 0) : MAX_AI_CALLS_PER_RUN;
  const all = [];
  const perCompany = new Array(config.length); // index'e göre dolduruluyor — paralel tamamlanma sırası config sırasıyla aynı olmayabilir
  // AI soft-field katmanı: cache tüm koşu boyunca paylaşılıyor (aynı ilan iki şirket listesinde
  // aynı anda çıkmaz ama farklı günlerdeki koşular arasında persist etmesi asıl amaç), budget ise
  // SADECE bu koşu için — bir sonraki günde MAX_AI_CALLS_PER_RUN'dan yeniden başlar. budget.remaining
  // kontrolü ve azaltması (enrichSoftFieldsForItems içinde) aynı senkron adımda yapıldığı için,
  // paralel şirketler arasında await araya girmiyor — JS tek thread'li olduğu için yarış durumu yok.
  const aiCache = loadAiCache();
  // 28.09: öğrenilmiş kurallar koşu başında cache'ten hesaplanıyor (koşu içinde sabit — paralel parçalar tutarlı kalsın).
  const learnedRules = learning.buildLearnedRules(aiCache);
  KNOWN_LINKS = loadKnownLinks(path.join(__dirname, 'results'));
  console.log(`♻️  Önceki taramalardan bilinen ilan linki: ${KNOWN_LINKS.size}`);
  const ruleCount = Object.values(learnedRules).reduce((n, l) => n + l.length, 0);
  console.log(`🧠 Öğrenilmiş kural: ${ruleCount} (${Object.keys(learnedRules).join(', ') || '—'})`);
  const outDir = path.join(__dirname, 'results');
  if(!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  // DÜZELTME (26.09): kota artık GÜNLÜK ve iki tarama (companies + problem-companies) arasında
  // PAYLAŞILIYOR. Eskiden her --crawl-batch kendi 80'iyle başlıyordu → iki tarama = günde 160 çağrı.
  // Bugün kullanılan sayı results/ai-budget-<tarih>.json'da tutuluyor (results/*.json zaten commit'leniyor).
  const budgetFile = path.join(outDir, `ai-budget-${new Date().toISOString().slice(0, 10)}${shardTag}.json`);
  let usedToday = 0;
  try{ if(fs.existsSync(budgetFile)) usedToday = JSON.parse(fs.readFileSync(budgetFile, 'utf8')).used || 0; }catch(e){ /* okunamazsa 0 */ }
  const batchMode = process.env.WHITTLE_AI_MODE === 'batch';
  const aiBudget = { remaining: Math.max(0, MAX_AI_THIS_RUN - usedToday), queue: batchMode ? [] : null };
  const queueFile = path.join(outDir, `ai-queue-${new Date().toISOString().slice(0, 10)}${shardTag}.json`);
  const saveQueue = () => { if(batchMode){ try{ fs.writeFileSync(queueFile, JSON.stringify(aiBudget.queue)); }catch(e){} } };
  const saveBudget = () => { try{ fs.writeFileSync(budgetFile, JSON.stringify({ used: MAX_AI_THIS_RUN - aiBudget.remaining, max: MAX_AI_THIS_RUN })); }catch(e){} };
  console.log(`🤖 AI kotası: bugün ${usedToday}/${MAX_AI_THIS_RUN} kullanılmış, bu taramada ${aiBudget.remaining} kaldı.`);
  const dateStr = new Date().toISOString().slice(0, 10);
  // DÜZELTME (24 Eylül — Eren artık aynı gün hem otomatik `companies.json` hem elle
  // `problem-companies.json` çalıştıracak): dosya adı sadece tarihe göreyse ikisi birbirini
  // ezer. Config dosyasının adından (uzantısız) bir sonek türetiyoruz — "companies.json" geriye
  // dönük uyumluluk için soneksiz kalıyor (otomasyon zaten bunu bekliyor), başka her config kendi
  // adıyla ayrı dosyaya yazıyor (ör. "problem-companies.json" -> whittle-import-2026-09-24-problem.json).
  const configBase = path.basename(configFile, '.json');
  // 02.10: 'problem-companies' → '-problem' (eskiden '-companies' çıkıyordu; merge-results '-problem' bekliyor → hiç birleşmiyordu).
  const suffix = configBase === 'companies' ? '' : configBase === 'problem-companies' ? '-problem' : `-${configBase}`;
  const outFile = path.join(outDir, `whittle-import-${dateStr}${suffix}${shardTag}.json`);

  // DÜZELTME (Eren'in GitHub Actions'ta yaşadığı sorun): eskiden sonuç dosyası SADECE tüm
  // şirketler bitince, döngünün en sonunda tek seferde yazılıyordu — GitHub Actions'ın 60
  // dakikalık zaman aşımına (ya da başka bir çökmeye) yakalanırsa dosya HİÇ yazılmadan tüm o
  // sürenin emeği kayboluyordu. Artık HER GRUPTAN (bkz. CRAWL_CONCURRENCY) SONRA o ana kadarki
  // sonucu dosyaya yazıyoruz — yarıda kesilse bile o ana kadar işlenen şirketlerin verisi elde kalıyor.
  function writeProgress(){
    const doneCompanies = perCompany.filter(Boolean);
    const { included, excluded } = splitByTargetFit(all);
    // DUZELTME (Eren'in istegi uzerine — "hangi keyword'u kacirdik" sorusunu cevaplayabilmek
    // icin): bir ilanin "estimated" dizisi regex + AI katmani calistiktan SONRA bile hala doluysa
    // (yani en az bir alani hicbir sekilde belirleyemedik demek — cogunlukla deg/de/en/exp, cunku
    // bunlar icin AI katmani yok, sadece regex var), ham ilan metnini (_rawText) artik SILMIYORUZ.
    // Boylece bu JSON Claude'a atilip "bu ilanin metninde X icin hangi cumle var ama regex'e hic
    // eklenmemis" diye incelenebiliyor, kacirilan gercek keyword'ler parser'a eklenebiliyor. Zaten
    // TAMAMEN cozulmus (estimated bos) ilanlarda hala siliyoruz — dosya boyutu gereksiz sismesin,
    // Whittle'in "Toplu Ice Aktar" kutusuna yapistirilacak asil veri hala hafif kaliyor.
    // _rawText artık HER ilanda kalıyor: site, alt kategori sorularının cevaplarını (Außendienst,
    // Nachtdienste, Kühllager...) import sırasında bu metinden çıkarıyor. İlk 4000 karakter yeterli (site de ilk 4000 karaktere bakıyor).
    // 28.09: Avusturya'da ilanlarda asgari maaş yazmak zorunlu (§ 9 Abs 2 GlBG), ama genelde metnin SONUNDA —
    // 4000 karakterlik kesimde kayboluyordu. Kesmeden önce tam metinden maaş cümlelerini ayırıyoruz.
    const cleanItems = included.map(it => it._rawText ? { ...it, _salaryText: it._salaryText || salarySnippets(it._rawText), _hoursText: it._hoursText || hoursSnippets(it._rawText), _adText: it._adText || cleanAdText(it._adLines || it._rawText, it.title), requiresPermit: needsWorkPermit(it._rawText) || undefined, pflicht: PFLICHT_RE.test(it.title + ' ' + it._rawText) || undefined, start: it.start || guessStart(it._rawText), schoolOk: schoolOkFrom(it._rawText), _adLines: undefined, _rawText: String(it._rawText).slice(0, 4000) } : it);
    // EKLENDİ (Eren'in "elenenler gerçekten doğru sebeple mi elendi" sorusu üzerine): elenen
    // ilanlar eskiden SADECE konsol log'una basılıyordu, dosyaya hiç yazılmıyordu — yani bu soruyu
    // her cevaplamak istediğimizde ya GitHub Actions log'unu elle kopyalaman ya da script'i yeniden
    // çalıştırmamız gerekiyordu. Artık hafif bir özet (title/şirket/sebep — ham açıklama metni YOK,
    // dosya şişmesin diye) results dosyasına da yazılıyor, ben doğrudan kontrol edebiliyorum.
    const excludedSummary = excluded.map(it => ({
      _srcLink: it._srcLink, _fetchedAt: it._fetchedAt,
      title: it.title, companyName: it.companyName,
      reason: it.seniorityGuess === 'senior' ? 'senior' : 'genericApplication'
    }));
    fs.writeFileSync(outFile, JSON.stringify({
      date: dateStr, totalCompanies: config.length,
      completedCompanies: doneCompanies.length, inProgress: doneCompanies.length < config.length,
      perCompany: doneCompanies, totalItems: included.length, totalExcludedSenior: excluded.length,
      items: cleanItems, excludedItems: excludedSummary
    }, null, 2));
    return included.length;
  }

  async function processCompany(company, i){
    console.log(`\n${'#'.repeat(60)}\n[${i+1}/${config.length}] ${company.name || company.url}\n${'#'.repeat(60)}`);
    try{
      // DÜZELTME (24 Eylül — BMW/Bain'in --crawl-batch modunda hep 0 dönmesinin GERÇEK sebebi):
      // bu fonksiyon şimdiye kadar company.url'i HİÇ ATS tespitinden geçirmeden doğrudan genel
      // runCrawl'a (DOM'da link arayan Puppeteer tarayıcısı) veriyordu. fetchBmwJobs/fetchBainJobs
      // gibi özel fonksiyonlar sadece TEK ilan linki işlerken (processUrl → runAtsPath) devreye
      // giriyordu — şirket listesi seviyesinde HİÇ çağrılmıyordu. BMW'nin liste URL'i saf JSON/HTML
      // parçası döndürüyor (DOM'da <a> linki yok), Bain'in API URL'i saf JSON — ikisinde de genel
      // runCrawl'ın DOM link taraması 0 sonuç buluyordu, hata da vermiyordu (site çalışıyordu,
      // sadece aradığı şey orada yoktu). Şimdi önce ATS tespiti deniyoruz; tutarsa özel fonksiyon
      // (fetchBmwJobs/fetchBainJobs/vb.) kullanılıyor, tutmazsa eskisi gibi genel crawl'a düşüyor.
      // 28.09: WHITTLE_REGION=AT (workflow'da) tüm şirketleri Avusturya geneline açar; config'teki "city" değerini geçersiz kılar.
      // 02.10: config'te city "*" (OeKB: ilanlarda yer bilgisi yok) bölge ayarından önce gelir; aksi halde AT.
      const cityFilter = company.city === '*' ? '*' : (process.env.WHITTLE_REGION || company.city || 'Wien');
      const directAts = detectAtsFromUrl(company.url);
      // 30.09: GitHub Actions dakikası için — tarayıcıyla taranan şirketler (API'si olmayanlar) her gün değil,
      // WHITTLE_BROWSER_EVERY günde bir taranıyor (şirket adına göre sabit gruplara bölünmüş, her gün bir grup).
      // Taranmayan şirket perCompany'ye yazılmıyor → site onun ilanlarını kapatmıyor, olduğu gibi kalıyor.
      // API'li şirketler (Workday, Greenhouse, Personio, HOFER, SPAR …) saniyeler sürdüğü için her gün.
      const everyN = Math.max(1, parseInt(process.env.WHITTLE_BROWSER_EVERY || '1', 10) || 1);
      if(!directAts && everyN > 1 && !company.daily){
        let h = 0; for(const ch of String(company.name || company.url)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
        const today = Math.floor(Date.now() / 86400000);
        if(h % everyN !== today % everyN){
          console.log(`⏭️  Bugün sırası değil (tarayıcı taraması ${everyN} günde bir) — atlandı, ilanları sitede açık kalıyor.`);
          return;
        }
      }
      let result;
      if(directAts){
        console.log(`ATS tespit edildi (URL'den): ${directAts.type} — özel entegrasyon kullanılıyor.\n`);
        directAts.cityFilter = cityFilter;
        const atsResult = await runAtsPath(directAts, company.url, cityFilter);
        result = { items: atsResult.items };
        // Workday CXS henüz canlıda doğrulanmadı — API boş/başarısızsa eski crawl akışına düş.
        if((directAts.type === 'workday' || directAts.type === 'successfactors') && !atsResult.ok){
          console.log('  Workday API sonuç vermedi — genel crawl akışına düşülüyor.');
          result = await runCrawl(company.url, cityFilter);
        }
      } else {
        result = await runCrawl(company.url, cityFilter, { sitemap: company.sitemap, linkPattern: company.linkPattern, pageTemplate: company.pageTemplate, maxPages: company.maxPages });
      }
      let items = (result && result.items) || [];
      // 02.10: ortak ATS'ler (ör. Marsh McLennan Workday'i = Marsh + Mercer + Oliver Wyman) — config "onlyIf" regex'i
      // başlık/şirket/metnin başında geçmeyen ilanları atar.
      if(company.onlyIf){
        const re = new RegExp(company.onlyIf, 'i'), before = items.length;
        items = items.filter(it => re.test([it.title, it.companyName, it.company, String(it.description || it._adText || it._rawText || '').slice(0, 3000)].join(' ')));
        console.log(`  onlyIf /${company.onlyIf}/: ${before} → ${items.length}`);
      }
      // 15.10: tersi — eşleşenler atılıyor (Siemens AG Österreich listesi Siemens Mobility ilanlarını da içeriyor; onlar ayrı şirket).
      if(company.exceptIf){
        const re = new RegExp(company.exceptIf, 'i'), before = items.length;
        items = items.filter(it => !re.test([it.title, it.companyName, it.company, String(it.description || it._adText || it._rawText || '').slice(0, 3000)].join(' ')));
        console.log(`  exceptIf /${company.exceptIf}/: ${before} → ${items.length}`);
      }
      // 05.10: "mode": "office" → mağaza/depo/şoför ilanları AI'a gitmeden atılıyor, sadece merkez ofis + öğrenci ilanları kalıyor.
      if(company.mode === 'office'){
        const { officeTitle } = require('./ai-fields'), before = items.length;
        items = items.filter(it => officeTitle(it.title));
        console.log(`  mode=office: ${before} → ${items.length} (mağaza/depo ilanları atıldı)`);
      }
      // DÜZELTME (Eren'in fark ettiği kafa karışıklığı): eskiden buraya HAM link sayısı
      // (items.length — senior/kıdemli ilanlar dahil, hiç filtrelenmemiş) yazılıyordu. Bu, elle
      // test ettiğimiz sayılarla (ör. UniCredit: 10 gerçek junior ilan) uyuşmuyor gibi görünüyordu
      // çünkü konsol "18" yazıyordu (10 junior + 8 senior, filtrelenmemiş toplam). Artık
      // splitByTargetFit ile AYNI filtreyi burada da uyguluyoruz — konsoldaki sayı artık gerçekten
      // results.json'a giden, import edilebilir sayının ta kendisi.
      // (27.09) Ek alanlar (emp, certs, işveren tipi, başlık temizliği) AI'dan ÖNCE hesaplanıyor —
      // böylece AI sadece kuralların bulamadığını soruyor ve başlık temizliği eleme kararına da yansıyor.
      // 01.10: sayfa başlığından gelen şirket adı bazen bir slogan ("think:impact - Dabei sein, wenn … WU …") — config adını kullan.
      const fixCo = it => (company.name && (!it.companyName || String(it.companyName).length > 45 || /[.!?]\s|\s-\s.{25,}/.test(String(it.companyName)))) ? { ...it, companyName: company.name } : it;
      const itemsX = items.map(it => addExtraFields({ ...fixCo(it), _company: company.name || null, _city: cityFilter }, company));
      const { included: companyIncluded } = splitByTargetFit(itemsX);
      // AI soft-field katmanı SADECE hedef kitleye uygun (import edilecek) ilanlar için çalışıyor —
      // elenen senior/vasıfsız ilanlara boşuna AI harcamıyoruz. companyIncluded, items'la AYNI
      // obje referanslarını taşıyor (splitByTargetFit sadece filter yapıyor, kopyalamıyor), o yüzden
      // burada yapılan zenginleştirme aşağıdaki spread'e de yansıyor.
      await enrichFieldsForItems(companyIncluded, aiCache, aiBudget, aiExtractFields, learnedRules);
      all.push(...itemsX);
      perCompany[i] = { name: company.name || company.url, count: companyIncluded.length, rawCount: items.length, ok: true };
    }catch(e){
      console.log(`⚠️  ${company.name || company.url} işlenirken hata: ${e.message} — atlanıp bir sonraki şirkete geçiliyor.`);
      perCompany[i] = { name: company.name || company.url, count: 0, rawCount: 0, ok: false, error: e.message };
    }
  }

  for(let start = 0; start < config.length; start += CRAWL_CONCURRENCY){
    const chunk = config.slice(start, start + CRAWL_CONCURRENCY);
    await Promise.all(chunk.map((company, j) => processCompany(company, start + j)));
    const soFar = writeProgress();
    if(detailCache) detailCache.save(all);
    saveBudget(); saveQueue();
    saveAiCache(aiCache, aiCacheOut); // sonuç dosyasıyla aynı "yarıda kesilse bile kayıp olmasın" mantığı
    const doneCount = perCompany.filter(Boolean).length;
    console.log(`  💾 Ara kayıt yazıldı: ${outFile} (şimdiye kadar ${soFar} ilan, ${doneCount}/${config.length} şirket tamamlandı) — AI kotası (günlük): ${aiBudget.remaining}/${MAX_AI_CALLS_PER_RUN} kaldı`);
  }

  console.log(`\n${'='.repeat(60)}\n✅ TOPLU-CRAWL SONUCU (${config.length} şirket):\n`);
  perCompany.forEach(c => c && console.log(`  ${c.ok ? '✅' : '❌'} ${c.name}: ${c.count} ilan (${c.rawCount} link işlendi, ${c.rawCount-c.count} elendi: senior / genel başvuru / ilan olmayan sayfa)${c.error ? ` (hata: ${c.error})` : ''}`));
  saveBudget(); saveQueue();
  console.log(`\n🤖 AI katmanı: bu taramada ${batchMode ? 0 : (MAX_AI_THIS_RUN - usedToday) - aiBudget.remaining} çağrı yapıldı${batchMode ? ` (batch modu: ${aiBudget.queue.length} ilan kuyruğa yazıldı, gönderimi merge yapıyor)` : ''}; günlük kota: ${usedToday + (batchMode ? 0 : Math.max(0, (MAX_AI_THIS_RUN - usedToday) - aiBudget.remaining))}/${MAX_AI_THIS_RUN}. 🧠 Öğrenilmiş kurallarla AI'sız doldurulan alan: ${aiBudget.learnedHits || 0}.`);
  // Paralel parçalarda rapor merge-results.js'te (birleşmiş cache'ten) yazılıyor.
  if(!shard){ try{ fs.writeFileSync(path.join(outDir, 'ai-learning-report.md'), learning.learningReport(aiCache, dateStr)); }catch(e){} }

  const finalCount = writeProgress();
  if(detailCache){ const n = detailCache.save(all); console.log(`🗂️  Detay önbelleği: ${detailCache.stats.hit} sayfa önbellekten, ${detailCache.stats.fetched} sayfa internetten; ${n} ilan sayfası kaydedildi.`); }
  console.log(`\n📄 Sonuç dosyaya yazıldı: ${outFile} (${finalCount} ilan, Whittle Toplu İçe Aktar'a doğrudan yapıştırılabilir "items" alanı içinde)`);
  return { items: all, outFile };
}

// --batch <url-listesi.txt> [şehir]: dosyadaki her satırı sırayla işler (satır başına "url" ya
// da "url,şehir" formatı — şehir verilmezse genel cityFilter kullanılır), her şirketin sonucunu
// canlı canlı yazdırır (ilerleme takibi için), ve en sonda HEPSİNİ TEK bir JSON bloğunda
// birleştirip yazdırır — Whittle "Toplu İçe Aktar"a tek seferde yapıştırılabilsin diye. Bir
// şirket hata verirse (site kapalı, timeout, vb.) o satır atlanır, kalanlar devam eder.
async function runBatch(listFile, cityFilter){
  const lines = fs.readFileSync(listFile, 'utf8')
    .split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  if(!lines.length){ console.error(`"${listFile}" boş ya da hiç geçerli satır yok.`); process.exit(1); }

  console.log(`Toplu mod: ${lines.length} URL işlenecek (varsayılan şehir filtresi: "${cityFilter}")\n${'='.repeat(60)}`);
  const all = [];
  for(const [i, line] of lines.entries()){
    const [lineUrl, lineCity] = line.split(',').map(s => s && s.trim());
    console.log(`\n[${i+1}/${lines.length}] ${lineUrl}${lineCity ? ` (şehir: ${lineCity})` : ''}`);
    console.log('-'.repeat(60));
    try{
      const { items } = await processUrl(lineUrl, lineCity || cityFilter);
      all.push(...items);
    }catch(e){
      console.log(`⚠️  Bu şirket işlenirken hata: ${e.message} — atlanıp bir sonrakine geçiliyor.`);
    }
  }
  console.log(`\n${'='.repeat(60)}\n✅ TOPLU SONUÇ: ${lines.length} şirketten toplam ${all.length} ilan bulundu → tek blok halinde Whittle "Toplu İçe Aktar"a yapıştır (senior görünenler çıkarıldı):\n`);
  const { included, excluded } = splitByTargetFit(all);
  if(!process.env.CI) console.log(JSON.stringify(included, null, 2)); // 13.10: repo public – GitHub log'larına ilan metni basılmasın

  // Kıdem özeti — hedef kitle (WU'ya yeni başlayan öğrenciler) için "senior" görünen ilanlar
  // muhtemelen uygun değil, o yüzden zaten yukarıdaki bloktan çıkarıldı. Bu da TAHMİN
  // (başlığa/etiketli alana bakıyor), kesin değil.
  const junior = all.filter(it => it.seniorityGuess === 'junior');
  const unclear = all.length - junior.length - excluded.length;
  console.log(`\n📊 Kıdem tahmini (TAHMİN): ${junior.length} junior/staj görünümlü, ${excluded.length} senior/kıdemli görünümlü (paste bloğundan çıkarıldı), ${unclear} belirsiz (başlıktan anlaşılmıyor — Marketing Manager gibi hem junior hem senior olabilecek unvanlar dahil, bloğa dahil edildi, elle bakılmalı).`);
  printExcludedSenior(excluded);
}

async function main(){
  const args = process.argv.slice(2);
  if(args[0] === '--batch'){
    const listFile = args[1];
    const cityFilter = args[2] || 'Wien';
    if(!listFile){
      console.error('Kullanım: node jobposting-parser-v2.js --batch <url-listesi.txt> [şehir]');
      process.exit(1);
    }
    await runBatch(listFile, cityFilter);
    return;
  }

  if(args[0] === '--crawl-batch'){
    const configFile = args[1];
    if(!configFile){
      console.error('Kullanım: node jobposting-parser-v2.js --crawl-batch <şirketler.json> [--shard K/N]');
      process.exit(1);
    }
    let shard = null;
    const si = args.indexOf('--shard');
    if(si !== -1){
      const m = String(args[si + 1] || '').match(/^(\d+)\/(\d+)$/);
      if(!m || +m[1] < 1 || +m[1] > +m[2]){ console.error('--shard biçimi: K/N (ör. 2/4)'); process.exit(1); }
      shard = { index: +m[1], total: +m[2] };
    }
    await runCrawlBatch(configFile, shard);
    return;
  }

  if(args[0] === '--crawl'){
    const listingUrl = args[1];
    const cityFilter = args[2] || 'Wien';
    if(!listingUrl){
      console.error('Kullanım: node jobposting-parser-v2.js --crawl <liste-sayfası-url> [şehir]');
      process.exit(1);
    }
    await runCrawl(listingUrl, cityFilter);
    return;
  }

  const url = args[0];
  const cityFilter = args[1] || 'Wien';
  if(!url){
    console.error('Kullanım: node jobposting-parser-v2.js <career-sayfası-url> [şehir]');
    console.error('      ya: node jobposting-parser-v2.js --batch <url-listesi.txt> [şehir]');
    console.error('      ya: node jobposting-parser-v2.js --crawl <liste-sayfası-url> [şehir]');
    process.exit(1);
  }
  await processUrl(url, cityFilter);
}

if(require.main === module){
  main().catch(err => { console.error('Hata:', err.message); process.exit(1); });
}
module.exports = { cleanAdText, cleanLocation, SENIOR_TITLE_KEYWORDS, splitByTargetFit, isJunkTitle, guessSeniority, guessRequirements, enrichFieldsForItems, validateAiFields, detectAtsFromUrl, AI_FIELD_KEYS, empFromTitle, empFromText, certsFromText, employerTypeFor, addExtraFields };
