/**
 * Kelly Criterion for binary prediction markets.
 *
 * Correct formula for buying YES at price `p` with estimated true probability `pEdge`:
 *   f* = (pEdge - p) / (1 - p)
 *
 * For buying NO at price `(1 - p)` with estimated NO probability `qEdge`:
 *   f* = (qEdge - (1 - p)) / p
 *
 * Uses fractional Kelly (default quarter = 0.25x) to reduce variance.
 * Hard cap per bet: 5% of bankroll.
 * High-price danger zone ($0.75-$0.95): scale to 1/8th Kelly.
 */

const DEFAULT_KELLY_FRACTION = 0.25; // quarter-Kelly: ~56% growth, ~94% variance reduction
const MAX_BET_PCT = 0.05; // never risk more than 5% of bankroll on a single bet
const HIGH_PRICE_THRESHOLD = 0.75; // danger zone starts
const HIGH_PRICE_SCALE = 0.125; // 1/8th Kelly in danger zone
const FEE_RATE = 0.02; // ~2% round-trip fee on Polymarket

/**
 * Compute Kelly fraction for a binary prediction market.
 * @param {number} pEdge - Your estimated true probability (0-1)
 * @param {number} marketPrice - Current market price for YES (0-1)
 * @param {object} opts - Optional overrides
 * @returns {number} Fraction of bankroll to bet (0 if no edge)
 */
function kellyFraction(pEdge, marketPrice, opts = {}) {
  // Guard against NaN/undefined/Infinity inputs -- they must return 0, never NaN
  if (!Number.isFinite(pEdge) || !Number.isFinite(marketPrice)) return 0;

  const fraction = opts.fraction || DEFAULT_KELLY_FRACTION;
  const feeRate = opts.feeRate !== undefined ? opts.feeRate : FEE_RATE;

  if (marketPrice <= 0 || marketPrice >= (1 - feeRate)) return 0; // no profitable payoff after fees
  if (pEdge <= 0 || pEdge >= 1) return 0;

  // Adjust edge for fees: your net payoff on a win is (1 - marketPrice - feeRate)
  const netOdds = (1 - marketPrice - feeRate) / (marketPrice + feeRate);
  const qEdge = 1 - pEdge;

  // Standard Kelly: f* = (b*p - q) / b where b = net odds
  let fullKelly = (netOdds * pEdge - qEdge) / netOdds;

  if (fullKelly <= 0) return 0; // no edge after fees

  // High-price danger zone: small errors cause catastrophic Kelly swings
  if (marketPrice >= HIGH_PRICE_THRESHOLD && marketPrice < 0.96) {
    fullKelly *= HIGH_PRICE_SCALE;
  }

  // Apply fractional Kelly
  let fractionalKelly = fullKelly * fraction;

  // Hard cap
  fractionalKelly = Math.min(fractionalKelly, MAX_BET_PCT);

  return Math.max(fractionalKelly, 0);
}

/**
 * Compute bet size in dollars.
 * @param {number} pEdge - Estimated true probability
 * @param {number} marketPrice - Current YES price
 * @param {number} bankroll - Current bankroll in dollars
 * @param {object} opts - Optional overrides
 * @returns {number} Dollar amount to bet (0 if no edge)
 */
function kellyBetSize(pEdge, marketPrice, bankroll, opts = {}) {
  // Guard against non-finite inputs
  if (!Number.isFinite(bankroll) || bankroll <= 0) return 0;

  const frac = kellyFraction(pEdge, marketPrice, opts);
  const size = frac * bankroll;

  // Minimum viable bet on Polymarket is $1
  if (size < 1) return 0;

  // Don't bet more than available
  return Math.min(size, bankroll * MAX_BET_PCT);
}

/**
 * Compute NO-side Kelly (buying NO shares).
 * @param {number} qEdge - Your estimated true probability of NO (0-1)
 * @param {number} marketPriceYes - Current YES price (NO price = 1 - marketPriceYes)
 * @param {number} bankroll - Current bankroll
 * @param {object} opts - Optional overrides
 * @returns {number} Dollar amount to bet on NO
 */
function kellyBetSizeNO(qEdge, marketPriceYes, bankroll, opts = {}) {
  const noPrice = 1 - marketPriceYes;
  return kellyBetSize(qEdge, noPrice, bankroll, opts);
}

/**
 * Multi-market Kelly: scale down if total exposure exceeds risk budget.
 * @param {Array} bets - Array of {pEdge, marketPrice} objects
 * @param {number} bankroll - Current bankroll
 * @param {object} opts - Optional overrides
 * @returns {Array} Array of dollar amounts, scaled to fit budget
 */
function kellyPortfolio(bets, bankroll, opts = {}) {
  if (!Number.isFinite(bankroll) || bankroll <= 0) return bets.map(() => 0);

  const maxTotalExposure = opts.maxTotalExposure || 0.40; // max 40% of bankroll deployed

  const sizes = bets.map(b => kellyBetSize(b.pEdge, b.marketPrice, bankroll, opts));
  const totalExposure = sizes.reduce((sum, s) => sum + s, 0);
  const budget = bankroll * maxTotalExposure;

  if (totalExposure > budget && totalExposure > 0) {
    const scale = budget / totalExposure;
    return sizes.map(s => s * scale);
  }

  return sizes;
}

module.exports = {
  kellyFraction,
  kellyBetSize,
  kellyBetSizeNO,
  kellyPortfolio,
  DEFAULT_KELLY_FRACTION,
  MAX_BET_PCT,
};