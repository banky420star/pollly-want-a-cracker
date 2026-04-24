require('dotenv').config();

const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'memory.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS bet_outcomes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    condition_id TEXT,
    token_id TEXT,
    title TEXT,
    outcome TEXT,
    side TEXT,
    entry_price REAL,
    size REAL,
    resolved_price REAL,
    pnl REAL,
    result TEXT,
    news_snippet TEXT,
    decision_reason TEXT,
    confidence REAL,
    paper_mode INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    resolved_at TEXT
  );

  CREATE TABLE IF NOT EXISTS market_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    condition_id TEXT UNIQUE,
    title TEXT,
    slug TEXT,
    resolved INTEGER DEFAULT 0,
    winner TEXT,
    volume REAL,
    created_at TEXT DEFAULT (datetime('now')),
    resolved_at TEXT
  );

  CREATE TABLE IF NOT EXISTS learned_patterns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pattern TEXT NOT NULL,
    outcome TEXT NOT NULL,
    success_rate REAL,
    sample_count INTEGER,
    avg_pnl REAL,
    last_updated TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS trader_performance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_address TEXT,
    target_name TEXT,
    total_trades INTEGER,
    win_rate REAL,
    avg_pnl REAL,
    recent_pnl REAL,
    last_trade_ts TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_bet_outcomes_condition ON bet_outcomes(condition_id);
  CREATE INDEX IF NOT EXISTS idx_bet_outcomes_result ON bet_outcomes(result);
  CREATE INDEX IF NOT EXISTS idx_market_history_resolved ON market_history(resolved);
`);

function recordBet(bet) {
  return db.prepare(`
    INSERT INTO bet_outcomes
    (condition_id, token_id, title, outcome, side, entry_price, size, news_snippet, decision_reason, confidence, paper_mode)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    bet.conditionId,
    bet.tokenId,
    bet.title,
    bet.outcome,
    bet.side,
    bet.entryPrice,
    bet.size,
    bet.newsSnippet || '',
    bet.decisionReason || '',
    bet.confidence || 0.5,
    bet.paperMode ? 1 : 0
  );
}

function resolveBet(conditionId, resolvedPrice, result, pnl) {
  db.prepare(`
    UPDATE bet_outcomes 
    SET resolved_price = ?, result = ?, pnl = ?, resolved_at = datetime('now')
    WHERE condition_id = ? AND resolved_at IS NULL
  `).run(resolvedPrice, result, pnl, conditionId);
}

function recordMarketResolved(conditionId, title, winner, volume) {
  db.prepare(`
    INSERT OR REPLACE INTO market_history (condition_id, title, resolved, winner, volume, resolved_at)
    VALUES (?, ?, 1, ?, ?, datetime('now'))
  `).run(conditionId, title, winner, volume);
}

function getBetHistory(days = 30) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  return db.prepare(`
    SELECT * FROM bet_outcomes 
    WHERE created_at > ? 
    ORDER BY created_at DESC
  `).all(since);
}

function getPerformanceStats(days = 30) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const stats = db.prepare(`
    SELECT 
      COUNT(*) as total_bets,
      SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN pnl <= 0 THEN 1 ELSE 0 END) as losses,
      AVG(pnl) as avg_pnl,
      SUM(pnl) as total_pnl,
      AVG(confidence) as avg_confidence
    FROM bet_outcomes
    WHERE created_at > ? AND resolved_at IS NOT NULL AND paper_mode = 0
  `).get(since);

  return {
    ...stats,
    winRate: stats.total_bets > 0 ? (stats.wins / stats.total_bets * 100).toFixed(1) + '%' : '0%'
  };
}

function getResolvedMarkets(days = 7) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  return db.prepare(`
    SELECT * FROM market_history 
    WHERE resolved = 1 AND resolved_at > ?
    ORDER BY resolved_at DESC
  `).all(since);
}

function updatePattern(pattern, outcome, pnl) {
  const existing = db.prepare(`
    SELECT * FROM learned_patterns WHERE pattern = ? AND outcome = ?
  `).get(pattern, outcome);

  if (existing) {
    const newCount = existing.sample_count + 1;
    const newSuccessRate = ((existing.success_rate * existing.sample_count) + (pnl > 0 ? 1 : 0)) / newCount;
    const newAvgPnl = ((existing.avg_pnl * existing.sample_count) + pnl) / newCount;
    db.prepare(`
      UPDATE learned_patterns 
      SET success_rate = ?, sample_count = ?, avg_pnl = ?, last_updated = datetime('now')
      WHERE id = ?
    `).run(newSuccessRate, newCount, newAvgPnl, existing.id);
  } else {
    db.prepare(`
      INSERT INTO learned_patterns (pattern, outcome, success_rate, sample_count, avg_pnl)
      VALUES (?, ?, ?, 1, ?)
    `).run(pattern, outcome, pnl > 0 ? 1 : 0, pnl);
  }
}

function getWinningPatterns() {
  return db.prepare(`
    SELECT * FROM learned_patterns
    WHERE sample_count >= 20 AND success_rate > 0.55 AND avg_pnl > 0
    ORDER BY success_rate DESC, sample_count DESC
    LIMIT 20
  `).all();
}

function recordTraderPerformance(targetAddress, targetName, totalTrades, winRate, avgPnl, recentPnl) {
  db.prepare(`
    INSERT OR REPLACE INTO trader_performance
    (target_address, target_name, total_trades, win_rate, avg_pnl, recent_pnl, last_trade_ts)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(targetAddress, targetName, totalTrades, winRate, avgPnl, recentPnl);
}

function getTopTraders(days = 7) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  return db.prepare(`
    SELECT * FROM trader_performance 
    WHERE last_trade_ts > ?
    ORDER BY recent_pnl DESC
    LIMIT 10
  `).all(since);
}

module.exports = {
  db,
  recordBet,
  resolveBet,
  recordMarketResolved,
  getBetHistory,
  getPerformanceStats,
  getResolvedMarkets,
  updatePattern,
  getWinningPatterns,
  recordTraderPerformance,
  getTopTraders
};