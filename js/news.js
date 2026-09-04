// ═══════════════════════════════════════════════════════════════════════════════
// news.js — Natural Gas news ticker
//
// Feeds are pulled through the shared proxy layer and merged. Several sources
// are used on purpose: Google News (the old single source) now answers HTTP 503
// bot-check pages to any datacenter IP, so anything behind a CORS proxy gets
// nothing back, and Yahoo's RSS endpoint answers 403 the same way. Merging a
// few surviving feeds also means one of them going dark no longer empties the
// ticker.
// ═══════════════════════════════════════════════════════════════════════════════

import { dbLog } from './debug.js';
import { proxyFetch } from './proxy.js';

const FEEDS = [
  // Query-targeted, so every item is already on topic.
  { name: 'Bing News', url: 'https://www.bing.com/news/search?q=natural+gas+price+OR+henry+hub&format=RSS', filter: false },
  // Broader energy feeds — filtered to natural-gas stories below.
  { name: 'OilPrice',  url: 'https://oilprice.com/rss/main', filter: true },
  { name: 'EIA',       url: 'https://www.eia.gov/rss/todayinenergy.xml', filter: true },
];

// Keeps the general energy feeds on topic for a natural-gas dashboard.
const NG_RE = /\b(natural gas|nat gas|natgas|henry hub|lng|gas price|gas storage|gas demand|pipeline)\b/i;

// Parse RSS XML to extract news items
function parseRSS(xmlText) {
  const items = [];
  const parser = new DOMParser();
  const xml = parser.parseFromString(xmlText, 'application/xml');
  const itemEls = xml.querySelectorAll('item');
  itemEls.forEach(el => {
    let title = el.querySelector('title')?.textContent || '';
    const link  = el.querySelector('link')?.textContent || '';
    const pubDate = el.querySelector('pubDate')?.textContent || '';
    const description = el.querySelector('description')?.textContent || '';
    // Prefer the feed's own <source> element (Bing supplies one). The old code
    // instead stripped a trailing " - Name" off the title, a Google News
    // convention — with Google gone that heuristic only truncated real titles
    // such as "Gas rises - what it means for winter".
    const source = el.querySelector('source')?.textContent?.trim() || '';
    if (title) items.push({ title: title.trim(), link, source, pubDate: new Date(pubDate), description });
  });
  return items;
}

async function fetchRSS() {
  // Shares the health-tracked proxy pool with the price feeds — the ticker used
  // to keep its own list of proxies, all three of which are now dead.
  const settled = await Promise.allSettled(FEEDS.map(async f => {
    const text = await proxyFetch(f.url, {
      ttl: 5 * 60 * 1000,
      validate: t => t.includes('<item') || t.includes('<entry'),
    });
    let items = parseRSS(text);
    if (f.filter) items = items.filter(i => NG_RE.test(i.title + ' ' + i.description));
    return items.map(i => ({ ...i, source: i.source || f.name }));
  }));

  const all = [];
  const seen = new Set();
  settled.forEach((r, i) => {
    if (r.status !== 'fulfilled') {
      dbLog('News feed ' + FEEDS[i].name + ': ' + r.reason?.message, 'warn');
      return;
    }
    for (const item of r.value) {
      // Same story often appears in more than one feed.
      const k = item.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 60);
      if (seen.has(k)) continue;
      seen.add(k);
      all.push(item);
    }
  });

  if (!all.length) throw new Error('no items from any feed');
  return all;
}

// Format relative time
function relTime(date) {
  if (!date || isNaN(date.getTime())) return '';
  const diff = (Date.now() - date.getTime()) / 1000;
  if (diff < 60)        return Math.floor(diff) + 's';
  if (diff < 3600)      return Math.floor(diff / 60) + 'm';
  if (diff < 86400)     return Math.floor(diff / 3600) + 'h';
  if (diff < 86400 * 7) return Math.floor(diff / 86400) + 'd';
  const d = new Date(date);
  return d.getDate() + '.' + (d.getMonth() + 1) + '.';
}

let _ticker = null;
let _items = [];

export async function newsLoad() {
  const wrap = document.getElementById('news-ticker');
  if (!wrap) return;
  try {
    const items = await fetchRSS();
    // Sort newest first (in case feed doesn't guarantee order)
    items.sort((a, b) => {
      const ta = a.pubDate && !isNaN(a.pubDate.getTime()) ? a.pubDate.getTime() : 0;
      const tb = b.pubDate && !isNaN(b.pubDate.getTime()) ? b.pubDate.getTime() : 0;
      return tb - ta;
    });
    _items = items.slice(0, 20); // keep latest 20
    renderTicker();
    dbLog('News: loaded ' + _items.length + ' items', 'ok');
  } catch (e) {
    dbLog('News: ' + e.message, 'warn');
    const content = document.getElementById('news-ticker-content');
    if (content) content.innerHTML = '<span style="color:var(--text4)">News feed unavailable</span>';
  }
}

function renderTicker() {
  const content = document.getElementById('news-ticker-content');
  if (!content || !_items.length) return;

  // Build HTML — duplicate items for seamless loop
  const itemHtml = item => {
    const rel = relTime(item.pubDate);
    const titleEsc = (item.title || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const sourceEsc = (item.source || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<a href="${item.link}" target="_blank" rel="noopener" class="news-item">
      <span class="news-time">${rel}</span>
      <span class="news-title">${titleEsc}</span>
      ${sourceEsc ? `<span class="news-source">· ${sourceEsc}</span>` : ''}
    </a>`;
  };

  // Duplicate items so scroll loop is seamless
  const allHtml = _items.map(itemHtml).join('<span class="news-sep">•</span>')
                + '<span class="news-sep">•</span>'
                + _items.map(itemHtml).join('<span class="news-sep">•</span>');
  content.innerHTML = allHtml;

  // Start scroll animation
  startScroll();
}

let _halfWidth = 0;

function startScroll() {
  const content = document.getElementById('news-ticker-content');
  if (!content) return;

  // Reset any previous animation
  content.style.animation = 'none';
  // Force reflow so animation restart works
  void content.offsetWidth;

  // Wait for layout to settle, then compute animation duration
  setTimeout(() => {
    _halfWidth = content.scrollWidth / 2;
    if (_halfWidth <= 0) return;

    const SPEED = 25; // pixels per second (slower = smoother)
    const duration = _halfWidth / SPEED; // seconds for one full half-loop

    // Inject keyframes dynamically (need exact pixel value)
    let styleEl = document.getElementById('news-ticker-keyframes');
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'news-ticker-keyframes';
      document.head.appendChild(styleEl);
    }
    styleEl.textContent = `
      @keyframes news-scroll {
        from { transform: translate3d(0, 0, 0); }
        to   { transform: translate3d(-${_halfWidth}px, 0, 0); }
      }
    `;

    // Apply CSS animation — runs on GPU compositor thread
    content.style.animation = `news-scroll ${duration}s linear infinite`;
    content.style.willChange = 'transform';
    content.style.backfaceVisibility = 'hidden';
    content.style.transformStyle = 'preserve-3d';
    content.style.perspective = '1000px';
  }, 100);
}

export function newsPauseHover() {
  const wrap = document.getElementById('news-ticker');
  if (!wrap) return;
  wrap.addEventListener('mouseenter', () => {
    const content = document.getElementById('news-ticker-content');
    if (content) content.style.animationPlayState = 'paused';
  });
  wrap.addEventListener('mouseleave', () => {
    const content = document.getElementById('news-ticker-content');
    if (content) content.style.animationPlayState = 'running';
  });
}

// Auto-refresh every 10 minutes
export function newsAutoRefresh() {
  setInterval(newsLoad, 10 * 60 * 1000);
}
