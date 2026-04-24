require('dotenv').config();

// Paper trading controlled via PAPER_TRADING env var (set in .env or command line)
// Do NOT force it on here — it pollutes analytics with fake data

const { fetchMarketNews, fetchRelevantNews } = require('./news-fetcher');
const { kellyBetSize, kellyFraction, MAX_BET_PCT } = require('./kelly');
const memory = require('./memory');
const { scanArbitrage, scanSumToOneArb } = require('./arb-scanner');
const { scanThetaOpportunities, detectTemporalInconsistency } = require('./theta');
const {
  recordBet,
  resolveBet,
  getPerformanceStats,
  getWinningPatterns,
  updatePattern,
  recordMarketResolved,
  getResolvedMarkets
} = memory;

const TARGET_PROFIT = 100_000_000;
const CONFIDENCE_THRESHOLD = parseFloat(process.env.MIN_CONFIDENCE || '0.52');
const BASE_BET = parseFloat(process.env.BASE_BET || '1');
const TRADING_SERVER = process.env.TRADING_SERVER_URL || 'http://127.0.0.1:4002';
const CYCLE_MS = parseInt(process.env.ORCHESTRATOR_CYCLE_MS || '15000');
const MAX_TRADES_PER_CYCLE = parseInt(process.env.MAX_TRADES_PER_CYCLE || '10');
const COMPOUND_RATE = parseFloat(process.env.COMPOUND_RATE || '1.5');
const MIN_PROFIT_TRADE = parseFloat(process.env.MIN_PROFIT_TRADE || '0.50');

let isRunning = false;
let cycleCount = 0;
let sessionProfit = 0;
let totalWagered = 0;
let bankroll = 0;
let initialBankroll = 0;
let peakBankroll = 0;
let leverage = 1;
let lastUpdate = Date.now();

const SEARCH_QUERIES = [
  'Bitcoin',
  'Ethereum',
  'crypto',
  'Fed rate',
  'Trump',
  'election',
  'AI',
  'stock market',
  'economy',
  'tariff',
  'war',
  'treaty',
  'sports',
  'football',
  'basketball',
  'tennis',
  'golf',
  'olympics',
  'weather',
  'climate'
];

let executedTrades = [];
let pendingOrders = new Map();
let lastPrices = new Map();

async function searchMarkets(query) {
  try {
    const res = await fetch(`https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=20&order=volume24hr&ascending=false&title_contains=${encodeURIComponent(query)}`);
    const markets = await res.json();

    return markets.map(m => {
      const tokenIds = JSON.parse(m.clobTokenIds || '[]');
      const outcomes = JSON.parse(m.outcomes || '[]');
      const prices = JSON.parse(m.outcomePrices || '[]');

      return {
        conditionId: m.conditionId,
        question: m.question,
        slug: m.slug,
        tokens: tokenIds.map((id, i) => ({
          tokenId: id,
          outcome: outcomes[i],
          price: parseFloat(prices[i] || 0)
        })).filter(t => t.price > 0),
        active: m.active,
        closed: m.closed,
        volume: parseFloat(m.volume || 0),
        negRisk: m.negRisk || false,
        endDate: m.endDate || null,
        description: m.description || ''
      };
    }).filter(m => m.tokens.length > 0 && !m.closed);
  } catch (e) {
    console.error('[SEARCH] Error:', e.message);
    return [];
  }
}

async function fetchLiveMarkets(limit = 50) {
  try {
    const res = await fetch(`https://gamma-api.polymarket.com/events?active=true&closed=false&order=volume24hr&ascending=false&limit=${limit}`);
    const events = await res.json();
    const markets = [];

    for (const event of events) {
      if (!event.markets || !Array.isArray(event.markets)) continue;

      for (const m of event.markets) {
        const tokenIds = JSON.parse(m.clobTokenIds || '[]');
        const outcomes = JSON.parse(m.outcomes || '[]');
        const prices = JSON.parse(m.outcomePrices || '[]');

        if (tokenIds.length === 0 || m.closed) continue;

        const tokens = tokenIds.map((id, i) => ({
          tokenId: id,
          outcome: outcomes[i],
          price: parseFloat(prices[i] || 0)
        })).filter(t => t.price > 0);

        if (tokens.length === 0) continue;

        markets.push({
          conditionId: m.conditionId,
          question: m.question,
          slug: m.slug,
          tokens,
          active: m.active,
          closed: m.closed,
          volume: parseFloat(m.volume || 0),
          negRisk: m.negRisk || false,
          endDate: m.endDate || null,
          description: m.description || '',
          volume24hr: parseFloat(m.volume24hr || 0)
        });
      }
    }

    console.log(`[LIVE-MARKETS] Fetched ${markets.length} live markets from ${events.length} events`);
    return markets;
  } catch (e) {
    console.error('[LIVE-MARKETS] Error:', e.message);
    return [];
  }
}

function analyzeSentiment(news) {
  if (!news || news.length === 0) return { sentiment: 'neutral', score: 0, confidence: 0.5 };

  const text = news.map(n => (n.snippet || n.title || '').toLowerCase()).join(' ');

  const positiveWords = ['will pass', 'will win', 'approved', 'bullish', 'up', 'positive', 'growth', 'gain', 'higher', 'yes', 'increase', 'more likely', 'expected', 'confirmed', 'deal done', 'succeed', 'yes', 'green', 'rally', 'surge', 'breakout'];
  const negativeWords = ['will fail', 'will lose', 'rejected', 'bearish', 'down', 'negative', 'decline', 'loss', 'lower', 'no', 'unlikely', 'blocked', 'collapse', 'drop', 'decrease', 'red', 'selloff', 'crash', 'breakdown'];

  let posCount = 0, negCount = 0;
  for (const w of positiveWords) if (text.includes(w)) posCount++;
  for (const w of negativeWords) if (text.includes(w)) negCount++;

  const diff = posCount - negCount;
  if (diff > 0) {
    return { sentiment: 'positive', score: diff, confidence: Math.min(0.5 + diff * 0.12, 0.85) };
  } else if (diff < 0) {
    return { sentiment: 'negative', score: -diff, confidence: Math.min(0.5 + -diff * 0.12, 0.85) };
  }
  return { sentiment: 'neutral', score: 0, confidence: 0.5 };
}

function checkPatterns(title, outcomes) {
  const patterns = getWinningPatterns();
  let bonus = 0;
  let matchedPattern = null;
  let predictedOutcome = null;

  for (const p of patterns) {
    if (p.sample_count >= 2 && p.success_rate > 0.5) {
      const keywords = p.pattern.toLowerCase().split(' ').filter(w => w.length > 2);
      const matchCount = keywords.filter(w => title.toLowerCase().includes(w)).length;
      if (matchCount >= Math.min(2, keywords.length)) {
        bonus = (p.success_rate - 0.5) * 0.4;
        matchedPattern = p.pattern;
        predictedOutcome = p.outcome;
        break;
      }
    }
  }

  return { bonus, matchedPattern, predictedOutcome };
}

async function getTradingBalance() {
  try {
    const res = await fetch(`${TRADING_SERVER}/api/clob-balance`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`clob-balance returned ${res.status}`);
    const data = await res.json();
    const bal = parseFloat(data.usdc_bridged || data.USDC || data.balance || 0);
    if (bal > 0) {
      bankroll = bal;
      return { usdc_bridged: bal, usdc: bal };
    }
    // Fallback to on-chain balance endpoint
    const res2 = await fetch(`${TRADING_SERVER}/api/balance`, { signal: AbortSignal.timeout(5000) });
    const data2 = await res2.json();
    const bal2 = parseFloat(data2.usdc_bridged || data2.usdc || 0);
    bankroll = bal2;
    return { usdc_bridged: bal2, usdc: data2.usdc || 0 };
  } catch (e) {
    console.error('[BALANCE] Failed to fetch, using cached bankroll:', bankroll, e.message);
    return { usdc_bridged: bankroll, usdc: bankroll };
  }
}

async function getPositions() {
  try {
    const res = await fetch(`${TRADING_SERVER}/api/positions`);
    if (!res.ok) throw new Error(`positions API returned ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error('positions API returned non-array');
    return data;
  } catch (e) {
    console.error('[POSITIONS] Failed to fetch:', e.message);
    return [];
  }
}

async function getOrders() {
  try {
    const res = await fetch(`${TRADING_SERVER}/api/orders`);
    if (!res.ok) throw new Error(`orders API returned ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error('orders API returned non-array');
    return data;
  } catch (e) {
    console.error('[ORDERS] Failed to fetch:', e.message);
    return [];
  }
}

function calculateBetSize(confidence, price, balance) {
  // Use proper Kelly criterion for binary prediction markets
  const size = kellyBetSize(confidence, price, balance);
  if (size <= 0) return 0; // No edge, don't bet
  // Polymarket minimum is $1; only bet if Kelly says >= $1
  return size >= 1.0 ? size : 0;
}

async function executeTrade(tokenId, amount, side, price, negRisk = false, conditionId = null, outcome = null) {
  try {
    if (process.env.PAPER_TRADING === 'true') {
      // Simulate trade for paper trading
      const result = { orderID: 'paper-' + Date.now(), success: true };
      executedTrades.push({ tokenId, side, amount, price, result, timestamp: Date.now(), conditionId, outcome });
      console.log(`[PAPER TRADE] ${side} ${amount} @ ${price}`);
      return result;
    }

    const endpoint = side === 'BUY' ? '/api/market-buy' : '/api/market-sell';
    const res = await fetch(`${TRADING_SERVER}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tokenId,
        amount,
        tickSize: '0.01',
        negRisk
      })
    });
    const result = await res.json();
    executedTrades.push({ tokenId, side, amount, price, result, timestamp: Date.now(), conditionId, outcome });
    return result;
  } catch (e) {
    return { error: e.message };
  }
}

async function cancelOrder(orderId) {
  try {
    await fetch(`${TRADING_SERVER}/api/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId })
    });
  } catch {}
}

async function cancelAllOrders() {
  try {
    await fetch(`${TRADING_SERVER}/api/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
  } catch {}
}

async function resolvePosition(conditionId, price) {
  const positions = await getPositions();
  for (const pos of positions) {
    if (pos.conditionId === conditionId) {
      const currentValue = parseFloat(pos.currentValue || pos.current_value || 0);
      if (currentValue > 0) {
        const pnl = currentValue - parseFloat(pos.initialValue || pos.initial_value || 0);
        sessionProfit += pnl;

        memory.resolveBet(conditionId, price, price > 0.5 ? 'YES' : 'NO', pnl);
      }
    }
  }
}

function timeToEnd(endDate) {
  if (!endDate) return Infinity;
  const end = new Date(endDate).getTime();
  const now = Date.now();
  return end - now;
}

function shouldClosePosition(position, currentPrice) {
  const entryPrice = parseFloat(position.avgPrice || position.avg_price || 0);
  const size = parseFloat(position.size || 0);
  if (size <= 0) return false;
  if (entryPrice <= 0) return false; // can't compute PnL% without entry price

  const pnl = (currentPrice - entryPrice) * size;
  const pnlPercent = pnl / (entryPrice * size);

  if (pnlPercent > 0.5) return true;
  if (pnlPercent < -0.3) return true;
  if (timeToEnd(position.endDate) < 3600000) return true;

  return false;
}

async function managePositions(prices) {
  const positions = await getPositions();
  const orders = await getOrders();

  const closeable = positions.filter(p => {
    const price = prices.get(p.asset);
    return price && shouldClosePosition(p, price);
  });

  for (const pos of closeable) {
    const price = prices.get(pos.asset);
    console.log(`[MANAGE] Close ${pos.title} @ $${price} (pnl: ${((price - pos.avg_price) * pos.size).toFixed(2)})`);

    await executeTrade(pos.asset, pos.size, 'SELL', price, !!pos.negativeRisk);
  }

  const oldOrders = orders.filter(o => {
    const age = Date.now() - (parseFloat(o.created_at) * 1000);
    return age > 600000;
  });

  for (const order of oldOrders) {
    await cancelOrder(order.id);
  }
}

async function runCycle() {
  if (cycleRunning) {
    console.log('[AGENT] Cycle already in progress, skipping');
    return;
  }
  cycleRunning = true;
  try {
  cycleCount++;

  const balance = await getTradingBalance();
  const freeBalance = balance.usdc_bridged || balance.usdc || 0;

  if (initialBankroll === 0) {
    initialBankroll = freeBalance;
    peakBankroll = freeBalance;
  }

  if (freeBalance > peakBankroll) {
    peakBankroll = freeBalance;
  }

  // Graduated drawdown protection from peak (not from initial)
  const drawdownFromPeak = peakBankroll > 0 ? (peakBankroll - freeBalance) / peakBankroll : 0;
  let drawdownMode = 'normal';
  if (drawdownFromPeak >= 0.30) {
    drawdownMode = 'emergency'; // Close all positions, halt trading
    console.log(`[RISK] EMERGENCY: ${(drawdownFromPeak*100).toFixed(1)}% drawdown from peak, closing all positions`);
    await managePositions(lastPrices); // close everything
    return; // halt cycle
  } else if (drawdownFromPeak >= 0.20) {
    drawdownMode = 'halt'; // No new trades, keep existing positions
    console.log(`[RISK] HALT: ${(drawdownFromPeak*100).toFixed(1)}% drawdown from peak, no new trades`);
    await managePositions(lastPrices);
    return; // skip new trades this cycle
  } else if (drawdownFromPeak >= 0.10) {
    drawdownMode = 'reduce'; // Reduce bet sizes to 50%
    console.log(`[RISK] REDUCE: ${(drawdownFromPeak*100).toFixed(1)}% drawdown from peak, halving bet sizes`);
  }

  await managePositions(lastPrices);

  console.log(`\n[CYCLE ${cycleCount}] Balance: $${freeBalance.toFixed(2)} | Leverage: ${leverage}x | Target: $${TARGET_PROFIT.toLocaleString()}`);
  console.log(`[PROGRESS] $${freeBalance.toFixed(2)} / $${TARGET_PROFIT.toLocaleString()} (${((freeBalance/TARGET_PROFIT)*100).toFixed(6)}%)`);

  const opportunities = [];
  const allMarkets = []; // collected for theta + arb scanning
  const seenConditionIds = new Set();

  // Primary: fetch high-volume live markets by event (fast, deduplicated)
  const liveMarkets = await fetchLiveMarkets(50);
  for (const market of liveMarkets) {
    allMarkets.push(market);
    seenConditionIds.add(market.conditionId);
  }

  // Supplemental: keyword search for niche topics not in top-50 events
  for (const query of SEARCH_QUERIES) {
    const markets = await searchMarkets(query);

    for (const market of markets) {
      if (seenConditionIds.has(market.conditionId)) continue;
      allMarkets.push(market);
      seenConditionIds.add(market.conditionId);
    }
  }

  // Process all collected markets
  for (const market of allMarkets) {

      if (market.volume < 100) continue;

      for (const token of market.tokens) {
        const price = token.price;

        if (price < 0.05 || price > 0.95) continue;

        const timeLeft = timeToEnd(market.endDate);
        if (timeLeft < 0) continue;
        if (timeLeft < 3600000 && price < 0.15) continue;

        const news = await fetchMarketNews(market.conditionId, market.question);
        const sentiment = analyzeSentiment(news);

        if (sentiment.sentiment === 'neutral') continue;

        const patternCheck = checkPatterns(market.question, market.tokens);

        // Turnover boost: prefer markets resolving sooner for faster capital recycling
        const daysToExpiry = market.endDate ? (new Date(market.endDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24) : Infinity;
        let turnoverBoost = 0;
        if (daysToExpiry <= 3)       turnoverBoost = 0.08;
        else if (daysToExpiry <= 7)  turnoverBoost = 0.05;
        else if (daysToExpiry <= 14) turnoverBoost = 0.02;
        else if (daysToExpiry > 30)  turnoverBoost = -0.03;

        const confidence = Math.min(sentiment.confidence + patternCheck.bonus + turnoverBoost, 0.92);

        if (confidence < CONFIDENCE_THRESHOLD) continue;

        const side = sentiment.sentiment === 'positive' ? 'BUY' : 'SELL';
        let size = calculateBetSize(confidence, price, freeBalance);
        // Apply drawdown reduction: halve bet sizes in reduce mode
        if (drawdownMode === 'reduce') size = size * 0.5;

        if (size < MIN_PROFIT_TRADE) continue;

        opportunities.push({
          market,
          token,
          side,
          confidence,
          size,
          sentiment: sentiment.sentiment,
          reason: `${sentiment.sentiment} from ${news.length} sources`,
          negRisk: market.negRisk
        });

        lastPrices.set(token.tokenId, price);
      }

      if (opportunities.length >= MAX_TRADES_PER_CYCLE * 2) break;

    if (opportunities.length >= MAX_TRADES_PER_CYCLE * 2) break;
  }

  // ── Theta scan: run on all discovered markets ──
  // Convert processed markets back to format theta expects (outcomePrices as string)
  const thetaMarkets = allMarkets.map(m => ({
    ...m,
    outcomePrices: m.tokens.map(t => t.price).join(','),
    price: m.tokens[0]?.price || 0,
    category: m.description || ''
  }));

  const thetaOpps = scanThetaOpportunities(thetaMarkets);

  for (const theta of thetaOpps) {
    let confidence;
    switch (theta.type) {
      case 'fade-overconfidence':
        confidence = 0.70; // historically proven edge
        break;
      case 'theta-mispricing':
        // Confidence proportional to edge size: 5% edge -> ~0.60, 15% edge -> ~0.80
        confidence = Math.min(0.50 + parseFloat(theta.edge) * 0.02, 0.85);
        break;
      case 'near-expiry-no-farm':
        confidence = 0.60;
        break;
      default:
        confidence = 0.55;
    }

    // Derive side from theta direction
    const side = theta.direction.includes('SELL') ? 'SELL' : 'BUY';
    // Find matching token from collected markets
    const matchedMarket = allMarkets.find(m => m.conditionId === theta.conditionId);
    if (!matchedMarket || !matchedMarket.tokens || matchedMarket.tokens.length === 0) continue;
    const token = matchedMarket.tokens[0];

    const thetaPrice = parseFloat(theta.price) || token.price;
    let size = calculateBetSize(confidence, thetaPrice, freeBalance);
    if (drawdownMode === 'reduce') size = size * 0.5;
    if (size < MIN_PROFIT_TRADE) continue;

    opportunities.push({
      market: matchedMarket,
      token,
      side,
      confidence,
      size,
      sentiment: 'theta',
      reason: `[THETA] ${theta.type}: ${theta.reasoning}`,
      negRisk: matchedMarket.negRisk
    });

    lastPrices.set(token.tokenId, thetaPrice);
  }

  if (thetaOpps.length > 0) {
    console.log(`[THETA] ${thetaOpps.length} theta opportunities found`);
  }

  // ── Arb scanner: run every 5th cycle (~75s) ──
  if (cycleCount % 5 === 0) {
    try {
      console.log(`[ARB] Running arbitrage scan (cycle ${cycleCount})...`);

      // Convert processed markets back to raw-ish format for arb scanner
      const arbMarkets = allMarkets.map(m => ({
        question: m.question,
        conditionId: m.conditionId,
        closed: m.closed,
        outcomePrices: m.tokens.map(t => t.price).join(','),
        price: m.tokens[0]?.price || 0,
        volume: m.volume
      }));

      const crossArbs = await scanArbitrage(arbMarkets);
      const sumToOneArbs = await scanSumToOneArb(arbMarkets);
      const allArbs = [...crossArbs, ...sumToOneArbs];

      const highConfidenceArbs = allArbs.filter(arb => {
        const netSpreadPct = parseFloat(arb.netSpread);
        return netSpreadPct >= 3; // >3% net spread threshold
      });

      for (const arb of highConfidenceArbs) {
        console.log(`[ARB] PRIORITY: ${(arb.type || 'cross-platform')} arb - net spread ${arb.netSpread} on "${arb.polymarket?.title || arb.title}"`);

        // Find matching market from collected data
        const arbConditionId = arb.polymarket?.conditionId || arb.conditionId;
        const arbMarket = allMarkets.find(m => m.conditionId === arbConditionId);

        if (arbMarket && arbMarket.tokens && arbMarket.tokens.length > 0) {
          // Execute arb with priority - buy both sides for sum-to-one, or the cheaper side for cross-platform
          for (const token of arbMarket.tokens) {
            const arbSize = Math.min(freeBalance * 0.05, 50); // conservative: 5% of balance, max $50
            const result = await executeTrade(
              token.tokenId,
              arbSize,
              'BUY',
              token.price,
              arbMarket.negRisk,
              arbMarket.conditionId,
              token.outcome
            );

            if (result.orderID || result.tx || result.success) {
              recordBet({
                conditionId: arbMarket.conditionId,
                tokenId: token.tokenId,
                title: arbMarket.question,
                outcome: token.outcome,
                side: 'BUY',
                entryPrice: token.price,
                size: arbSize,
                newsSnippet: `[ARB] ${(arb.type || 'cross-platform')} net spread ${arb.netSpread}`,
                decisionReason: `Arbitrage: ${(arb.type || 'cross-platform')} net spread ${arb.netSpread}`,
                confidence: 0.95,
                paperMode: process.env.PAPER_TRADING === 'true'
              });
              console.log(`[ARB] EXECUTED: BUY $${arbSize} ${token.outcome} @ $${token.price}`);
            }
          }
        }
      }

      if (allArbs.length > 0) {
        console.log(`[ARB] ${allArbs.length} arbs found, ${highConfidenceArbs.length} with >3% net spread`);
      }
    } catch (e) {
      console.error(`[ARB] Scan error: ${e.message}`);
    }
  }

  if (opportunities.length === 0) {
    console.log(`[CYCLE ${cycleCount}] No opportunities`);
    return;
  }

  opportunities.sort((a, b) => b.confidence - a.confidence);
  const selected = opportunities.slice(0, MAX_TRADES_PER_CYCLE);

  console.log(`[CYCLE ${cycleCount}] ${selected.length} opportunities, Balance: $${freeBalance.toFixed(2)}`);

  let executed = 0;
  let totalSize = 0;

  for (const opp of selected) {
    if (totalSize >= freeBalance * 0.8) break;

    const result = await executeTrade(
      opp.token.tokenId,
      opp.size,
      opp.side,
      opp.token.price,
      opp.negRisk,
      opp.market.conditionId,
      opp.token.outcome
    );

    if (result.orderID || result.tx || result.success) {
      recordBet({
        conditionId: opp.market.conditionId,
        tokenId: opp.token.tokenId,
        title: opp.market.question,
        outcome: opp.token.outcome,
        side: opp.side,
        entryPrice: opp.token.price,
        size: opp.size,
        newsSnippet: opp.reason,
        decisionReason: opp.reason,
        confidence: opp.confidence,
        paperMode: process.env.PAPER_TRADING === 'true'
      });

      executed++;
      totalSize += opp.size;
      totalWagered += opp.size;
      console.log(`[FILLED] ${opp.side} $${opp.size} ${opp.token.outcome.slice(0,30)} @ $${opp.token.price}`);
    } else {
      console.log(`[FAILED] ${result.error || 'unknown'}`);
    }

    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`[CYCLE ${cycleCount}] Executed ${executed} trades, Total: $${totalSize.toFixed(2)}`);
  console.log(`[SESSION] Profit: $${sessionProfit.toFixed(2)} | Wagered: $${totalWagered.toFixed(2)}`);

  lastUpdate = Date.now();
  } finally {
    cycleRunning = false;
  }
}

function getAgentStatus() {
  const progress = bankroll > 0 ? (bankroll / TARGET_PROFIT) * 100 : 0;
  return {
    running: isRunning,
    cycleCount,
    sessionProfit: sessionProfit.toFixed(2),
    totalWagered: totalWagered.toFixed(2),
    bankroll: bankroll.toFixed(2),
    initialBankroll: initialBankroll.toFixed(2),
    peakBankroll: peakBankroll.toFixed(2),
    leverage,
    target: TARGET_PROFIT,
    progress: progress.toFixed(8) + '%',
    opportunities: {
      total: executedTrades.length,
      recent: executedTrades.slice(-10)
    }
  };
}

let intervalId = null;
let cycleRunning = false;

async function startAgent() {
  if (isRunning) return;
  isRunning = true;
  console.log(`[AGENT] Starting autonomous agent... Target: $${TARGET_PROFIT.toLocaleString()}`);

  await getTradingBalance();
  await runCycle();

  intervalId = setInterval(async () => {
    // Prevent overlapping cycles: if previous cycle is still running, skip this tick
    if (cycleRunning) {
      console.log('[AGENT] Previous cycle still running, skipping this tick');
      return;
    }
    await runCycle();
  }, CYCLE_MS);
}

function stopAgent() {
  isRunning = false;
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  console.log('[AGENT] Stopped');
}

async function checkResolved() {
  try {
    const res = await fetch(`https://gamma-api.polymarket.com/markets?closed=true&limit=100`);
    const markets = await res.json();

    for (const m of markets) {
      if (!m.resolved) continue;

      const winner = m.winner || '';
      const volume = parseFloat(m.volume || 0);

      try {
        recordMarketResolved(m.conditionId, m.question, winner, volume);

        const marketPositions = executedTrades.filter(t =>
          t.conditionId === m.conditionId
        );

        for (const pos of marketPositions) {
          const resolvedPrice = winner === pos.outcome ? 1 : 0;
          const pnl = pos.side === 'BUY'
            ? (resolvedPrice - pos.price) * pos.amount
            : (pos.price - resolvedPrice) * pos.amount;

          resolveBet(m.conditionId, resolvedPrice, winner, pnl);

          const pattern = m.question.split(' ').slice(0, 3).join(' ');
          if (pattern && pnl !== 0) {
            updatePattern(pattern, winner, pnl);
          }
        }
      } catch {}
    }
  } catch (e) {
    console.error('[RESOLVE] Error:', e.message);
  }
}

setInterval(checkResolved, 120000);

module.exports = { startAgent, stopAgent, getAgentStatus, searchMarkets, fetchLiveMarkets };

if (require.main === module) {
  (async () => {
    console.log('[AGENT] Starting $100M autonomous agent...');
    await startAgent();

    process.on('SIGINT', () => {
      stopAgent();
      console.log(`\n[SESSION] Final Profit: $${sessionProfit.toFixed(2)}`);
      console.log(`[SESSION] Total Wagered: $${totalWagered.toFixed(2)}`);
      console.log(`[SESSION] Final Bankroll: $${bankroll.toFixed(2)}`);
      process.exit(0);
    });
  })();
}