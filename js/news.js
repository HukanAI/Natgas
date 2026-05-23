// ═══════════════════════════════════════════════════════════════════════════════
// news.js — Natural Gas news ticker
// Source: Yahoo Finance RSS feed for NG=F ticker
// ═══════════════════════════════════════════════════════════════════════════════

import { dbLog } from './debug.js';

// Use Google News RSS — works through CORS proxies, multiple sources
const FEED_URL = 'https://news.google.com/rss/search?q=natural+gas+price+OR+henry+hub&hl=en-US&gl=US&ceid=US:en';

const CORS_PROXIES = [
  url => 'https://corsproxy.io/?url=' + encodeURIComponent(url),
  url => 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(url),
  url => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(url),
];

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
    // Google News appends " - Source Name" — extract source separately
    let source = '';
    const sourceMatch = title.match(/\s+-\s+([^-]+)$/);
    if (sourceMatch) {
      source = sourceMatch[1].trim();
      title = title.replace(/\s+-\s+[^-]+$/, '').trim();
    }
    if (title) items.push({ title, link, source, pubDate: new Date(pubDate), description });
  });
  return items;
}

async function fetchRSS() {
  let lastErr = null;
  for (const proxy of CORS_PROXIES) {
    try {
      const res = await fetch(proxy(FEED_URL), { signal: AbortSignal.timeout(8000), cache: 'no-store' });
      if (!res.ok) { lastErr = new Error('HTTP ' + res.status); continue; }
      const text = await res.text();
      const items = parseRSS(text);
      if (items.length) return items;
      lastErr = new Error('no items');
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('all proxies failed');
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
    // Notify mobile to render news feed
    document.dispatchEvent(new CustomEvent('news:loaded', { detail: _items }));
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
