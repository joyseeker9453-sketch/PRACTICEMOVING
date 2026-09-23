/* ============================================================
   build.js — 部署時自動執行（build command: npm run build）
   1. 讀 content/ 的診所資料、公告、文章、分類
   2. 產生 data/*.json 與 data/content.js 給首頁讀取
   3. 為每篇文章產生真實網址 article/<slug>/index.html（SEO 用）
   4. 抽出 styles.css、產生 sitemap.xml
   零相依套件，只用 Node 內建模組。診所人員不需要理解此檔。
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = __dirname;
const ART_DIR = path.join(ROOT, 'content', 'articles');
const DATA_DIR = path.join(ROOT, 'data');
const ART_OUT = path.join(ROOT, 'article');
fs.mkdirSync(DATA_DIR, { recursive: true });

/* ---------- 診所基本資料（後台「診所資料」可編輯） ---------- */
const SITE_SRC = path.join(ROOT, 'content', 'site.json');
let SITE = {};
if (fs.existsSync(SITE_SRC)) {
  try { SITE = JSON.parse(fs.readFileSync(SITE_SRC, 'utf8')); }
  catch (e) { console.error('site.json 格式錯誤：', e.message); process.exit(1); }
} else {
  console.error('找不到 content/site.json，請先建立。'); process.exit(1);
}
/* 關於晨昕的標題背景圖：後台獨立一個項目（content/about.json），
   掛進 SITE.about 之後就會跟著 window.__SITE__ 一起送到前端。 */
const ABOUT_SRC = path.join(ROOT, 'content', 'about.json');
if (fs.existsSync(ABOUT_SRC)) {
  try { SITE.about = JSON.parse(fs.readFileSync(ABOUT_SRC, 'utf8')); }
  catch (e) { console.error('about.json 格式錯誤：', e.message); process.exit(1); }
}

const BASE = (SITE.baseUrl || '').replace(/\/+$/, '');
if (!/^https:\/\/[^/]+$/.test(BASE)) {
  console.warn('!!! 後台「診所資料 → 網站網址」是「' + BASE + '」，格式應為 https://網域（結尾不要斜線）。' +
    '分享連結、Google 搜尋用的網址都會錯。');
}

/* ---------- frontmatter 解析（支援 YAML 列表） ---------- */
function parseFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: raw };
  const meta = {};
  const lines = m[1].split(/\r?\n/);
  let curKey = null;
  const unquote = s => s.trim().replace(/^["']|["']$/g, '');

  for (const line of lines) {
    if (!line.trim()) continue;
    const li = line.match(/^\s*-\s+(.*)$/);
    if (li && curKey) {
      if (!Array.isArray(meta[curKey])) meta[curKey] = [];
      meta[curKey].push(unquote(li[1]));
      continue;
    }
    const i = line.indexOf(':');
    if (i === -1) continue;
    const key = line.slice(0, i).trim();
    let val = unquote(line.slice(i + 1));
    if (val === '') { curKey = key; meta[key] = ''; continue; }
    curKey = null;
    if (val === 'true') val = true;
    else if (val === 'false') val = false;
    meta[key] = val;
  }
  return { meta, body: m[2].trim() };
}

/* ---------- 工具 ---------- */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
/* 只允許安全的連結協定，擋掉 javascript: 之類 */
function safeUrl(u) {
  const s = String(u || '').trim();
  if (/^(https?:|mailto:|tel:|\/|#|\.)/i.test(s)) return s;
  return '#';
}
function plain(html, max) {
  const t = String(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}
/* ---------- 網址代稱：太長的中文檔名會產生 400+ 字元的網址 ----------
   優先順序：frontmatter 的 slug 欄位 > 自動截短檔名
   一旦產生就不要再改，否則舊連結會失效。                              */
const SLUG_MAX = 22;                       // 日期後面最多保留幾個字
function makeSlug(filename, metaSlug, used) {
  let base;
  if (metaSlug) {
    base = String(metaSlug).trim();
  } else {
    const m = filename.match(/^(\d{4}-\d{2}-\d{2})-([\s\S]*)$/);
    const datePart = m ? m[1] : '';
    let rest = (m ? m[2] : filename)
      .replace(/[，。、？！；：「」『』（）《》〈〉—…·,.?!;:'"()\[\]{}]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    if (rest.length > SLUG_MAX) rest = rest.slice(0, SLUG_MAX).replace(/-$/, '');
    base = datePart ? (rest ? datePart + '-' + rest : datePart) : rest;
  }
  let slug = base, n = 2;
  while (used.has(slug)) { slug = base + '-' + (n++); }
  used.add(slug);
  return slug;
}

function absUrl(u) {
  if (!u) return '';
  if (/^https?:/i.test(u)) return u;
  return BASE + (u.startsWith('/') ? u : '/' + u);
}

/* ---------- Markdown → HTML（marked + sanitize-html） ----------
   COMMIT 2：原本 inline()/mdToHtml() 是兩條各自維護的極簡 regex parser，
   首頁公告條（inline，只做行內格式）跟公告頁／文章（mdToHtml，含標題等區塊語法）
   長期不同步，導致首頁公告條打 # / ##### 只會原字吐出來。
   現在統一改成 marked 解析 + sanitize-html 過濾，公告頁、首頁公告條、文章共用同一顆引擎，
   輸出的 HTML 結構（<p> <h2>~<h6> <ul> <ol> <blockquote> <hr> <code> <a> <img>）
   刻意對齊舊版，讓現有 CSS（.article-body / .notice-body / .ha-body）不用大改。 */
marked.use({ gfm: true, breaks: true });

const MD_ALLOWED_TAGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'strong', 'em', 'del', 'code', 'ul', 'ol', 'li', 'blockquote', 'hr', 'a', 'img', 'br'];
const MD_ALLOWED_SCHEMES = ['http', 'https', 'mailto', 'tel'];

/* 後台編輯器／從 FB 複製貼上時會出現、但舊 parser 有特別處理的幾種樣式，
   在丟給 marked 之前先用文字層級處理掉，避免要碰 marked renderer 的內部 API：
   1) 標題整體降一級，避開頁面本身的 h1；原本 5、6 級都收斂到 6 級（HTML 最小標題），
      所以先把 6 個井號併成 5 個，再統一往下加 1 個井號。
   2) FB 表情符號圖示（1️⃣ 2️⃣ 🩺…）直接還原成表情文字本身，不依賴 FB 圖床。
   3) FB 貼文複製進來的 hashtag 連結只是來源平台殘留，拿掉外連但保留文字（含粗體等格式）。 */
function preprocessMarkdown(md) {
  let s = String(md == null ? '' : md);
  s = s.replace(/!\[([^\]]*)\]\((https?:\/\/[^)\s]*fbcdn\.net\/images\/emoji\.php[^)\s]*)\)/g, (_, alt) => alt);
  s = s.replace(/\[([^\]]+)\]\(\s*(https?:\/\/(?:www\.)?facebook\.com\/hashtag\/[^)\s]*)\s*\)/gi, (_, label) => label);
  s = s.split(/\r?\n/).map(line => {
    const m = line.match(/^( {0,3})(#{1,6})(\s+.*)$/);
    if (!m) return line;
    const level = Math.min(m[2].length, 5) + 1;
    return m[1] + '#'.repeat(level) + m[3];
  }).join('\n');
  return s;
}

function renderMarkdown(md) {
  let html = marked.parse(preprocessMarkdown(md));
  /* 圖片補上 loading="lazy"、連結補上 target="_blank" rel="noopener"，沿用舊版行為 */
  html = html.replace(/<img\b(?![^>]*\bloading=)/g, '<img loading="lazy"');
  html = html.replace(/<a\b(?![^>]*\btarget=)([^>]*)>/g, '<a$1 target="_blank" rel="noopener">');
  return sanitizeHtml(html, {
    allowedTags: MD_ALLOWED_TAGS,
    allowedAttributes: { a: ['href', 'target', 'rel'], img: ['src', 'alt', 'loading'] },
    allowedSchemes: MD_ALLOWED_SCHEMES,
    allowedSchemesByTag: { img: ['http', 'https'] },
    allowProtocolRelative: true
  });
}


/* ---------- 文章 ---------- */
const articles = [];
const usedSlugs = new Set();
if (fs.existsSync(ART_DIR)) {
  for (const f of fs.readdirSync(ART_DIR).sort()) {
    if (!f.endsWith('.md')) continue;
    const raw = fs.readFileSync(path.join(ART_DIR, f), 'utf8');
    const { meta, body } = parseFrontmatter(raw);
    const dateStr = String(meta.date || '').slice(0, 10);
    let tags = [];
    const cat = meta.category;
    if (Array.isArray(cat)) tags = cat;
    else if (typeof cat === 'string') {
      const s = cat.trim().replace(/^\[|\]$/g, '');
      tags = s.split(/[,、]/).map(t => t.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    }
    if (!tags.length) tags = ['未分類'];
    const html = renderMarkdown(body);
    const rawName = f.replace(/\.md$/, '');
    articles.push({
      slug: makeSlug(rawName, meta.slug, usedSlugs),
      rawName: rawName,
      title: meta.title || f,
      date: dateStr,
      tags: tags,
      author: meta.author || SITE.name || '',
      excerpt: meta.excerpt || plain(html, 110),
      thumbnail: meta.thumbnail || '',
      html: html
    });
  }
}
articles.sort((a, b) => b.date.localeCompare(a.date));
const articlesOut = articles.map(a => { const o = Object.assign({}, a); delete o.rawName; return o; });
fs.writeFileSync(path.join(DATA_DIR, 'articles.json'), JSON.stringify(articlesOut, null, 2));

/* ---------- 公告 ---------- */
const annSrc = path.join(ROOT, 'content', 'announcements.json');
let ann = { items: [] };
if (fs.existsSync(annSrc)) {
  try { ann = JSON.parse(fs.readFileSync(annSrc, 'utf8')); }
  catch (e) { console.error('announcements.json 格式錯誤：', e.message); process.exit(1); }
}
ann.items = (ann.items || []).sort((a, b) => String(b.date).localeCompare(String(a.date)));

/* ---- 首頁「精簡版」小提示條專用處理 ----
   首頁預設顯示的是 NOTICES 區塊（#notices-announcement，跟 /notices/ 同一份完整內容，
   只差在太高時用 scroll/clip/full 框住），不是這裡處理的對象。
   這裡的 keepFirstImage() 只給真正的精簡小提示條用（#home-announcement，
   要在網址加 ?announcement=inline 才會顯示），平常不會被套用到。 */

/* 精簡小提示條只留第一張圖：老闆從 FB 貼一整串圖時，這條不會變成圖片牆。
   第二張以後整個拿掉；圖片原本自己佔一個 <p> 的話，空掉的 <p> 也一併清掉。
   要看完整內容的人可以點下面那顆「看其他公告」到 /notices/。 */
function keepFirstImage(html) {
  let seen = false;
  return String(html)
    .replace(/<img\b[^>]*>/g, m => (seen ? '' : (seen = true, m)))
    .replace(/<p>\s*<\/p>\s*/g, '');
}

/* 公告太高時的處理方式，後台可選。這是套在整段渲染後 HTML 上的通用高度限制，
   不管太高的原因是文字多還是圖片多都適用，不是只有貼圖片才會觸發：
   scroll = 內框滾動（預設，高度可控、內容不會消失，捲軸本身會提示「下面還有」）
   clip   = 裁切不滾動（底部加漸層淡出提示還有內容）
   full   = 完整顯示（不限高度，內容太長會把首頁撐長）
   每則公告可以單獨指定；沒指定（或填 inherit）就跟隨「診所資料」裡的全域預設。 */
const HEIGHT_MODES = ['scroll', 'clip', 'full'];
const ANN_MODE_DEFAULT = HEIGHT_MODES.includes(SITE.announcementHeightMode) ? SITE.announcementHeightMode : 'scroll';
function resolveMode(v) {
  return HEIGHT_MODES.includes(v) ? v : ANN_MODE_DEFAULT;
}

/* 首頁公告條以前只做「行內」格式（不解析標題等區塊語法），所以打 # / ##### 會原字吐出來，
   跟 /notices/ 公告頁（含標題、清單等完整區塊語法）長期不同步。
   COMMIT 2 起兩邊共用 renderMarkdown()，在建置時解析好存成 bodyHtml，前端直接用。
   bodyHtml 是完整版（跟 /notices/ 一模一樣），給預設顯示的 NOTICES 區塊用；
   bodyHtmlCompact 才是裁過圖的精簡版，只給 ?announcement=inline 那條小提示條用。 */
ann.items = ann.items.map(it => {
  const full = renderMarkdown(String(it && it.body || ''));
  return Object.assign({}, it, {
    bodyHtml: full,
    bodyHtmlCompact: keepFirstImage(full),
    heightMode: resolveMode(it && it.heightMode)
  });
});
fs.writeFileSync(path.join(DATA_DIR, 'announcements.json'), JSON.stringify(ann, null, 2));

/* ---- content.js：首頁一次讀到所有內容（本機雙擊預覽也能動） ---- */
const BUILD = {
  time: new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false }),
  commit: (process.env.WORKERS_CI_COMMIT_SHA || process.env.CF_PAGES_COMMIT_SHA || 'local').slice(0, 7)
};
const contentJs =
  '/* 建置時間 ' + BUILD.time + '（commit ' + BUILD.commit + '）— 後台存檔約 1 分鐘後這行會更新 */\n' +
  'window.__BUILD__ = ' + JSON.stringify(BUILD) + ';\n' +
  'window.__SITE__ = ' + JSON.stringify(SITE) + ';\n' +
  'window.__ANNOUNCEMENTS__ = ' + JSON.stringify(ann) + ';\n' +
  'window.__ARTICLES__ = ' + JSON.stringify(articlesOut) + ';\n';
fs.writeFileSync(path.join(DATA_DIR, 'content.js'), contentJs);

/* ============================================================
   SEO：抽出 styles.css、產生文章實體頁、sitemap.xml
   ============================================================ */
const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const styleMatch = indexHtml.match(/<style>([\s\S]*?)<\/style>/);
if (!styleMatch) { console.error('index.html 找不到 <style> 區塊'); process.exit(1); }
fs.writeFileSync(path.join(ROOT, 'styles.css'), styleMatch[1].trim() + '\n');

/* ============================================================
   首頁 <head>：注入 og:image / og:url / canonical / 診所 JSON-LD
   ------------------------------------------------------------
   只重寫 index.html 裡 <!--OG:START--> 與 <!--OG:END--> 之間的內容，
   可重複執行不會累積。<title> 與 description 是人工調過的，保留不動，
   只把它們的文字拿來當 og:title / og:description。
   ============================================================ */
const OG_START = '<!--OG:START-->';
const OG_END = '<!--OG:END-->';
(function injectHomeHead() {
  const s = indexHtml.indexOf(OG_START);
  const e = indexHtml.indexOf(OG_END);
  if (s === -1 || e === -1 || e < s) {
    console.warn('! index.html 找不到 OG 標記區塊，略過首頁 OG 注入');
    return;
  }
  if (!BASE) console.warn('! 後台「網站網址」是空的，首頁 og:url / canonical 會不完整');

  const titleM = indexHtml.match(/<title>([\s\S]*?)<\/title>/);
  const descM = indexHtml.match(/<meta\s+name="description"\s+content="([^"]*)"/i);
  const title = titleM ? titleM[1].trim() : SITE.name;
  const desc = descM ? descM[1].trim() : '';
  const homeUrl = BASE + '/';
  const ogImg = absUrl(SITE.ogImage || '/images/logo.png');

  /* 地址粗切成 縣市 / 行政區 / 其餘，讓 Google 比較好解析 */
  const addr = String(SITE.address || '');
  const am = addr.match(/^(.+?[市縣])(.+?區)?(.*)$/);

  /* 門診時間 → openingHoursSpecification（Google 商家資訊會用到） */
  const DAY = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const DAY_EN = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const openSpec = [];
  const _rows = (SITE.hours && Array.isArray(SITE.hours.rows)) ? SITE.hours.rows : [];
  _rows.forEach(row => {
    const t = String(row.time || '').split(/[–—\-~]/);
    if (t.length < 2) return;
    const opens = t[0].trim(), closes = t[1].trim();
    if (!/^\d{1,2}:\d{2}$/.test(opens) || !/^\d{1,2}:\d{2}$/.test(closes)) return;
    const days = [];
    DAY.forEach((k, i) => {
      const v = String(row[k] == null ? '' : row[k]).trim();
      if (v && v !== '休診') days.push(DAY_EN[i]);
    });
    if (days.length) openSpec.push({
      '@type': 'OpeningHoursSpecification',
      dayOfWeek: days, opens: opens, closes: closes
    });
  });

  const clinicLd = {
    '@context': 'https://schema.org',
    '@type': 'MedicalClinic',
    name: SITE.name,
    url: homeUrl || undefined,
    description: desc || undefined,
    telephone: SITE.phone || undefined,
    email: SITE.email || undefined,
    image: ogImg || undefined,
    logo: absUrl('/images/logo.png') || undefined,
    address: addr ? {
      '@type': 'PostalAddress',
      addressCountry: 'TW',
      addressRegion: am ? am[1] : undefined,
      addressLocality: (am && am[2]) ? am[2] : undefined,
      streetAddress: am ? (am[3] || addr) : addr
    } : undefined,
    sameAs: [SITE.facebook, SITE.line].filter(Boolean),
    medicalSpecialty: (Array.isArray(SITE.services) ? SITE.services : []).map(x => x && x.name).filter(Boolean),
    openingHoursSpecification: openSpec.length ? openSpec : undefined
  };
  if (!clinicLd.sameAs.length) delete clinicLd.sameAs;
  if (!clinicLd.medicalSpecialty.length) delete clinicLd.medicalSpecialty;

  const block = [
    OG_START,
    '<!-- 以下由 build.js 自動產生，資料來自後台「診所資料」。手動修改會在下次部署被覆蓋。 -->',
    '<link rel="canonical" href="' + esc(homeUrl) + '">',
    '<meta property="og:type" content="website">',
    '<meta property="og:site_name" content="' + esc(SITE.name) + '">',
    '<meta property="og:title" content="' + esc(title) + '">',
    '<meta property="og:description" content="' + esc(desc) + '">',
    '<meta property="og:url" content="' + esc(homeUrl) + '">',
    '<meta property="og:image" content="' + esc(ogImg) + '">',
    '<meta name="twitter:card" content="summary_large_image">',
    '<script type="application/ld+json">' + JSON.stringify(clinicLd) + '</script>',
    OG_END
  ].join('\n');

  fs.writeFileSync(path.join(ROOT, 'index.html'),
    indexHtml.slice(0, s) + block + indexHtml.slice(e + OG_END.length));
  console.log('✓ 首頁 OG 已注入（og:image = ' + ogImg + '，門診時段 ' + openSpec.length + ' 組）');
})();

function headerHtml() {
  return '<div class="topbar">\n' +
    '  <div class="wrap-wide">\n' +
    '    <span>📞 <a href="tel:' + esc(SITE.phoneLink) + '">' + esc(SITE.phone) + '</a><span class="tb-addr">　<a href="/#contact" title="' + esc(SITE.address) + '">聯絡我們</a></span></span>\n' +
    '    <span><a href="' + esc(safeUrl(SITE.facebook)) + '" target="_blank" rel="noopener">Facebook 粉絲專頁</a>　|　<a class="tb-booking" href="' + esc(safeUrl(SITE.booking)) + '" target="_blank" rel="noopener">線上預約</a></span>\n' +
    '  </div>\n</div>\n' +
    '<header>\n  <div class="wrap-wide nav">\n' +
    '    <a class="brand" href="/#home"><img class="logo" src="/images/logo.png" alt="' + esc(SITE.name) + ' Logo">' + esc(SITE.name) + '</a>\n' +
    /* 手機版選單按鈕：之前文章頁/公告頁沒有這顆，手機上選單會整個消失 */
    '    <button class="burger" onclick="this.nextElementSibling.classList.toggle(\'open\')" aria-label="選單">☰</button>\n' +
    '    <ul class="menu">\n' +
    '      <li><a href="/#home">首頁</a></li>\n' +
    '      <li><a href="/notices/">診所公告</a></li>\n' +
    '      <li><a href="/#services">服務項目</a></li>\n' +
    '      <li><a href="/#hours">門診時間</a></li>\n' +
    '      <li><a href="/team/">醫療團隊</a></li>\n' +
    '      <li><a href="/#news">健康新知</a></li>\n' +
    '    </ul>\n  </div>\n</header>';
}
function footerHtml() {
  return '<footer>\n  <div class="wrap">\n' +
    '    <div class="brand"><img class="logo" src="/images/logo.png" alt="">' + esc(SITE.name) + '</div>\n' +
    '    <p>' + esc(SITE.address) + '</p>\n' +
    '    <p style="margin-top:0.5rem"><a href="' + esc(safeUrl(SITE.facebook)) + '" target="_blank" rel="noopener">Facebook</a>　|　<a href="' + esc(safeUrl(SITE.line)) + '" target="_blank" rel="noopener">LINE</a>　|　<a href="' + esc(safeUrl(SITE.booking)) + '" target="_blank" rel="noopener">線上預約</a></p>\n' +
    '    <p style="margin-top:0.875rem;font-size:0.7812rem;color:#8fa79c">© ' + esc(SITE.name) + ' All Rights Reserved.</p>\n' +
    '  </div>\n</footer>';
}
/* 分享按鈕的圖示（跟首頁內的文章頁同一組；之前獨立文章頁沒有圖示） */
const SHARE_ICONS = {
  threads: '<svg viewBox="0 0 24 24"><path d="M12.2 24h-.01c-3.58-.02-6.33-1.2-8.19-3.51C2.35 18.44 1.5 15.59 1.47 12v-.01c.03-3.58.88-6.43 2.53-8.48C5.86 1.2 8.61.02 12.19 0h.02c2.74.02 5.04.72 6.82 2.1 1.68 1.3 2.86 3.14 3.51 5.49l-2.04.57c-1.1-3.98-3.9-6.01-8.3-6.04-2.91.02-5.11.93-6.53 2.7C4.33 6.48 3.65 8.87 3.62 12c.03 3.13.71 5.52 2.05 7.18 1.42 1.77 3.62 2.68 6.53 2.7 2.62-.02 4.36-.64 5.8-2.08 1.65-1.64 1.62-3.66 1.09-4.89-.31-.72-.88-1.32-1.63-1.78-.19 1.4-.62 2.53-1.29 3.38-.89 1.14-2.16 1.76-3.77 1.85-1.22.07-2.4-.22-3.31-.82-1.08-.7-1.71-1.78-1.78-3.02-.13-2.45 1.83-4.21 4.87-4.39.9-.05 1.75-.01 2.53.12-.1-.62-.31-1.12-.62-1.48-.43-.49-1.09-.74-1.97-.75h-.03c-.71 0-1.67.2-2.28 1.11l-1.71-1.15c.95-1.42 2.5-2.2 4.02-2.2h.05c2.87.02 4.58 1.78 4.75 4.85l.01.17c.51.22.99.49 1.4.81 1.05.81 1.79 1.87 2.15 3.06.5 1.68.55 4.41-1.61 6.57-1.86 1.85-4.12 2.68-7.32 2.71zm.9-10.83c-.2 0-.4 0-.61.02-1.55.09-2.94.79-2.87 2.19.04.73.42 1.31 1.07 1.73.55.36 1.28.54 2.03.5 1.04-.06 1.81-.42 2.36-1.12.44-.56.74-1.35.89-2.36-.86-.19-1.83-.29-2.87-.29z"/></svg>',
  fb: '<svg viewBox="0 0 24 24"><path d="M24 12.07C24 5.4 18.63 0 12 0S0 5.4 0 12.07C0 18.1 4.39 23.1 10.13 24v-8.44H7.08v-3.49h3.05V9.41c0-3.02 1.79-4.7 4.53-4.7 1.31 0 2.68.24 2.68.24v2.97h-1.51c-1.49 0-1.96.93-1.96 1.89v2.26h3.33l-.53 3.49h-2.8V24C19.61 23.1 24 18.1 24 12.07z"/></svg>',
  line: '<svg viewBox="0 0 24 24"><path d="M19.37 4.43C17.4 2.6 14.8 1.6 12 1.6 6.16 1.6 1.4 5.53 1.4 10.36c0 4.33 3.77 7.96 8.86 8.65.34.07.81.23.93.52.11.27.07.68.04.95l-.15.9c-.05.27-.21 1.06.93.58 1.14-.48 6.16-3.63 8.4-6.21 1.55-1.7 2.19-3.43 2.19-5.39 0-2.24-1.09-4.3-3.23-5.93zM7.65 13.16H5.5c-.31 0-.57-.25-.57-.56V8.32c0-.31.26-.57.57-.57.32 0 .57.26.57.57v3.71h1.58c.32 0 .57.26.57.57 0 .31-.25.56-.57.56zm2.19-.56c0 .31-.25.56-.57.56-.31 0-.57-.25-.57-.56V8.32c0-.31.26-.57.57-.57.32 0 .57.26.57.57v4.28zm5.14 0c0 .24-.16.46-.39.53-.06.02-.12.03-.18.03-.18 0-.34-.08-.45-.22l-2.19-2.97v2.63c0 .31-.25.56-.57.56-.31 0-.57-.25-.57-.56V8.32c0-.24.16-.46.39-.53.06-.02.12-.03.18-.03.18 0 .34.08.45.22l2.19 2.98V8.32c0-.31.26-.57.57-.57.32 0 .57.26.57.57v4.28zm3.46-2.71c.31 0 .57.25.57.57 0 .31-.26.56-.57.56h-1.59v1.02h1.59c.31 0 .57.26.57.57 0 .31-.26.56-.57.56h-2.16c-.31 0-.57-.25-.57-.56V8.32c0-.31.26-.57.57-.57h2.16c.31 0 .57.26.57.57 0 .32-.26.57-.57.57h-1.59v1z"/></svg>',
  copy: '<svg viewBox="0 0 24 24"><path d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z"/></svg>'
};
function shareHtml(url, title) {
  const u = encodeURIComponent(url), t = encodeURIComponent(title);
  return '<div class="share">\n  <div class="lbl">分享這篇文章</div>\n  <div class="share-btns">\n' +
    '    <a class="sbtn threads" target="_blank" rel="noopener" href="https://www.threads.net/intent/post?text=' + t + '%0A' + u + '">' + SHARE_ICONS.threads + 'Threads</a>\n' +
    '    <a class="sbtn fb" target="_blank" rel="noopener" href="https://www.facebook.com/sharer/sharer.php?u=' + u + '">' + SHARE_ICONS.fb + 'Facebook</a>\n' +
    '    <a class="sbtn line" target="_blank" rel="noopener" href="https://social-plugins.line.me/lineit/share?url=' + u + '&amp;text=' + t + '">' + SHARE_ICONS.line + 'LINE</a>\n' +
    /* 按下後只改文字那一段，圖示保留 */
    '    <button class="sbtn copy" onclick="navigator.clipboard.writeText(location.href);this.lastElementChild.textContent=\'已複製\'">' + SHARE_ICONS.copy + '<span>複製連結</span></button>\n' +
    '  </div>\n</div>';
}

fs.rmSync(ART_OUT, { recursive: true, force: true });
fs.mkdirSync(ART_OUT, { recursive: true });

for (const a of articles) {
  const url = BASE + '/article/' + encodeURIComponent(a.slug) + '/';
  const desc = plain(a.excerpt || a.html, 150);
  const img = absUrl(a.thumbnail || SITE.ogImage || '/images/logo.png');

  const jsonld = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: a.title,
    description: desc,
    datePublished: a.date,
    author: { '@type': 'Person', name: a.author },
    publisher: {
      '@type': 'MedicalClinic',
      name: SITE.name,
      logo: { '@type': 'ImageObject', url: absUrl('/images/logo.png') }
    },
    mainEntityOfPage: url,
    keywords: a.tags.join('、')
  };
  if (a.thumbnail) jsonld.image = absUrl(a.thumbnail);

  const page = '<!DOCTYPE html>\n<html lang="zh-Hant">\n<head>\n' +
    '<meta charset="UTF-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
    '<title>' + esc(a.title) + '｜' + esc(SITE.name) + '</title>\n' +
    '<meta name="description" content="' + esc(desc) + '">\n' +
    '<link rel="canonical" href="' + esc(url) + '">\n' +
    '<meta property="og:type" content="article">\n' +
    '<meta property="og:site_name" content="' + esc(SITE.name) + '">\n' +
    '<meta property="og:title" content="' + esc(a.title) + '">\n' +
    '<meta property="og:description" content="' + esc(desc) + '">\n' +
    '<meta property="og:url" content="' + esc(url) + '">\n' +
    '<meta property="og:image" content="' + esc(img) + '">\n' +
    '<meta name="twitter:card" content="summary_large_image">\n' +
    '<link rel="icon" type="image/png" href="/images/logo.png">\n' +
    '<link rel="preconnect" href="https://fonts.googleapis.com">\n' +
    '<link href="https://fonts.googleapis.com/css2?family=Noto+Serif+TC:wght@500;700;900&family=Noto+Sans+TC:wght@400;500;700&display=swap" rel="stylesheet">\n' +
    '<link rel="stylesheet" href="/styles.css">\n' +
    '<script type="application/ld+json">' + JSON.stringify(jsonld) + '</script>\n' +
    '</head>\n<body>\n' +
    headerHtml() + '\n' +
    '<div class="page show">\n  <section>\n    <div class="wrap article-page">\n' +
    '      <div class="cats">' + a.tags.map(t => '<span class="cat">' + esc(t) + '</span>').join('') + '</div>\n' +
    '      <h1>' + esc(a.title) + '</h1>\n' +
    '      <div class="meta">' + esc(a.author) + '　·建立日期：' + esc(a.date) + '</div>\n' +
    /* 封面圖：之前只在列表卡片出現，文章內頁沒有；內文已有同一張圖就不重複 */
    ((a.thumbnail && !a.html.includes(a.thumbnail))
      ? '      <figure class="article-cover"><img src="' + esc(safeUrl(a.thumbnail)) + '" alt="' + esc(a.title) + '"></figure>\n' : '') +
    '      <div class="article-body">' + a.html + '</div>\n' +
    '      ' + shareHtml(url, a.title) + '\n' +
    '      <a class="back-link" href="/#news">← 回文章列表</a>\n' +
    '    </div>\n  </section>\n</div>\n' +
    footerHtml() + '\n</body>\n</html>\n';

  const dir = path.join(ART_OUT, a.slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), page);

  /* 舊的完整檔名網址 → 轉址到新網址，避免已分享出去的連結失效 */
  if (a.rawName && a.rawName !== a.slug) {
    const oldDir = path.join(ART_OUT, a.rawName);
    fs.mkdirSync(oldDir, { recursive: true });
    fs.writeFileSync(path.join(oldDir, 'index.html'),
      '<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="UTF-8">' +
      '<meta name="robots" content="noindex">' +
      '<link rel="canonical" href="' + esc(url) + '">' +
      '<meta http-equiv="refresh" content="0; url=' + esc(url) + '">' +
      '<title>前往文章…</title></head><body>' +
      '<p>已搬移，正在前往 <a href="' + esc(url) + '">新網址</a>…</p></body></html>\n');
  }
}

/* ============================================================
   公告實體頁 /notices/
   患者最常搜「診所名 + 休診」，這頁要能被 Google 單獨收錄，
   所以做成真實 HTML，不靠 JavaScript。
   ============================================================ */
const NOTICE_OUT = path.join(ROOT, 'notices');
const noticeList = (ann.items || []).filter(i => i && i.show !== false);
(function buildNoticesPage() {
  const url = BASE + '/notices/';
  const desc = noticeList.length
    ? plain(noticeList[0].title + '。' + (noticeList[0].body || ''), 150)
    : (SITE.name + '的最新公告與休診資訊。');
  const img = absUrl(SITE.ogImage || '/images/logo.png');

  const cards = noticeList.map(i =>
    '      <div class="notice">\n' +
    '        <span class="tag">公告</span>\n' +
    '        <div>\n' +
    '          <h3>' + esc(i.title) + '</h3>\n' +
    '          <div class="notice-body">' + renderMarkdown(String(i.body || '')) + '</div>\n' +
    '          <small>公告日期：' + esc(i.date) + '</small>\n' +
    '        </div>\n' +
    '      </div>'
  ).join('\n') || '      <p class="loading">目前沒有公告。</p>';

  const jsonld = {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: '診所公告｜' + SITE.name,
    description: desc,
    url: url,
    isPartOf: { '@type': 'MedicalClinic', name: SITE.name, url: BASE + '/' }
  };

  const page = '<!DOCTYPE html>\n<html lang="zh-Hant">\n<head>\n' +
    '<meta charset="UTF-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
    '<title>診所公告｜' + esc(SITE.name) + '</title>\n' +
    '<meta name="description" content="' + esc(desc) + '">\n' +
    '<link rel="canonical" href="' + esc(url) + '">\n' +
    '<meta property="og:type" content="website">\n' +
    '<meta property="og:site_name" content="' + esc(SITE.name) + '">\n' +
    '<meta property="og:title" content="診所公告｜' + esc(SITE.name) + '">\n' +
    '<meta property="og:description" content="' + esc(desc) + '">\n' +
    '<meta property="og:url" content="' + esc(url) + '">\n' +
    '<meta property="og:image" content="' + esc(img) + '">\n' +
    '<meta name="twitter:card" content="summary_large_image">\n' +
    '<link rel="icon" type="image/png" href="/images/logo.png">\n' +
    '<link rel="preconnect" href="https://fonts.googleapis.com">\n' +
    '<link href="https://fonts.googleapis.com/css2?family=Noto+Serif+TC:wght@500;700;900&family=Noto+Sans+TC:wght@400;500;700&display=swap" rel="stylesheet">\n' +
    '<link rel="stylesheet" href="/styles.css">\n' +
    '<script type="application/ld+json">' + JSON.stringify(jsonld) + '</script>\n' +
    '</head>\n<body>\n' +
    headerHtml() + '\n' +
    '<div class="page show">\n  <section>\n    <div class="wrap">\n' +
    '      <div class="sec-head"><span class="en">NOTICES</span><h2>診所公告</h2></div>\n' +
    '      <div class="notice-list">\n' + cards + '\n      </div>\n' +
    '      <p style="text-align:center"><a class="back-link" href="/#home">← 回首頁</a></p>\n' +
    '    </div>\n  </section>\n</div>\n' +
    footerHtml() + '\n<script>document.querySelectorAll(".menu a").forEach(a=>{if(a.getAttribute("href")==="/notices/")a.classList.add("active")})</script>\n</body>\n</html>\n';

  fs.rmSync(NOTICE_OUT, { recursive: true, force: true });
  fs.mkdirSync(NOTICE_OUT, { recursive: true });
  fs.writeFileSync(path.join(NOTICE_OUT, 'index.html'), page);
})();

/* 置頂公告檢查：首頁最多輪播 3 則，超過的部分不會出現（取日期最新的 3 則） */
const pinned = noticeList.filter(i => i.pinned);
if (pinned.length > 3) {
  console.warn('! 置頂了 ' + pinned.length + ' 則，但首頁最多輪播 3 則，只會顯示日期最新的：' +
    pinned.slice(0, 3).map(p => '「' + p.title + '」').join('、'));
} else if (pinned.length > 1) {
  console.log('✓ 首頁公告輪播 ' + pinned.length + ' 則：' +
    pinned.map(p => '「' + p.title + '」').join('、'));
} else if (!pinned.length) {
  console.warn('! 目前沒有任何置頂公告，首頁不會顯示公告條（到後台把某則的「置頂公告」打開即可）');
}

/* ---------- robots.txt：跟著後台「網站網址」產生，換網域不用改檔案 ---------- */
fs.writeFileSync(path.join(ROOT, 'robots.txt'),
  'User-agent: *\nDisallow: /admin/\nDisallow: /content/\n\nSitemap: ' + BASE + '/sitemap.xml\n');

/* Full medical team: array order is the single source of display rank. */
(function buildTeamPage(){
  const doctors=Array.isArray(SITE.team)?SITE.team:[];
  const cards=doctors.map(d=>'<article class="doc">'+
    (d.photo?'<img class="photo" loading="lazy" src="'+esc(safeUrl(absUrl(d.photo)))+'" alt="'+esc(d.name)+'">':'<div class="photo-ph" role="img" aria-label="尚無醫師照片"><span>醫師照片</span></div>')+
    '<div class="doc-body"><h3>'+esc(d.name)+'</h3><div class="role">'+esc(d.title)+'</div><ul>'+
    (d.creds||[]).filter(Boolean).map(c=>'<li>'+esc(c)+'</li>').join('')+'</ul></div></article>').join('');
  const page='<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'+
    '<title>醫療團隊｜'+esc(SITE.name)+'</title><meta name="description" content="認識'+esc(SITE.name)+'的完整醫療團隊與醫師學經歷。">'+
    '<link rel="canonical" href="'+esc(BASE+'/team/')+'"><link rel="stylesheet" href="/styles.css">'+
    '<link href="https://fonts.googleapis.com/css2?family=Noto+Serif+TC:wght@500;700;900&family=Noto+Sans+TC:wght@400;500;700&display=swap" rel="stylesheet">'+
    '<style>.team-page .team-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1.5rem}.team-page .doc{display:grid;grid-template-columns:minmax(10rem,50%) 1fr;min-width:0;gap:0;padding:0;overflow:hidden;align-items:stretch}.team-page .doc img.photo,.team-page .doc .photo-ph{width:100%;height:100%;min-height:0;aspect-ratio:auto;align-self:stretch;margin:0;object-fit:cover;object-position:50% 0;border-radius:0;background:var(--mist)}.team-page .doc-body{padding:1.25rem .35rem 1.5rem .55rem;width:auto}.team-page .doc h3{font-size:1.55rem;margin:0 0 .4rem}.team-page .doc ul{font-size:.95rem}.team-page .doc li{padding:.18rem 0;line-height:1.35}@media(min-width:861px) and (max-height:700px){.team-page .doc{grid-template-columns:minmax(10rem,44%) 1fr}}@media(max-width:560px){.team-page .team-grid{grid-template-columns:1fr}.team-page .doc{grid-template-columns:30% 70%}.team-page .doc-body{padding:1.25rem}}</style></head><body>'+headerHtml()+
    '<main class="page show team-page"><section><div class="wrap"><div class="sec-head"><span class="en">TEAM</span><h1>醫療團隊</h1></div><div class="team-grid">'+(cards||'<p>醫療團隊資訊更新中。</p>')+'</div><p style="text-align:center"><a class="back-link" href="/#team">← 回首頁醫療團隊</a></p></div></section></main>'+footerHtml()+'<script>document.querySelectorAll(".menu a").forEach(a=>{if(a.getAttribute("href")==="/team/")a.classList.add("active")})</script></body></html>';
  const dir=path.join(ROOT,'team');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'index.html'),page);
})();

/* ---------- sitemap.xml ---------- */
const today = new Date().toISOString().slice(0, 10);
const urls = [{ loc: BASE + '/', pri: '1.0', mod: today },
  { loc: BASE + '/team/', pri: '0.8', mod: today },
  { loc: BASE + '/notices/', pri: '0.7', mod: (noticeList[0] && noticeList[0].date) || today }].concat(
  articles.map(a => ({ loc: BASE + '/article/' + encodeURIComponent(a.slug) + '/', pri: '0.8', mod: a.date || today }))
);
fs.writeFileSync(path.join(ROOT, 'sitemap.xml'),
  '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
  urls.map(u => '  <url><loc>' + u.loc + '</loc><lastmod>' + u.mod + '</lastmod><priority>' + u.pri + '</priority></url>').join('\n') +
  '\n</urlset>\n');

console.log('✓ 建置完成：' + articles.length + ' 篇文章（已產生實體頁）、' +
  noticeList.length + ' 則公開公告（置頂 ' + pinned.length + ' 則）、sitemap ' + urls.length + ' 筆');
