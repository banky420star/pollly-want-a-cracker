/**
 * Cross-platform arbitrage scanner for Polymarket vs Kalshi.
 * Detects same-event price mismatches where combined YES+NO cost < $1.00 - fees.
 */

require('dotenv').config();

const PROXY_URL = process.env.PROXY_URL;

// Kalshi public API endpoints
const KALSHI_API = 'https://api.kalshi.com/trade-api/v2';

// Minimum spread after fees to trigger arb (1.5% net)
const MIN_ARB_SPREAD = 0.015;
// Polymarket round-trip fee estimate
const PM_FEE = 0.02;
// Kalshi fee estimate (variable, 1.75-3%)
const KALSHI_FEE = 0.025;

async function fetchJSON(url, opts = {}) {
  const headers = { 'Accept': 'application/json', 'User-Agent': 'ArbScanner/1.0', ...(opts.headers || {}) };
  const fetchOpts = { headers, signal: opts.signal || AbortSignal.timeout(15000) };
  const res = await fetch(url, fetchOpts);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── Kalshi market fetching ──

async function fetchKalshiMarkets(category) {
  try {
    const url = `${KALSHI_API}/markets?category=${category}&limit=100&active=true`;
    const data = await fetchJSON(url);
    return data.markets || [];
  } catch (e) {
    console.error('[ARB] Kalshi fetch error:', e.message);
    return [];
  }
}

// ── Polymarket market fetching ──

async function fetchPolymarketMarkets(query) {
  try {
    const url = `https://gamma-api.polymarket.com/markets?closed=false&limit=20&title_contains=${encodeURIComponent(query)}`;
    const data = await fetchJSON(url);
    return data || [];
  } catch (e) {
    console.error('[ARB] Polymarket fetch error:', e.message);
    return [];
  }
}

// ── Fuzzy match events across platforms ──

function normalizeTitle(title) {
  return title.toLowerCase()
    .replace(/[?¿!.,;:'"()]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleSimilarity(a, b) {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  const wordsA = new Set(na.split(' '));
  const wordsB = new Set(nb.split(' '));
  const intersection = [...wordsA].filter(w => wordsB.has(w)).length;
  const union = new Set([...wordsA, ...wordsB]).size;
  return union > 0 ? intersection / union : 0;
}

// ── Find arbitrage opportunities ──

async function scanArbitrage(pmMarkets) {
  const opportunities = [];

  // Fetch Kalshi markets across key categories
  const categories = ['politics', 'economics', 'crypto', 'science', 'sports'];
  const kalshiPromises = categories.map(c => fetchKalshiMarkets(c));
  const kalshiResults = await Promise.allSettled(kalshiPromises);
  const allKalshi = kalshiResults
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value);

  for (const pm of pmMarkets) {
    if (!pm.question || pm.closed) continue;

    const pmYesPrice = parseFloat(pm.outcomePrices?.split(',')[0] || pm.price || 0);
    if (pmYesPrice <= 0.05 || pmYesPrice >= 0.95) continue; // skip near-certain

    for (const ks of allKalshi) {
      const sim = titleSimilarity(pm.question, ks.title || ks.question || '');
      if (sim < 0.35) continue; // not similar enough

      const ksYesPrice = parseFloat(ks.last_price || ks.yes_price || 0);
      if (ksYesPrice <= 0 || ksYesPrice >= 1) continue;

      // Check both directions for arb
      // Buy YES on cheaper platform, buy NO on the other
      const cheapestYes = Math.min(pmYesPrice, ksYesPrice);
      const cheapestNo = Math.min(1 - pmYesPrice, 1 - ksYesPrice);
      const totalCost = cheapestYes + cheapestNo;
      const grossSpread = 1.0 - totalCost;
      const netSpread = grossSpread - PM_FEE - KALSHI_FEE;

      if (netSpread >= MIN_ARB_SPREAD) {
        opportunities.push({
          polymarket: { title: pm.question, yesPrice: pmYesPrice, conditionId: pm.conditionId },
          kalshi: { title: ks.title || ks.question, yesPrice: ksYesPrice, ticker: ks.ticker },
          grossSpread: (grossSpread * 100).toFixed(2) + '%',
          netSpread: (netSpread * 100).toFixed(2) + '%',
          cheapestYesPlatform: pmYesPrice < ksYesPrice ? 'Polymarket' : 'Kalshi',
          cheapestNoPlatform: (1 - pmYesPrice) < (1 - ksYesPrice) ? 'Polymarket' : 'Kalshi',
          similarity: (sim * 100).toFixed(1) + '%',
          warning: 'Resolution rules may differ — always verify exact wording before executing'
        });
      }
    }
  }

  // Sort by net spread descending
  opportunities.sort((a, b) => parseFloat(b.netSpread) - parseFloat(a.netSpread));
  return opportunities.slice(0, 20);
}

// ── Sum-to-one arb within Polymarket itself ──

async function scanSumToOneArb(pmMarkets) {
  const opportunities = [];

  for (const market of pmMarkets) {
    const prices = (market.outcomePrices || '').split(',').map(Number);
    if (prices.length !== 2) continue;

    const yesPrice = prices[0];
    const noPrice = prices[1];
    const total = yesPrice + noPrice;

    if (total < 1.0 - MIN_ARB_SPREAD - PM_FEE && total > 0) {
      const netSpread = 1.0 - total - PM_FEE;
      if (netSpread >= MIN_ARB_SPREAD) {
        opportunities.push({
          type: 'sum-to-one',
          title: market.question,
          yesPrice,
          noPrice,
          total,
          netSpread: (netSpread * 100).toFixed(2) + '%',
          conditionId: market.conditionId
        });
      }
    }
  }

  return opportunities;
}

module.exports = { scanArbitrage, scanSumToOneArb, fetchKalshiMarkets, fetchPolymarketMarkets };

if (require.main === module) {
  (async () => {
    const pmMarkets = await fetchPolymarketMarkets('bitcoin');
    console.log(`Found ${pmMarkets.length} Polymarket markets`);
    const arbs = await scanArbitrage(pmMarkets);
    console.log(JSON.stringify(arbs, null, 2));
  })();
}