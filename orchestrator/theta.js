/**
 * Time decay / theta exploitation strategy for prediction markets.
 *
 * Key insights:
 * 1. Fade markets priced above $0.82 — crowd is systematically overconfident (actual resolution ~72-76%)
 * 2. Temporal inconsistency: longer-dated same-event should have >= probability of shorter-dated
 * 3. Near-expiry contracts with high uncertainty are overpriced
 */

// Standard normal CDF approximation (Abramowitz and Stegun)
function normalCDF(x) {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.sqrt(2);
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1.0 + sign * y);
}

function logit(p) {
  return Math.log(p / (1 - p));
}

/**
 * Compute fair value of a binary contract using theta model.
 * FV = Phi(logit(p) / (sigma * sqrt(tau)))
 *
 * @param {number} marketPrice - Current market price
 * @param {number} daysToExpiry - Days until market resolves
 * @param {number} sigma - Daily log-odds volatility (0.4-0.7 for active markets)
 * @returns {number} Fair value estimate
 */
function thetaFairValue(marketPrice, daysToExpiry, sigma = 0.5) {
  if (daysToExpiry <= 0 || marketPrice <= 0 || marketPrice >= 1) return marketPrice;
  const z = logit(marketPrice) / (sigma * Math.sqrt(daysToExpiry));
  return normalCDF(z);
}

/**
 * Scan for theta exploitation opportunities.
 * @param {Array} markets - Array of Polymarket market objects
 * @returns {Array} Opportunities sorted by edge size
 */
function scanThetaOpportunities(markets) {
  const opportunities = [];

  for (const m of markets) {
    const price = parseFloat(m.outcomePrices?.split(',')[0] || m.price || 0);
    if (price <= 0.05 || price >= 0.95) continue;

    const endDate = m.endDate ? new Date(m.endDate) : null;
    if (!endDate) continue;

    const daysToExpiry = (endDate - Date.now()) / (1000 * 60 * 60 * 24);
    if (daysToExpiry <= 0 || daysToExpiry > 14) continue;

    // Determine sigma based on category
    const category = (m.category || m.groupItemTitle || '').toLowerCase();
    const sigma = category.includes('crypto') ? 0.70 :
                  category.includes('politic') ? 0.55 :
                  category.includes('sport') ? 0.45 : 0.50;

    const fairValue = thetaFairValue(price, daysToExpiry, sigma);
    const edge = price - fairValue; // positive = market overpriced = SELL signal

    // Strategy 1: Fade overconfidence (price > $0.82 with time remaining)
    if (price > 0.82 && daysToExpiry > 1) {
      const overconfidenceEdge = price - 0.76; // actual resolution ~72-76% at this price
      if (overconfidenceEdge > 0.03) {
        opportunities.push({
          type: 'fade-overconfidence',
          title: m.question,
          price,
          fairValue: fairValue.toFixed(3),
          edge: (overconfidenceEdge * 100).toFixed(1) + '%',
          direction: 'SELL YES / BUY NO',
          daysToExpiry: Math.round(daysToExpiry),
          conditionId: m.conditionId,
          reasoning: `Market at $${price.toFixed(2)} but historically resolves at ~76% at this level (${Math.round(daysToExpiry)}d left)`
        });
      }
    }

    // Strategy 2: Theta mispricing (market price deviates significantly from fair value)
    if (Math.abs(edge) > 0.05 && daysToExpiry < 14) {
      opportunities.push({
        type: 'theta-mispricing',
        title: m.question,
        price,
        fairValue: fairValue.toFixed(3),
        edge: (edge * 100).toFixed(1) + '%',
        direction: edge > 0 ? 'SELL YES (overpriced)' : 'BUY YES (underpriced)',
        daysToExpiry: Math.round(daysToExpiry),
        conditionId: m.conditionId,
        reasoning: `Market at $${price.toFixed(2)}, theta fair value $${fairValue.toFixed(2)} (${edge > 0 ? 'overpriced' : 'underpriced'} by ${Math.abs(edge * 100).toFixed(1)}%)`
      });
    }

    // Strategy 3: Near-expiry NO farming on overhyped events
    if (price > 0.40 && price < 0.70 && daysToExpiry < 3) {
      opportunities.push({
        type: 'near-expiry-no-farm',
        title: m.question,
        price,
        edge: ((1 - price) > 0.35 ? 'HIGH' : 'MEDIUM'),
        direction: 'BUY NO',
        daysToExpiry: Math.round(daysToExpiry * 24) + 'h',
        conditionId: m.conditionId,
        reasoning: `Uncertain market near expiry — NO share at $${(1-price).toFixed(2)} with ${Math.round(daysToExpiry*24)}h left`
      });
    }
  }

  // Sort by edge size (descending)
  opportunities.sort((a, b) => parseFloat(b.edge) - parseFloat(a.edge));
  return opportunities;
}

/**
 * Detect temporal inconsistency: "Event X by March" vs "Event X by June"
 * The longer-dated should always have >= probability of shorter-dated.
 * @param {Array} markets - All markets (will be grouped by event)
 * @returns {Array} Temporal inconsistencies
 */
function detectTemporalInconsistency(markets) {
  const opportunities = [];

  // Group markets by similar titles
  const groups = new Map();
  for (const m of markets) {
    const title = (m.question || '').toLowerCase().replace(/by\s+\w+\s+\d{4}.*/, '').trim();
    if (title.length < 10) continue;
    if (!groups.has(title)) groups.set(title, []);
    groups.get(title).push(m);
  }

  for (const [baseTitle, group] of groups) {
    if (group.length < 2) continue;

    // Sort by end date
    const sorted = group
      .map(m => ({
        ...m,
        price: parseFloat(m.outcomePrices?.split(',')[0] || m.price || 0),
        endDate: m.endDate ? new Date(m.endDate) : null
      }))
      .filter(m => m.endDate && m.price > 0 && m.price < 1)
      .sort((a, b) => a.endDate - b.endDate);

    // Check if longer-dated has lower price than shorter-dated (inconsistency)
    for (let i = 0; i < sorted.length - 1; i++) {
      const near = sorted[i];
      const far = sorted[i + 1];

      if (far.price < near.price - 0.03) {
        const spread = near.price - far.price;
        opportunities.push({
          type: 'temporal-inconsistency',
          nearTitle: near.question,
          nearPrice: near.price,
          nearExpiry: near.endDate.toISOString().split('T')[0],
          farTitle: far.question,
          farPrice: far.price,
          farExpiry: far.endDate.toISOString().split('T')[0],
          spread: (spread * 100).toFixed(1) + '%',
          direction: 'BUY far-term, SELL near-term',
          reasoning: `Longer-dated (${far.price.toFixed(2)}) priced below shorter-dated (${near.price.toFixed(2)}) — logical impossibility, spread ${spread.toFixed(2)}`
        });
      }
    }
  }

  return opportunities;
}

module.exports = {
  scanThetaOpportunities,
  detectTemporalInconsistency,
  thetaFairValue,
  normalCDF
};

if (require.main === module) {
  (async () => {
    const { fetchPolymarketMarkets } = require('./arb-scanner');
    const markets = await fetchPolymarketMarkets('bitcoin');
    const opps = scanThetaOpportunities(markets);
    console.log(JSON.stringify(opps, null, 2));
  })();
}