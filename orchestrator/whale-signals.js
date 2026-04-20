/**
 * Whale signal detection and smart money tracking.
 *
 * Key signals:
 * 1. Multiple high-scored traders entering same side within short window (strongest)
 * 2. Contrarian whales betting against 80%+ consensus
 * 3. Exit signals: trim, full exit, flip
 * 4. Fresh wallets making large trades (potential insider)
 */

// ── Whale cluster detection ──

function detectWhaleClusters(traderActivity, windowMinutes = 30) {
  const clusters = [];
  const byMarket = new Map();

  for (const act of traderActivity) {
    const key = act.tokenId || act.conditionId;
    if (!byMarket.has(key)) byMarket.set(key, []);
    byMarket.get(key).push(act);
  }

  for (const [marketKey, activities] of byMarket) {
    const buys = activities.filter(a => a.side === 'BUY');
    const sells = activities.filter(a => a.side === 'SELL');

    // Check for 3+ independent buyers within the window
    const recentBuys = buys.filter(a => {
      const age = Date.now() - (a.timestamp || 0);
      return age < windowMinutes * 60 * 1000;
    });

    const uniqueTraders = new Set(recentBuys.map(a => a.traderAddress));
    if (uniqueTraders.size >= 3) {
      clusters.push({
        type: 'whale-cluster-buy',
        marketKey,
        traderCount: uniqueTraders.size,
        totalVolume: recentBuys.reduce((s, a) => s + (a.size || 0), 0),
        direction: 'BUY',
        strength: uniqueTraders.size >= 5 ? 'VERY_STRONG' : 'STRONG',
        signal: `${uniqueTraders.size} whales buying same side within ${windowMinutes}min`
      });
    }

    // Same for sells
    const recentSells = sells.filter(a => {
      const age = Date.now() - (a.timestamp || 0);
      return age < windowMinutes * 60 * 1000;
    });

    const uniqueSellers = new Set(recentSells.map(a => a.traderAddress));
    if (uniqueSellers.size >= 3) {
      clusters.push({
        type: 'whale-cluster-sell',
        marketKey,
        traderCount: uniqueSellers.size,
        totalVolume: recentSells.reduce((s, a) => s + (a.size || 0), 0),
        direction: 'SELL',
        strength: uniqueSellers.size >= 5 ? 'VERY_STRONG' : 'STRONG',
        signal: `${uniqueSellers.size} whales selling same side within ${windowMinutes}min`
      });
    }
  }

  return clusters;
}

// ── Contrarian whale detection ──

function detectContrarianWhales(traderActivity, marketPrices) {
  const signals = [];

  for (const act of traderActivity) {
    const marketKey = act.tokenId || act.conditionId;
    const price = marketPrices[marketKey];
    if (!price) continue;

    // Whale buying NO when YES is > 80% consensus (contrarian)
    if (act.side === 'SELL' && price > 0.80) {
      signals.push({
        type: 'contrarian-whale',
        marketKey,
        traderAddress: act.traderAddress,
        direction: 'BUY NO',
        consensusPrice: price,
        strength: price > 0.90 ? 'VERY_STRONG' : 'STRONG',
        signal: `Whale buying NO against ${(price*100).toFixed(0)}% YES consensus`
      });
    }

    // Whale buying YES when YES is < 20% consensus (contrarian)
    if (act.side === 'BUY' && price < 0.20) {
      signals.push({
        type: 'contrarian-whale',
        marketKey,
        traderAddress: act.traderAddress,
        direction: 'BUY YES',
        consensusPrice: price,
        strength: price < 0.10 ? 'VERY_STRONG' : 'STRONG',
        signal: `Whale buying YES against only ${(price*100).toFixed(0)}% consensus`
      });
    }
  }

  return signals;
}

// ── Exit signal detection ──

function detectExitSignals(currentPositions, previousPositions) {
  const signals = [];

  for (const curr of currentPositions) {
    const prev = previousPositions.find(p => p.conditionId === curr.conditionId && p.traderAddress === curr.traderAddress);
    if (!prev) continue;

    const sizeChange = (prev.size || 0) - (curr.size || 0);
    const sizePctChange = prev.size > 0 ? sizeChange / prev.size : 0;

    // Full exit
    if (curr.size === 0 && prev.size > 0) {
      signals.push({
        type: 'whale-full-exit',
        conditionId: curr.conditionId,
        traderAddress: curr.traderAddress,
        direction: 'EXIT',
        strength: 'RED_FLAG',
        signal: `Whale fully exited position in ${curr.title || curr.conditionId}`
      });
    }
    // Trim (partial exit > 30%)
    else if (sizePctChange > 0.30) {
      signals.push({
        type: 'whale-trim',
        conditionId: curr.conditionId,
        traderAddress: curr.traderAddress,
        direction: 'TRIM',
        sizePctReduction: (sizePctChange * 100).toFixed(0) + '%',
        strength: 'MODERATE',
        signal: `Whale reduced position by ${(sizePctChange*100).toFixed(0)}% in ${curr.title || curr.conditionId}`
      });
    }
    // Flip (sold and bought opposite side)
    if (prev.side !== curr.side && curr.size > 0) {
      signals.push({
        type: 'whale-flip',
        conditionId: curr.conditionId,
        traderAddress: curr.traderAddress,
        fromSide: prev.side,
        toSide: curr.side,
        strength: 'VERY_STRONG',
        signal: `Whale FLIPPED from ${prev.side} to ${curr.side} in ${curr.title || curr.conditionId}`
      });
    }
  }

  return signals;
}

// ── Fresh wallet detection (potential insider) ──

function detectFreshWallets(traderActivity, minTradeSize = 100) {
  return traderActivity
    .filter(a => a.isNewWallet && (a.size || 0) * (a.price || 0) >= minTradeSize)
    .map(a => ({
      type: 'fresh-wallet',
      marketKey: a.tokenId || a.conditionId,
      traderAddress: a.traderAddress,
      size: a.size,
      direction: a.side,
      strength: 'SUSPICIOUS',
      signal: `New wallet making $${((a.size||0)*(a.price||0)).toFixed(0)}+ trade — possible insider`
    }));
}

module.exports = {
  detectWhaleClusters,
  detectContrarianWhales,
  detectExitSignals,
  detectFreshWallets
};