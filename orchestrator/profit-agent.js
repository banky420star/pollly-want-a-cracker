require('dotenv').config();

const { fetchRelevantNews } = require('./news-fetcher');
const { kellyBetSize, kellyFraction, MAX_BET_PCT } = require('./kelly');
const { 
  recordBet, 
  resolveBet, 
  getBetHistory, 
  getPerformanceStats, 
  getWinningPatterns,
  updatePattern,
  recordTraderPerformance,
  getTopTraders,
  recordMarketResolved,
  getResolvedMarkets
} = require('./memory');

const CONFIDENCE_THRESHOLD = 0.55;
const MIN_PATTERN_MATCHES = 3;

class ProfitOrchestrator {
  constructor(options = {}) {
    this.minConfidence = options.minConfidence || CONFIDENCE_THRESHOLD;
    this.maxBet = options.maxBet || 5;
    this.minBet = options.minBet || 1;
    this.riskRewardRatio = options.riskRewardRatio || 2;
  }

  async analyzeMarket(market, news) {
    const analysis = {
      market,
      news: news.slice(0, 3),
      sentiment: 'neutral',
      confidence: 0.5,
      recommendation: 'skip',
      reason: '',
      supportingNews: [],
      opposingNews: []
    };

    const newsText = news.map(n => n.snippet || n.title || '').join(' ').toLowerCase();

    const positiveIndicators = [
      'will pass', 'will win', 'will succeed', 'approved', 'bullish', 'up',
      'confirmed', 'positive', 'growth', 'increase', 'gain', 'higher',
      'yes', 'more likely', 'expected to', 'will happen', 'deal done'
    ];
    
    const negativeIndicators = [
      'will fail', 'will lose', 'rejected', 'bearish', 'down',
      'negative', 'decline', 'decrease', 'lower', 'unlikely',
      'no', 'less likely', 'won\'t happen', 'blocked', 'collapse'
    ];

    let positiveScore = 0;
    let negativeScore = 0;

    for (const indicator of positiveIndicators) {
      if (newsText.includes(indicator)) positiveScore++;
    }
    for (const indicator of negativeIndicators) {
      if (newsText.includes(indicator)) negativeScore++;
    }

    if (positiveScore > negativeScore) {
      analysis.sentiment = 'positive';
      analysis.confidence = Math.min(0.5 + (positiveScore - negativeScore) * 0.1, 0.9);
      analysis.supportingNews = news.slice(0, 2);
    } else if (negativeScore > positiveScore) {
      analysis.sentiment = 'negative';
      analysis.confidence = Math.min(0.5 + (negativeScore - positiveScore) * 0.1, 0.9);
      analysis.opposingNews = news.slice(0, 2);
    }

    return analysis;
  }

  async makeDecision(market, news = []) {
    const analysis = await this.analyzeMarket(market, news);

    if (analysis.confidence < this.minConfidence) {
      return {
        action: 'skip',
        confidence: analysis.confidence,
        reason: `Confidence ${(analysis.confidence * 100).toFixed(0)}% below threshold ${(this.minConfidence * 100).toFixed(0)}%`
      };
    }

    const side = analysis.sentiment === 'positive' ? 'YES' : analysis.sentiment === 'negative' ? 'NO' : 'skip';
    if (side === 'skip') {
      return {
        action: 'skip',
        confidence: analysis.confidence,
        reason: 'Neutral sentiment from news'
      };
    }

    const price = parseFloat(market.price || 0);
    if (price <= this.minConfidence || price >= (1 - this.minConfidence)) {
      return {
        action: 'skip',
        confidence: analysis.confidence,
        reason: `Price ${price.toFixed(2)} outside optimal range`
      };
    }

    const betSize = this.calculateBetSize(analysis.confidence, market.price);
    
    const winningPatterns = getWinningPatterns();
    let patternBonus = 0;
    for (const pattern of winningPatterns) {
      if (market.title && market.title.toLowerCase().includes(pattern.pattern.toLowerCase())) {
        patternBonus = (pattern.success_rate - 0.5) * 0.2;
        break;
      }
    }

    const finalConfidence = Math.min(analysis.confidence + patternBonus, 0.95);
    
    return {
      action: side === 'YES' ? 'BUY' : 'SELL',
      side,
      confidence: finalConfidence,
      size: betSize,
      price: price,
      sentiment: analysis.sentiment,
      reason: `${analysis.sentiment} sentiment (${news.length} news items)${patternBonus > 0 ? ', pattern matched' : ''}`,
      supportingNews: analysis.supportingNews,
      opposingNews: analysis.opposingNews
    };
  }

  calculateBetSize(confidence, price) {
    // Use proper Kelly criterion — bankroll must be provided externally
    const bankroll = this.bankroll || this.maxBet * 20; // fallback
    const size = kellyBetSize(confidence, price, bankroll);
    if (size <= 0) return this.minBet; // minimum bet if edge is marginal
    return Math.max(Math.min(size, this.maxBet), this.minBet);
  }

  async executeBet(market, decision) {
    if (decision.action === 'skip') {
      return { executed: false, reason: decision.reason };
    }

    const bet = {
      conditionId: market.conditionId,
      tokenId: market.tokenId,
      title: market.title,
      outcome: market.outcome,
      side: decision.side,
      entryPrice: decision.price,
      size: decision.size,
      newsSnippet: decision.supportingNews?.[0]?.snippet || '',
      decisionReason: decision.reason,
      confidence: decision.confidence
    };

    const betId = recordBet(bet);
    return {
      executed: true,
      betId,
      bet,
      decision
    };
  }

  resolveBetWithResult(conditionId, resolvedPrice, outcome) {
    const existing = getBetHistory(30).find(b => b.condition_id === conditionId);
    if (!existing) return;

    const result = outcome === 'YES' ? 'win' : 'loss';
    const pnl = result === 'win' 
      ? (resolvedPrice - existing.entry_price) * existing.size
      : -(existing.entry_price) * existing.size;

    resolveBet(conditionId, resolvedPrice, result, pnl);

    const pattern = existing.title?.split(' ').slice(0, 3).join(' ');
    if (pattern) {
      updatePattern(pattern, outcome, pnl);
    }
  }

  getStats() {
    return {
      recent: getPerformanceStats(7),
      monthly: getPerformanceStats(30),
      allTime: getPerformanceStats(365),
      winningPatterns: getWinningPatterns().length,
      topTraders: getTopTraders(7).length
    };
  }
}

async function findProfitableMarkets(query = '', limit = 10) {
  const { searchMarkets } = require('../trading-server');
}

module.exports = { ProfitOrchestrator };

if (require.main === module) {
  const orchestrator = new ProfitOrchestrator({ minConfidence: 0.6 });
  
  const testMarket = {
    conditionId: 'test123',
    tokenId: '0xtest',
    title: 'Will Bitcoin exceed $100k by end of 2025?',
    outcome: 'Yes',
    price: 0.55
  };

  (async () => {
    const news = await fetchRelevantNews('Bitcoin price prediction 2025');
    console.log('News:', news.length, 'items');
    
    const decision = await orchestrator.makeDecision(testMarket, news);
    console.log('Decision:', JSON.stringify(decision, null, 2));
  })();
}