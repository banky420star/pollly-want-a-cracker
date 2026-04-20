require('dotenv').config();

const PROXY_URL = process.env.PROXY_URL;
const NEWSAPI_KEY = process.env.NEWSAPI_KEY;
const GNEWS_KEY = process.env.GNEWS_KEY;

// Cache news results for 5 minutes to stay within rate limits
const newsCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

async function fetchWithProxy(url, opts = {}) {
  const headers = {
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    ...(opts.headers || {})
  };

  const fetchOpts = { headers, signal: opts.signal || AbortSignal.timeout(10000) };

  if (PROXY_URL) {
    const HttpsProxyAgent = require('https-proxy-agent');
    fetchOpts.agent = new HttpsProxyAgent(PROXY_URL);
  }

  return fetch(url, fetchOpts);
}

function extractKeywords(title) {
  const stopWords = ['will', 'the', 'a', 'an', 'in', 'on', 'at', 'by', 'for', 'of', 'to', 'be', 'is', 'are', 'was', 'were', 'and', 'or', 'but', 'this', 'that', 'with', 'from', 'has', 'have', 'not', 'how', 'what', 'when', 'where', 'which', 'who', 'why'];
  return title.toLowerCase()
    .replace(/[?¿!.,;:'"()]/g, '')
    .split(' ')
    .filter(w => w.length > 3 && !stopWords.includes(w))
    .slice(0, 5);
}

// ── Real News API sources ──

async function fetchFromNewsAPI(keywords) {
  if (!NEWSAPI_KEY) return [];
  try {
    const query = keywords.join(' AND ');
    const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(query)}&sortBy=publishedAt&pageSize=5&language=en&apiKey=${NEWSAPI_KEY}`;
    const res = await fetchWithProxy(url);
    const data = await res.json();
    if (!data.articles) return [];
    return data.articles.map(a => ({
      title: a.title || '',
      url: a.url || '',
      snippet: (a.description || '').slice(0, 200),
      published: a.publishedAt || null,
      source: a.source?.name || 'NewsAPI'
    }));
  } catch (e) {
    console.error('[NEWS] NewsAPI error:', e.message);
    return [];
  }
}

async function fetchFromGNews(keywords) {
  if (!GNEWS_KEY) return [];
  try {
    const query = keywords.join(' ');
    const url = `https://gnews.io/api/v4/search?q=${encodeURIComponent(query)}&max=5&lang=en&token=${GNEWS_KEY}`;
    const res = await fetchWithProxy(url);
    const data = await res.json();
    if (!data.articles) return [];
    return data.articles.map(a => ({
      title: a.title || '',
      url: a.url || '',
      snippet: (a.description || '').slice(0, 200),
      published: a.publishedAt || null,
      source: a.source?.name || 'GNews'
    }));
  } catch (e) {
    console.error('[NEWS] GNews error:', e.message);
    return [];
  }
}

async function fetchFromRSS(keywords) {
  // Google News RSS — no API key needed, unlimited
  try {
    const query = keywords.join(' ');
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
    const res = await fetchWithProxy(url);
    const xml = await res.text();

    // Simple RSS parsing — extract items
    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRegex.exec(xml)) !== null && items.length < 5) {
      const item = match[1];
      const titleMatch = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/);
      const linkMatch = item.match(/<link>(.*?)<\/link>/);
      const descMatch = item.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>|<description>(.*?)<\/description>/);
      const pubMatch = item.match(/<pubDate>(.*?)<\/pubDate>/);

      items.push({
        title: (titleMatch?.[1] || titleMatch?.[2] || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'),
        url: (linkMatch?.[1] || '').trim(),
        snippet: (descMatch?.[1] || descMatch?.[2] || '').replace(/<[^>]*>/g, '').slice(0, 200),
        published: pubMatch?.[1] || null,
        source: 'GoogleNews'
      });
    }
    return items;
  } catch (e) {
    console.error('[NEWS] RSS error:', e.message);
    return [];
  }
}

// ── Fallback: Polymarket related markets (for when no API keys configured) ──

async function fetchFromPolymarket(keywords, conditionId) {
  try {
    const query = keywords.join(' ');
    const url = `https://gamma-api.polymarket.com/markets?closed=false&limit=10&title_contains=${encodeURIComponent(query)}`;
    const res = await fetchWithProxy(url);
    const markets = await res.json();
    if (!markets || markets.length === 0) return [];
    return markets
      .filter(m => m.conditionId !== conditionId && m.question && !m.closed)
      .slice(0, 3)
      .map(m => ({
        title: m.question,
        url: `https://polymarket.com/market?conditionId=${m.conditionId}`,
        snippet: m.description || `Volume: $${m.volume || 0}`,
        published: m.createdAt || null,
        source: 'Polymarket'
      }));
  } catch (e) {
    return [];
  }
}

// ── Main exports ──

async function fetchMarketNews(conditionId, title) {
  if (!title) return [];

  const keywords = extractKeywords(title);
  if (keywords.length < 2) return [];

  // Check cache
  const cacheKey = `market:${keywords.join(',')}`;
  const cached = newsCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  // Try real news sources first (parallel)
  const [newsAPI, gnews, rss] = await Promise.allSettled([
    fetchFromNewsAPI(keywords),
    fetchFromGNews(keywords),
    fetchFromRSS(keywords)
  ]);

  const articles = [
    ...(newsAPI.status === 'fulfilled' ? newsAPI.value : []),
    ...(gnews.status === 'fulfilled' ? gnews.value : []),
    ...(rss.status === 'fulfilled' ? rss.value : []),
  ];

  // If no real news found, fall back to Polymarket (better than nothing)
  if (articles.length === 0) {
    const pm = await fetchFromPolymarket(keywords, conditionId);
    articles.push(...pm);
  }

  // Deduplicate by title similarity
  const seen = new Set();
  const unique = articles.filter(a => {
    const key = a.title.toLowerCase().slice(0, 50);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 10);

  // Sort by publication date (newest first)
  unique.sort((a, b) => {
    if (!a.published) return 1;
    if (!b.published) return -1;
    return new Date(b.published) - new Date(a.published);
  });

  newsCache.set(cacheKey, { data: unique, ts: Date.now() });
  return unique;
}

async function fetchRelevantNews(query, numResults = 5) {
  const keywords = query.toLowerCase().split(' ').filter(w => w.length > 3).slice(0, 5);
  if (keywords.length < 1) return [];

  // Check cache
  const cacheKey = `relevant:${keywords.join(',')}`;
  const cached = newsCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data.slice(0, numResults);

  // Try real news sources first
  const [newsAPI, gnews, rss] = await Promise.allSettled([
    fetchFromNewsAPI(keywords),
    fetchFromGNews(keywords),
    fetchFromRSS(keywords)
  ]);

  const articles = [
    ...(newsAPI.status === 'fulfilled' ? newsAPI.value : []),
    ...(gnews.status === 'fulfilled' ? gnews.value : []),
    ...(rss.status === 'fulfilled' ? rss.value : []),
  ];

  if (articles.length === 0) {
    const pm = await fetchFromPolymarket(keywords, null);
    articles.push(...pm);
  }

  const seen = new Set();
  const unique = articles.filter(a => {
    const key = a.title.toLowerCase().slice(0, 50);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, numResults);

  newsCache.set(cacheKey, { data: unique, ts: Date.now() });
  return unique;
}

module.exports = { fetchRelevantNews, fetchMarketNews };

if (require.main === module) {
  (async () => {
    const news = await fetchRelevantNews('Bitcoin', 5);
    console.log(JSON.stringify(news, null, 2));
  })();
}