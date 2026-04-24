require('dotenv').config();

const express = require('express');
const { ProfitOrchestrator } = require('./profit-agent');
const { fetchMarketNews } = require('./news-fetcher');
const { getPerformanceStats, getBetHistory, getWinningPatterns } = require('./memory');
const { MarketMaker, MIN_MM_BANKROLL } = require('./market-maker');

const app = express();
app.use(express.json());

let orchestrator = null;
let tradingServerUrl = null;
let agentModule = null;
let marketMaker = null;
let mmActiveMarkets = new Set(); // track which markets MM is quoting

async function searchMarkets(query) {
  const res = await fetch(`https://gamma-api.polymarket.com/markets?closed=false&limit=10&title_contains=${encodeURIComponent(query)}`);
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
      })),
      active: m.active,
      closed: m.closed,
      volume: parseFloat(m.volume || 0)
    };
  }).filter(m => m.tokens.length > 0 && !m.closed);
}

app.get('/api/orchestrator/status', (req, res) => {
  res.json({
    running: !!orchestrator,
    stats: orchestrator?.getStats() || null
  });
});

app.post('/api/orchestrator/configure', (req, res) => {
  const { minConfidence, maxBet, minBet, serverUrl } = req.body;
  
  orchestrator = new ProfitOrchestrator({
    minConfidence: minConfidence || 0.55,
    maxBet: maxBet || 5,
    minBet: minBet || 1
  });

  tradingServerUrl = serverUrl || 'http://127.0.0.1:4002';
  
  res.json({ status: 'configured', minConfidence, maxBet, serverUrl: tradingServerUrl });
});

app.get('/api/orchestrator/analyze', async (req, res) => {
  try {
    const q = req.query.q || 'Bitcoin';
    const markets = await searchMarkets(q);
    const results = [];

    for (const market of markets.slice(0, 5)) {
      for (const token of market.tokens) {
        const news = await fetchMarketNews(market.conditionId, market.question);
        const decision = await orchestrator.makeDecision({
          conditionId: market.conditionId,
          tokenId: token.tokenId,
          title: market.question,
          outcome: token.outcome,
          price: token.price,
          volume: market.volume
        }, news);

        results.push({
          market: market.question,
          token: token.outcome,
          price: token.price,
          volume: market.volume,
          decision: decision.action,
          confidence: decision.confidence,
          reason: decision.reason
        });
      }
    }

    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/orchestrator/opportunity', async (req, res) => {
  try {
    const queries = ['Bitcoin', 'Ethereum', 'Fed', 'Trump', 'AI', 'election'];
    
    for (const query of queries) {
      const markets = await searchMarkets(query);
      
      for (const market of markets) {
        if (market.volume < 1000) continue;
        
        for (const token of market.tokens) {
          if (token.price < 0.2 || token.price > 0.8) continue;
          
          const news = await fetchMarketNews(market.conditionId, market.question);
          if (!news.length) continue;
          
          const decision = await orchestrator.makeDecision({
            conditionId: market.conditionId,
            tokenId: token.tokenId,
            title: market.question,
            outcome: token.outcome,
            price: token.price,
            volume: market.volume
          }, news);

          if (decision.action !== 'skip' && decision.confidence > 0.65) {
            return res.json({
              found: true,
              market: market.question,
              token: token.outcome,
              price: token.price,
              volume: market.volume,
              decision
            });
          }
        }
      }
    }

    res.json({ found: false });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/orchestrator/execute', async (req, res) => {
  try {
    const { conditionId, tokenId, amount, side } = req.body;
    if (!tokenId || !amount) {
      return res.status(400).json({ error: 'tokenId and amount required' });
    }

    const endpoint = side === 'SELL' ? '/api/market-sell' : '/api/market-buy';
    const server = tradingServerUrl || 'http://127.0.0.1:4002';
    const response = await fetch(`${server}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tokenId, amount })
    });

    const result = await response.json();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/orchestrator/stats', (req, res) => {
  try {
    const stats = orchestrator?.getStats() || getPerformanceStats(30);
    res.json(stats);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/orchestrator/history', (req, res) => {
  try {
    const days = parseInt(req.query.days || '30');
    const history = getBetHistory(days);
    res.json(history);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/orchestrator/patterns', (req, res) => {
  try {
    const patterns = getWinningPatterns();
    res.json(patterns);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/orchestrator/target', (req, res) => {
  const { targetProfit, compoundRate, leverage } = req.body;
  
  if (targetProfit) {
    process.env.TARGET_PROFIT = targetProfit;
  }
  if (compoundRate) {
    process.env.COMPOUND_RATE = compoundRate;
  }
  
  res.json({ 
    targetProfit: process.env.TARGET_PROFIT || 100_000_000,
    compoundRate: process.env.COMPOUND_RATE || 1.5,
    leverage: process.env.LEVERAGE || 1
  });
});

app.get('/api/orchestrator/progress', (req, res) => {
  try {
    if (agentModule) {
      res.json(agentModule.getAgentStatus());
    } else {
      res.json({ error: 'Agent not started' });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.ORCHESTRATOR_PORT || 4004;

app.post('/api/orchestrator/agent/start', async (req, res) => {
  try {
    if (!agentModule) {
      agentModule = require('./agent');
    }
    await agentModule.startAgent();
    res.json({ status: 'started' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/orchestrator/agent/stop', (req, res) => {
  try {
    if (agentModule) {
      agentModule.stopAgent();
    }
    res.json({ status: 'stopped' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/orchestrator/agent/status', (req, res) => {
  try {
    if (agentModule) {
      res.json(agentModule.getAgentStatus());
    } else {
      res.json({ running: false });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/orchestrator/agent/opportunities', async (req, res) => {
  try {
    if (!agentModule) {
      return res.json({ error: 'Agent not loaded' });
    }
    
    const queries = ['Bitcoin', 'Ethereum', 'Fed', 'Trump', 'AI', 'election', 'stock market'];
    const opportunities = [];
    
    for (const query of queries) {
      const markets = await agentModule.searchMarkets(query);
      
      for (const market of markets) {
        for (const token of market.tokens) {
          const opp = await agentModule.analyzeOpportunity(market, token);
          if (opp && opp.confidence > 0.55) {
            opportunities.push({
              market: market.question,
              token: token.outcome,
              price: token.price,
              volume: market.volume,
              side: opp.side,
              confidence: opp.confidence,
              size: opp.size,
              reason: opp.reason
            });
          }
        }
      }
    }
    
    opportunities.sort((a, b) => b.confidence - a.confidence);
    res.json(opportunities.slice(0, 10));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  Profit Orchestrator running on port ${PORT}\n  http://localhost:${PORT}\n`);
});

orchestrator = new ProfitOrchestrator({
  minConfidence: parseFloat(process.env.MIN_CONFIDENCE || '0.52'),
  maxBet: parseFloat(process.env.MAX_BET || '50'),
  minBet: parseFloat(process.env.MIN_BET || '0.50')
});

tradingServerUrl = process.env.TRADING_SERVER_URL || 'http://127.0.0.1:4002';
console.log('[ORCHESTRATOR] Configured:', { minConfidence: orchestrator.minConfidence, maxBet: orchestrator.maxBet });

// ── Market Maker activation check ──
// If bankroll >= $10,000, enable market making on top 5 markets by volume.
// Runs every 60 seconds to check balance and adjust quotes.

const MM_CHECK_INTERVAL_MS = 60000;
const MM_TOP_MARKETS = 5;

const MM_SEARCH_QUERIES = ['Bitcoin', 'Ethereum', 'Trump', 'election', 'Fed rate', 'AI', 'crypto', 'stock market'];

async function getMmBankroll() {
  try {
    const res = await fetch(`${tradingServerUrl}/api/clob-balance`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`clob-balance returned ${res.status}`);
    const data = await res.json();
    return parseFloat(data.usdc_bridged || data.USDC || data.balance || 0);
  } catch (e) {
    console.error('[MM] Failed to fetch balance:', e.message);
    return 0;
  }
}

async function fetchTopMarketsByVolume(count) {
  const allMarkets = [];
  for (const query of MM_SEARCH_QUERIES) {
    try {
      const res = await fetch(`https://gamma-api.polymarket.com/markets?closed=false&limit=20&title_contains=${encodeURIComponent(query)}`);
      const markets = await res.json();
      for (const m of markets) {
        const tokenIds = JSON.parse(m.clobTokenIds || '[]');
        const outcomes = JSON.parse(m.outcomes || '[]');
        const prices = JSON.parse(m.outcomePrices || '[]');
        if (tokenIds.length === 0 || m.closed) continue;

        const tokens = tokenIds.map((id, i) => ({
          tokenId: id,
          outcome: outcomes[i],
          price: parseFloat(prices[i] || 0)
        })).filter(t => t.price > 0);

        allMarkets.push({
          conditionId: m.conditionId,
          question: m.question,
          tokens,
          volume: parseFloat(m.volume || 0),
          negRisk: m.negRisk || false
        });
      }
    } catch (e) {
      // skip failed queries
    }
  }

  // Deduplicate by conditionId and sort by volume descending
  const seen = new Set();
  const unique = [];
  for (const m of allMarkets) {
    if (seen.has(m.conditionId)) continue;
    seen.add(m.conditionId);
    unique.push(m);
  }
  unique.sort((a, b) => b.volume - a.volume);
  return unique.slice(0, count);
}

async function checkMarketMakerActivation() {
  const bankroll = await getMmBankroll();

  if (!marketMaker) {
    marketMaker = new MarketMaker(tradingServerUrl);
  }

  if (bankroll >= MIN_MM_BANKROLL) {
    if (!marketMaker.enabled) {
      marketMaker.enabled = true;
      console.log(`[MM] ENABLING market making — bankroll $${bankroll.toFixed(2)} >= $${MIN_MM_BANKROLL}`);
    }

    // Fetch top markets by volume and place quotes
    const topMarkets = await fetchTopMarketsByVolume(MM_TOP_MARKETS);
    const newMarketKeys = new Set(topMarkets.map(m => m.conditionId));

    // Cancel quotes on markets that dropped out of top 5
    for (const existingKey of mmActiveMarkets) {
      if (!newMarketKeys.has(existingKey)) {
        const existingMarket = marketMaker.activeMarkets.has(existingKey);
        if (existingMarket) {
          await marketMaker.cancelQuotes(existingKey);
          console.log(`[MM] Cancelled quotes on dropped market: ${existingKey.slice(0, 10)}...`);
        }
      }
    }

    // Place quotes on top markets
    let quotedCount = 0;
    for (const market of topMarkets) {
      for (const token of market.tokens) {
        if (token.price < 0.10 || token.price > 0.90) continue; // skip near-certain markets

        const result = await marketMaker.quoteMarket(
          token.tokenId,
          token.price,
          0.4, // sigma estimate
          bankroll,
          market.negRisk
        );

        if (result) {
          quotedCount++;
        }
      }
      mmActiveMarkets.add(market.conditionId);
    }

    if (quotedCount > 0) {
      console.log(`[MM] Placed ${quotedCount} quotes across ${topMarkets.length} top markets (bankroll: $${bankroll.toFixed(2)})`);
    }
  } else {
    // Bankroll below threshold — disable if currently active
    if (marketMaker.enabled) {
      console.log(`[MM] DISABLING market making — bankroll $${bankroll.toFixed(2)} < $${MIN_MM_BANKROLL}`);
      // Cancel all active quotes
      for (const key of mmActiveMarkets) {
        await marketMaker.cancelQuotes(key);
      }
      mmActiveMarkets.clear();
      marketMaker.enabled = false;
    }
  }
}

// Start market maker check loop
setInterval(checkMarketMakerActivation, MM_CHECK_INTERVAL_MS);
// Initial check after 10s (give trading server time to start)
setTimeout(checkMarketMakerActivation, 10000);
console.log(`[MM] Market maker check scheduled every ${MM_CHECK_INTERVAL_MS / 1000}s (min bankroll: $${MIN_MM_BANKROLL})`);

// ── Market Maker API endpoints ──

app.get('/api/mm/status', (req, res) => {
  res.json({
    enabled: marketMaker?.enabled || false,
    activeMarkets: mmActiveMarkets.size,
    minBankroll: MIN_MM_BANKROLL,
    activeMarketKeys: Array.from(mmActiveMarkets)
  });
});

app.post('/api/mm/enable', (req, res) => {
  if (!marketMaker) {
    marketMaker = new MarketMaker(tradingServerUrl);
  }
  marketMaker.enabled = true;
  res.json({ status: 'enabled', note: 'Will activate on next check cycle if bankroll sufficient' });
});

app.post('/api/mm/disable', async (req, res) => {
  if (marketMaker) {
    marketMaker.enabled = false;
    // Cancel all active quotes
    for (const key of mmActiveMarkets) {
      await marketMaker.cancelQuotes(key);
    }
    mmActiveMarkets.clear();
  }
  res.json({ status: 'disabled' });
});

if (process.env.ORCHESTRATOR_AUTO_START_AGENT === 'true') {
  (async () => {
    agentModule = require('./agent');
    await agentModule.startAgent();
    console.log('[ORCHESTRATOR] Autonomous agent started');
  })();
}