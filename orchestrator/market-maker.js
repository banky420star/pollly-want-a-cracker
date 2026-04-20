/**
 * Market making strategy for Polymarket CLOB.
 *
 * Places bid and ask on both sides of the order book to capture the spread.
 * Uses Avellaneda-Stoikov inventory skewing to manage risk.
 *
 * REQUIRES: $10K+ bankroll for safe operation. Activate only when bankroll is sufficient.
 *
 * Revenue streams:
 * 1. Bid-ask spread capture
 * 2. Liquidity rewards (quadratic scoring, $5M+ monthly)
 * 3. Maker rebates (25% of taker fees)
 */

const { kellyBetSize } = require('./kelly');

// Minimum bankroll to activate market making
const MIN_MM_BANKROLL = 10000;
// Default spread from midpoint (in cents)
const DEFAULT_SPREAD = 0.03;
// Maximum inventory per market (fraction of total bankroll)
const MAX_INVENTORY_PCT = 0.15;
// Inventory skew parameter (gamma in Avellaneda-Stoikov)
const SKEW_GAMMA = 0.1;
// Time horizon for AS model (in fractions of a day)
const AS_TIME_HORIZON = 1 / 24; // 1 hour

class MarketMaker {
  constructor(tradingServer, opts = {}) {
    this.tradingServer = tradingServer;
    this.minSpread = opts.minSpread || DEFAULT_SPREAD;
    this.maxInventoryPct = opts.maxInventoryPct || MAX_INVENTORY_PCT;
    this.activeMarkets = new Map(); // tokenId -> { bidOrderId, askOrderId, inventory }
    this.enabled = false;
  }

  /**
   * Check if market making should be active based on bankroll.
   */
  canActivate(bankroll) {
    return bankroll >= MIN_MM_BANKROLL;
  }

  /**
   * Compute Avellaneda-Stoikov reservation price and quotes.
   * P_r = P_mid - (q * gamma * sigma^2 * T)
   */
  computeQuotes(midpoint, inventory, sigma, spread) {
    const q = inventory; // positive = long, negative = short
    const gamma = SKEW_GAMMA;
    const T = AS_TIME_HORIZON;

    // Reservation price shifts away from midpoint based on inventory
    const reservationPrice = midpoint - (q * gamma * sigma * sigma * T);

    // Spread widens with volatility and inventory
    const halfSpread = spread / 2;
    const skew = q * gamma * sigma * T;

    const bid = Math.max(reservationPrice - halfSpread - skew, 0.01);
    const ask = Math.min(reservationPrice + halfSpread - skew, 0.99);

    return {
      bid: Math.round(bid * 100) / 100,
      ask: Math.round(ask * 100) / 100,
      reservationPrice: Math.round(reservationPrice * 100) / 100
    };
  }

  /**
   * Place quotes for a single market.
   */
  async quoteMarket(tokenId, midpoint, sigma, bankroll, negRisk = false) {
    if (!this.enabled) return null;

    const inventory = this.activeMarkets.get(tokenId)?.inventory || 0;
    const inventoryValue = Math.abs(inventory) * midpoint;

    // Skip if inventory exceeds max
    if (bankroll > 0 && inventoryValue / bankroll > this.maxInventoryPct) {
      console.log(`[MM] Skipping ${tokenId.slice(0,10)}: inventory ${inventoryValue.toFixed(2)} exceeds ${(this.maxInventoryPct*100).toFixed(0)}% of bankroll`);
      return null;
    }

    const { bid, ask } = this.computeQuotes(midpoint, inventory, sigma, this.minSpread);

    // Validate spread
    if (ask - bid < 0.01) return null;

    // Compute order size (2% of bankroll per side)
    const orderSize = Math.max(bankroll * 0.02 / midpoint, 1);

    try {
      // Place bid
      const bidResp = await fetch(`${this.tradingServer}/api/buy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tokenId,
          price: bid,
          size: Math.ceil(orderSize),
          tickSize: '0.01',
          negRisk
        })
      });

      // Place ask
      const askResp = await fetch(`${this.tradingServer}/api/sell`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tokenId,
          price: ask,
          size: Math.ceil(orderSize),
          tickSize: '0.01',
          negRisk
        })
      });

      const bidResult = await bidResp.json();
      const askResult = await askResp.json();

      this.activeMarkets.set(tokenId, {
        bidOrderId: bidResult.orderID,
        askOrderId: askResult.orderID,
        inventory,
        lastQuote: { bid, ask, time: Date.now() }
      });

      return { bid, ask, bidOrderId: bidResult.orderID, askOrderId: askResult.orderID };
    } catch (e) {
      console.error(`[MM] Error quoting ${tokenId.slice(0,10)}:`, e.message);
      return null;
    }
  }

  /**
   * Cancel all quotes for a market.
   */
  async cancelQuotes(tokenId) {
    const market = this.activeMarkets.get(tokenId);
    if (!market) return;

    try {
      if (market.bidOrderId) {
        await fetch(`${this.tradingServer}/api/cancel`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orderId: market.bidOrderId })
        });
      }
      if (market.askOrderId) {
        await fetch(`${this.tradingServer}/api/cancel`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orderId: market.askOrderId })
        });
      }
    } catch (e) {
      console.error(`[MM] Cancel error:`, e.message);
    }

    this.activeMarkets.delete(tokenId);
  }

  /**
   * Update inventory after a fill.
   */
  updateInventory(tokenId, fillSide, fillSize) {
    const market = this.activeMarkets.get(tokenId);
    if (!market) return;

    if (fillSide === 'BUY') {
      market.inventory += fillSize;
    } else {
      market.inventory -= fillSize;
    }

    // If we have both YES and NO shares, merge them (risk-free $1 each)
    // This is the "merge hedge" strategy
    if (market.inventory > 0) {
      // Have net YES shares — if we also hold NO elsewhere, merge
      console.log(`[MM] ${tokenId.slice(0,10)}: inventory now ${market.inventory.toFixed(2)} YES shares`);
    }
  }
}

module.exports = { MarketMaker, MIN_MM_BANKROLL };