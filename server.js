const express = require('express');
const path = require('path');
const Database = require('better-sqlite3');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// DATABASE
// ============================================================

const db = new Database(path.join(__dirname, 'data.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS targets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    address TEXT NOT NULL UNIQUE,
    profile_url TEXT,
    added_at TEXT DEFAULT (datetime('now')),
    active INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS strategies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    target_id INTEGER NOT NULL,
    flat_bet REAL DEFAULT 10,
    copy_buys INTEGER DEFAULT 1,
    copy_sells INTEGER DEFAULT 1,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (target_id) REFERENCES targets(id)
  );

  CREATE TABLE IF NOT EXISTS paper_trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    strategy_id INTEGER NOT NULL,
    target_id INTEGER NOT NULL,
    market_slug TEXT,
    condition_id TEXT,
    token_id TEXT,
    title TEXT,
    outcome TEXT,
    side TEXT,
    size REAL,
    price REAL,
    notional REAL,
    target_tx TEXT,
    target_size REAL,
    target_price REAL,
    timestamp TEXT DEFAULT (datetime('now')),
    status TEXT DEFAULT 'open',
    current_price REAL,
    pnl REAL DEFAULT 0,
    FOREIGN KEY (strategy_id) REFERENCES strategies(id),
    FOREIGN KEY (target_id) REFERENCES targets(id)
  );

  CREATE TABLE IF NOT EXISTS pnl_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    strategy_id INTEGER,
    timestamp TEXT DEFAULT (datetime('now')),
    total_pnl REAL,
    open_positions INTEGER,
    total_trades INTEGER
  );

  CREATE TABLE IF NOT EXISTS poll_state (
    target_id INTEGER PRIMARY KEY,
    last_trade_ts TEXT,
    last_poll TEXT
  );
`);

// Add current_price column if missing (migration)
try { db.exec('ALTER TABLE paper_trades ADD COLUMN current_price REAL'); } catch(e) {}

// Live trading tables
db.exec(`
  CREATE TABLE IF NOT EXISTS live_trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    strategy_id INTEGER,
    target_id INTEGER,
    paper_trade_id INTEGER,
    token_id TEXT,
    condition_id TEXT,
    title TEXT,
    outcome TEXT,
    side TEXT,
    amount REAL,
    price REAL,
    status TEXT DEFAULT 'pending',
    order_id TEXT,
    error TEXT,
    timestamp TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (strategy_id) REFERENCES strategies(id)
  );

  CREATE TABLE IF NOT EXISTS live_config (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

db.exec(`
  CREATE TRIGGER IF NOT EXISTS prevent_live_trade_retry
  BEFORE INSERT ON live_trades
  WHEN NEW.paper_trade_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM live_trades WHERE paper_trade_id = NEW.paper_trade_id)
  BEGIN
    SELECT RAISE(IGNORE);
  END;
`);

// Add live columns to strategies
try { db.exec('ALTER TABLE strategies ADD COLUMN live_enabled INTEGER DEFAULT 0'); } catch(e) {}
try { db.exec('ALTER TABLE strategies ADD COLUMN live_bet REAL DEFAULT 0.01'); } catch(e) {}
try { db.exec('ALTER TABLE strategies ADD COLUMN live_budget REAL DEFAULT 0'); } catch(e) {}
try { db.exec('ALTER TABLE strategies ADD COLUMN live_start_capital REAL DEFAULT 0'); } catch(e) {}

// Portfolio value tracking
db.exec(`
  CREATE TABLE IF NOT EXISTS portfolio_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT DEFAULT (datetime('now')),
    cash REAL,
    positions_value REAL,
    total_value REAL,
    start_capital REAL DEFAULT 11
  );
  CREATE TABLE IF NOT EXISTS position_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT DEFAULT (datetime('now')),
    token_id TEXT,
    price REAL,
    size REAL,
    value REAL,
    cost REAL
  );
`);

// ============================================================
// SEED DEFAULT TARGETS & STRATEGIES
// ============================================================

const SEED_TARGETS = [
  { name: '432614799197', address: '0xdc876e6873772d38716fda7f2452a78d426d7ab6', profile_url: 'https://polymarket.com/@432614799197' },
  { name: '0p0jogggg', address: '0x6ac5bb06a9eb05641fd5e82640268b92f3ab4b6e', profile_url: 'https://polymarket.com/@0p0jogggg' },
  { name: 'RN1', address: '0x2005d16a84ceefa912d4e380cd32e7ff827875ea', profile_url: 'https://polymarket.com/@RN1' },
  { name: 'Dishonest-Bloom', address: '0x2a2c53bd278c04da9962fcf96490e17f3dfb9bc1', profile_url: 'https://polymarket.com/@0x2a2C53bD278c04DA9962Fcf96490E17F3DfB9Bc1-1772479215461' },
  { name: 'swisstony', address: '0x204f72f35326db932158cba6adff0b9a1da95e14', profile_url: 'https://polymarket.com/@swisstony' },
  { name: 'Bitcoin Trader', address: '0xde17f7144fbd0eddb2679132c10ff5e74b120988', profile_url: 'https://polymarket.com/@0xdE17f7144fbD0eddb2679132C10ff5e74B120988-1772205225932' },
  { name: 'bobe2', address: '0xed107a85a4585a381e48c7f7ca4144909e7dd2e5', profile_url: 'https://polymarket.com/@bobe2' },
  { name: 'geniusMC', address: '0x0b9cae2b0dfe7a71c413e0604eaac1c352f87e44', profile_url: 'https://polymarket.com/@geniusMC' },
  { name: 'gatorr', address: '0x93abbc022ce98d6f45d4444b594791cc4b7a9723', profile_url: 'https://polymarket.com/@gatorr' },
  { name: 'huhaoli', address: '0xf19d7d88cf362110027dcd64750fdd209a04276f', profile_url: 'https://polymarket.com/@huhaoli' },
];

const insertTarget = db.prepare('INSERT OR IGNORE INTO targets (name, address, profile_url) VALUES (?, ?, ?)');
const insertStrategy = db.prepare('INSERT OR IGNORE INTO strategies (name, target_id, flat_bet) VALUES (?, ?, ?)');

for (const t of SEED_TARGETS) {
  insertTarget.run(t.name, t.address, t.profile_url);
  const target = db.prepare('SELECT id FROM targets WHERE address = ?').get(t.address);
  if (target) {
    const existing = db.prepare('SELECT id FROM strategies WHERE target_id = ?').get(target.id);
    if (!existing) {
      insertStrategy.run(`Copy ${t.name}`, target.id, 10);
    }
  }
}

console.log('[SEED] Targets and strategies ready');

// ============================================================
// LIVE CONFIG DEFAULTS
// ============================================================

const setConfig = db.prepare('INSERT OR REPLACE INTO live_config (key, value) VALUES (?, ?)');
const getConfig = db.prepare('SELECT value FROM live_config WHERE key = ?');

// Set defaults (only if not already set)
if (!getConfig.get('kill_switch')) setConfig.run('kill_switch', '0');
if (!getConfig.get('max_loss')) setConfig.run('max_loss', '0');
if (!getConfig.get('max_trades_per_hour')) setConfig.run('max_trades_per_hour', '1200');
if (getConfig.get('max_loss')?.value === '20') setConfig.run('max_loss', '0');

// Enable live trading for RN1 and geniusMC with separate budgets
const rn1Target = db.prepare("SELECT id FROM targets WHERE name = 'RN1'").get();
if (rn1Target) {
  const rn1Strat = db.prepare("SELECT id FROM strategies WHERE target_id = ?").get(rn1Target.id);
  if (rn1Strat) {
    // Only set budget if not already set (preserve existing budget)
    const current = db.prepare("SELECT live_budget, live_start_capital FROM strategies WHERE id = ?").get(rn1Strat.id);
    if (!current.live_budget || current.live_budget === 0) {
      db.prepare("UPDATE strategies SET live_enabled = 1, live_bet = 0.01, live_budget = 11, live_start_capital = 11 WHERE id = ?").run(rn1Strat.id);
      console.log('[LIVE] RN1: $11 budget assigned');
    } else {
      db.prepare("UPDATE strategies SET live_enabled = 1, live_bet = 0.01 WHERE id = ?").run(rn1Strat.id);
    }
    console.log(`[LIVE] RN1 live trading enabled`);
  }
}

const geniusTarget = db.prepare("SELECT id FROM targets WHERE name = 'geniusMC'").get();
if (geniusTarget) {
  const geniusStrat = db.prepare("SELECT id FROM strategies WHERE target_id = ?").get(geniusTarget.id);
  if (geniusStrat) {
    const current = db.prepare("SELECT live_budget, live_start_capital FROM strategies WHERE id = ?").get(geniusStrat.id);
    if (!current.live_budget || current.live_budget === 0) {
      db.prepare("UPDATE strategies SET live_enabled = 1, live_bet = 0.01, live_budget = 15, live_start_capital = 15 WHERE id = ?").run(geniusStrat.id);
      console.log('[LIVE] geniusMC: $15 budget assigned');
    } else {
      db.prepare("UPDATE strategies SET live_enabled = 1, live_bet = 0.01 WHERE id = ?").run(geniusStrat.id);
    }
    console.log(`[LIVE] geniusMC live trading enabled`);
  }
}

// ============================================================
// POLYMARKET API HELPERS
// ============================================================

const DATA_API = 'https://data-api.polymarket.com';
const CLOB_API = 'https://clob.polymarket.com';
const GAMMA_API = 'https://gamma-api.polymarket.com';

async function pmFetch(url) {
  const res = await fetch(url, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
  });
  if (!res.ok) throw new Error(`PM API ${res.status}: ${url}`);
  return res.json();
}

async function getTargetTrades(address, since) {
  let url = `${DATA_API}/activity?user=${address}&type=TRADE&sortBy=TIMESTAMP&sortDirection=DESC&limit=50`;
  if (since) {
    // since is stored as unix timestamp (seconds)
    const ts = parseInt(since);
    if (!isNaN(ts) && ts > 0) url += `&start=${ts}`;
  }
  return pmFetch(url);
}

async function getTargetPositions(address) {
  return pmFetch(`${DATA_API}/positions?user=${address}&limit=200&sizeThreshold=0.1&sortBy=CURRENT`);
}

async function getMarketPrice(tokenId) {
  try {
    const data = await pmFetch(`${CLOB_API}/price?token_id=${tokenId}&side=buy`);
    return parseFloat(data.price) || 0;
  } catch(e) {
    return 0;
  }
}

// ── Market metadata cache (negRisk + tickSize from CLOB API) ──
const marketMetaCache = {};
async function getMarketMeta(conditionId) {
  if (!conditionId) return { negRisk: false, tickSize: '0.01' };
  if (marketMetaCache[conditionId]) return marketMetaCache[conditionId];
  try {
    // Use CLOB API directly — much more reliable than Gamma
    const res = await fetch(`https://clob.polymarket.com/markets/${conditionId}`);
    if (res.ok) {
      const m = await res.json();
      const meta = {
        negRisk: m.neg_risk || false,
        tickSize: m.minimum_tick_size ? String(m.minimum_tick_size) : '0.01',
        minOrderSize: m.minimum_order_size || 0,
      };
      marketMetaCache[conditionId] = meta;
      console.log(`[META] ${conditionId.slice(0,10)}... negRisk=${meta.negRisk} tick=${meta.tickSize}`);
      return meta;
    }
  } catch(e) {
    console.error('[META] Error fetching market meta:', e.message);
  }
  return { negRisk: false, tickSize: '0.01' };
}

// ============================================================
// LIVE TRADING ENGINE
// ============================================================

const TRADING_SERVER = 'http://127.0.0.1:4001';
const AUTO_COLLECT_PRICE = 0.99;
const AUTO_COLLECT_COOLDOWN_MS = 15000;
const LIVE_STATE_CACHE_MS = 5000;
const MAX_LIVE_TRADE_AGE_SECONDS = 90;
const RETRY_COOLDOWN_MS = 15000;
const STALE_ORDER_MINUTES = 10;
const ORDER_CLEANUP_COOLDOWN_MS = 30000;


let liveStateCache = null;
let liveStateCacheTime = 0;
let tradingBalanceCache = null;
let tradingBalanceCacheTime = 0;
let autoCollectPromise = null;
let lastAutoCollectAt = 0;
let orderCleanupPromise = null;
let lastOrderCleanupAt = 0;
let liveTradeQueue = Promise.resolve();

async function tradingFetchJson(path, init) {
  const res = await fetch(`${TRADING_SERVER}${path}`, init);
  const text = await res.text();
  let body = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }
  }
  if (!res.ok) {
    const msg = body.error || body.errorMsg || body.message || text || `Trading server ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

function parseSqliteTimestamp(ts) {
  if (!ts) return 0;
  const iso = ts.includes('T') ? ts : `${ts.replace(' ', 'T')}Z`;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
}

function getTradeTimestampMs(trade) {
  if (!trade) return 0;
  if (trade.timestamp) {
    const raw = String(trade.timestamp);
    if (/^\d+$/.test(raw)) {
      const seconds = parseInt(raw, 10);
      return Number.isNaN(seconds) ? 0 : seconds * 1000;
    }
    return parseSqliteTimestamp(raw);
  }
  return 0;
}

function isTradeFresh(trade, now = Date.now()) {
  const tradeTime = getTradeTimestampMs(trade);
  if (!tradeTime) return true;
  return (now - tradeTime) <= (MAX_LIVE_TRADE_AGE_SECONDS * 1000);
}

function isRetryableLiveError(error = '') {
  return /not enough balance|allowance|max spend reached|blocked/i.test(error);
}

function toNumber(value, fallback = 0) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

function getPositionSize(position) {
  return toNumber(position.size);
}

function getPositionPrice(position) {
  return toNumber(position.curPrice ?? position.current_price);
}

function getPositionInitialValue(position) {
  return toNumber(position.initialValue ?? position.initial_value);
}

function getPositionCurrentValue(position) {
  return toNumber(position.currentValue ?? position.current_value);
}

function isCollectablePosition(position) {
  return !!position.redeemable || getPositionPrice(position) >= AUTO_COLLECT_PRICE;
}

async function getTradingPositions() {
  const positions = await tradingFetchJson('/api/positions');
  return Array.isArray(positions) ? positions : [];
}

async function getTradingOrders() {
  const orders = await tradingFetchJson('/api/orders');
  return Array.isArray(orders) ? orders : [];
}

async function getTradingBalance(force = false) {
  if (!force && tradingBalanceCache && (Date.now() - tradingBalanceCacheTime) < LIVE_STATE_CACHE_MS) {
    return tradingBalanceCache;
  }
  const balance = await tradingFetchJson('/api/balance');
  tradingBalanceCache = balance || {};
  tradingBalanceCacheTime = Date.now();
  return tradingBalanceCache;
}

async function getLiveState(force = false) {
  if (!force && liveStateCache && (Date.now() - liveStateCacheTime) < LIVE_STATE_CACHE_MS) {
    return liveStateCache;
  }

  const [positions, orders] = await Promise.all([getTradingPositions(), getTradingOrders()]);
  const openBuyNotional = orders
    .filter(o => o.status === 'LIVE' && o.side === 'BUY')
    .reduce((sum, order) => {
      const remaining = Math.max(toNumber(order.original_size) - toNumber(order.size_matched), 0);
      return sum + (remaining * toNumber(order.price));
    }, 0);

  const positionsInitialValue = positions.reduce((sum, position) => sum + getPositionInitialValue(position), 0);
  const positionsCurrentValue = positions.reduce((sum, position) => sum + getPositionCurrentValue(position), 0);
  const collectablePositions = positions.filter(position => getPositionSize(position) > 0 && isCollectablePosition(position));

  liveStateCache = {
    positions,
    orders,
    positionsInitialValue,
    positionsCurrentValue,
    openBuyNotional,
    totalExposure: positionsInitialValue + openBuyNotional,
    collectablePositions,
    collectableCount: collectablePositions.length,
  };
  liveStateCacheTime = Date.now();
  return liveStateCache;
}

function invalidateLiveState() {
  liveStateCache = null;
  liveStateCacheTime = 0;
  tradingBalanceCache = null;
  tradingBalanceCacheTime = 0;
}

async function collectLivePositions(reason = 'manual') {
  const { positions, orders } = await getLiveState(true);
  const liveSellAssets = new Set(
    orders
      .filter(order => order.status === 'LIVE' && order.side === 'SELL')
      .map(order => String(order.asset_id))
  );

  const redeemMap = new Map();
  const sellablePositions = [];
  const results = [];

  for (const position of positions) {
    if (getPositionSize(position) <= 0 || !isCollectablePosition(position)) continue;

    if (position.redeemable) {
      if (!redeemMap.has(position.conditionId)) {
        redeemMap.set(position.conditionId, {
          conditionId: position.conditionId,
          negRisk: !!position.negativeRisk,
          name: `${position.title} | ${position.outcome}`,
        });
      }
      continue;
    }

    if (liveSellAssets.has(String(position.asset))) {
      results.push({
        action: 'sell',
        title: position.title,
        outcome: position.outcome,
        skipped: true,
        reason: 'sell order already open',
      });
      continue;
    }

    sellablePositions.push(position);
  }

  if (redeemMap.size) {
    try {
      const redeemResponse = await tradingFetchJson('/api/redeem-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ positions: Array.from(redeemMap.values()) }),
      });
      for (const item of redeemResponse.results || []) {
        results.push({
          action: 'redeem',
          title: item.name || item.conditionId,
          success: item.status === 'confirmed',
          tx: item.tx,
          error: item.error,
        });
      }
    } catch (e) {
      results.push({ action: 'redeem', error: e.message, reason });
    }
  }

  for (const position of sellablePositions) {
    try {
      const sellResponse = await tradingFetchJson('/api/sell', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tokenId: position.asset,
          price: AUTO_COLLECT_PRICE,
          size: getPositionSize(position),
          negRisk: !!position.negativeRisk,
        }),
      });
      results.push({
        action: 'sell',
        title: position.title,
        outcome: position.outcome,
        success: !!(sellResponse.orderID || sellResponse.tx),
        orderID: sellResponse.orderID,
        tx: sellResponse.tx,
      });
    } catch (e) {
      results.push({
        action: 'sell',
        title: position.title,
        outcome: position.outcome,
        error: e.message,
        status: e.status,
      });
    }
  }

  invalidateLiveState();
  console.log(`[COLLECT] ${reason}: ${results.length} actions`);
  return results;
}

async function maybeAutoCollectPositions(reason = 'auto', force = false) {
  const now = Date.now();
  if (!force && (now - lastAutoCollectAt) < AUTO_COLLECT_COOLDOWN_MS) {
    return { skipped: true, reason: 'cooldown' };
  }
  if (autoCollectPromise) return autoCollectPromise;

  lastAutoCollectAt = now;
  autoCollectPromise = (async () => {
    const state = await getLiveState(true);
    if (!state.collectableCount) {
      return { skipped: true, reason: 'no collectable positions' };
    }
    const results = await collectLivePositions(reason);
    return {
      skipped: false,
      results,
      successCount: results.filter(r => r.success).length,
    };
  })();

  try {
    return await autoCollectPromise;
  } finally {
    autoCollectPromise = null;
  }
}

async function cleanupStaleBuyOrders(reason = 'cleanup', force = false) {
  const now = Date.now();
  if (!force && (now - lastOrderCleanupAt) < ORDER_CLEANUP_COOLDOWN_MS) {
    return { skipped: true, reason: 'cooldown' };
  }
  if (orderCleanupPromise) return orderCleanupPromise;

  lastOrderCleanupAt = now;
  orderCleanupPromise = (async () => {
    const orders = await getTradingOrders();
    const staleOrders = orders.filter(order => {
      if (order.status !== 'LIVE' || order.side !== 'BUY') return false;
      const createdAt = toNumber(order.created_at) * 1000;
      if (!createdAt) return false;
      return (Date.now() - createdAt) >= (STALE_ORDER_MINUTES * 60 * 1000);
    });

    const results = [];
    for (const order of staleOrders) {
      try {
        await tradingFetchJson('/api/cancel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orderId: order.id }),
        });
        results.push({ orderId: order.id, outcome: order.outcome, success: true });
      } catch (e) {
        results.push({ orderId: order.id, outcome: order.outcome, error: e.message });
      }
    }

    if (results.length) {
      invalidateLiveState();
      console.log(`[ORDERS] ${reason}: canceled ${results.filter(r => r.success).length}/${results.length} stale BUY orders`);
    }
    return {
      skipped: results.length === 0,
      results,
    };
  })();

  try {
    return await orderCleanupPromise;
  } finally {
    orderCleanupPromise = null;
  }
}

async function checkSafetyLimits(force = false) {
  // Kill switch
  const killSwitch = getConfig.get('kill_switch');
  if (killSwitch && killSwitch.value === '1') return { ok: false, reason: 'Kill switch active' };

  // Rate limit
  const maxPerHour = parseInt(getConfig.get('max_trades_per_hour')?.value || '1200');
  const hourAgo = new Date(Date.now() - 3600000).toISOString();
  const recentCount = db.prepare("SELECT COUNT(*) as c FROM live_trades WHERE timestamp > ?").get(hourAgo).c;
  if (recentCount >= maxPerHour) return { ok: false, reason: `Rate limit: ${recentCount}/${maxPerHour} trades/hr` };

  const [state, balance] = await Promise.all([getLiveState(force), getTradingBalance(force)]);
  const freeBalance = Math.max(toNumber(balance.usdc_bridged ?? balance.usdc) - state.openBuyNotional, 0);
  const portfolioValue = Math.max(toNumber(balance.usdc_bridged ?? balance.usdc), 0) + state.positionsCurrentValue;
  const configuredCap = parseFloat(getConfig.get('max_loss')?.value || '0');
  const effectiveCap = configuredCap > 0 ? configuredCap : portfolioValue;

  if (configuredCap > 0 && state.totalExposure > effectiveCap) {
    return {
      ok: false,
      reason: `Max spend reached: $${state.totalExposure.toFixed(2)} > $${effectiveCap}`,
      exposure: Math.round(state.totalExposure * 10000) / 10000,
      open_positions_value: Math.round(state.positionsInitialValue * 10000) / 10000,
      open_buy_orders: Math.round(state.openBuyNotional * 10000) / 10000,
      collectable_positions: state.collectableCount,
      free_balance: Math.round(freeBalance * 10000) / 10000,
    };
  }

  return {
    ok: true,
    exposure: Math.round(state.totalExposure * 10000) / 10000,
    open_positions_value: Math.round(state.positionsInitialValue * 10000) / 10000,
    open_buy_orders: Math.round(state.openBuyNotional * 10000) / 10000,
    collectable_positions: state.collectableCount,
    free_balance: Math.round(freeBalance * 10000) / 10000,
    effective_cap: Math.round(effectiveCap * 10000) / 10000,
  };
}

function enqueueLiveTrade(task) {
  const run = liveTradeQueue.then(task, task);
  liveTradeQueue = run.catch(() => {});
  return run;
}

async function executeLiveTrade(strategy, target, trade, paperTradeId) {
  return enqueueLiveTrade(async () => {
  if (!strategy.live_enabled) return;

  const latestAttempt = paperTradeId
    ? db.prepare('SELECT * FROM live_trades WHERE paper_trade_id = ? ORDER BY id DESC LIMIT 1').get(paperTradeId)
    : null;
  if (latestAttempt) return;

  if (!isTradeFresh(trade)) {
    const tradeAgeSeconds = Math.floor((Date.now() - getTradeTimestampMs(trade)) / 1000);
    console.log(`[LIVE] DROP: ${trade.title || 'trade'} is ${tradeAgeSeconds}s old > ${MAX_LIVE_TRADE_AGE_SECONDS}s`);
    return;
  }

  const side = (trade.side || '').toUpperCase();
  const tokenId = trade.asset || '';
  const conditionId = trade.conditionId || '';
  if (!tokenId) {
    console.log('[LIVE] Skip: no token ID');
    return;
  }

  const meta = await getMarketMeta(conditionId);

  // Calculate limit order params from target's trade price
  const targetPrice = parseFloat(trade.price) || 0;
  if (targetPrice <= 0 || targetPrice >= 1) {
    console.log(`[LIVE] Skip: invalid price ${targetPrice}`);
    return;
  }

  // Round price to tick size
  const tick = parseFloat(meta.tickSize) || 0.01;
  const price = Math.round(targetPrice / tick) * tick;
  // Clamp to valid range
  const maxPrice = 1 - tick;
  const clampedPrice = Math.min(Math.max(price, tick), maxPrice);
  const roundedPrice = parseFloat(clampedPrice.toFixed(tick < 0.01 ? 3 : 2));

  let safety = await checkSafetyLimits();
  if (!safety.ok && safety.collectable_positions > 0) {
    await maybeAutoCollectPositions('budget-pressure');
    safety = await checkSafetyLimits(true);
  }
  if (!safety.ok) {
    await cleanupStaleBuyOrders('budget-pressure');
    safety = await checkSafetyLimits(true);
  }

  // Use market orders (FOK) — min $1, no share minimum unlike limit orders (min 5 shares)
  const desiredBudget = Math.max(toNumber(strategy.live_bet), 1.00); // FOK min is $1
  const betAmount = parseFloat(desiredBudget.toFixed(4));

  // Skip if we already have a position on this token
  const existingBuy = db.prepare(
    "SELECT id FROM live_trades WHERE token_id = ? AND status = 'filled' AND side = 'BUY' LIMIT 1"
  ).get(tokenId);
  if (existingBuy) {
    console.log(`[LIVE] SKIP: already have position on ${trade.outcome} | ${trade.title}`);
    return;
  }

  if (!safety.ok) {
    db.prepare(`
      INSERT INTO live_trades (strategy_id, target_id, paper_trade_id, token_id, condition_id, title, outcome, side, amount, price, status, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'blocked', ?)
    `).run(
      strategy.id,
      target.id,
      paperTradeId || 0,
      tokenId,
      conditionId,
      trade.title || '',
      trade.outcome || '',
      side,
      betAmount,
      roundedPrice,
      safety.reason
    );
    console.log(`[LIVE] BLOCKED: ${safety.reason}`);
    return;
  }

  if (betAmount > Math.max(toNumber(safety.free_balance), 0)) {
    console.log(`[LIVE] BLOCKED: insufficient free USDC ($${toNumber(safety.free_balance).toFixed(2)} < $${betAmount.toFixed(2)})`);
    return;
  }

  // Insert pending trade
  const info = db.prepare(`
    INSERT INTO live_trades (strategy_id, target_id, paper_trade_id, token_id, condition_id, title, outcome, side, amount, price, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
  `).run(strategy.id, target.id, paperTradeId || 0, tokenId, conditionId, trade.title || '', trade.outcome || '', side, betAmount, roundedPrice);
  const liveTradeId = info.lastInsertRowid;

  try {
    let resp;
    if (side === 'BUY') {
      const r = await fetch(`${TRADING_SERVER}/api/market-buy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tokenId,
          amount: betAmount,
          tickSize: meta.tickSize,
          negRisk: meta.negRisk,
        }),
      });
      resp = await r.json();
    } else {
      db.prepare("UPDATE live_trades SET status = 'skipped', error = 'Sells not implemented' WHERE id = ?").run(liveTradeId);
      console.log(`[LIVE] SKIP SELL: ${trade.title}`);
      return;
    }

    if (resp.error) {
      db.prepare("UPDATE live_trades SET status = 'error', error = ? WHERE id = ?").run(resp.error, liveTradeId);
      console.log(`[LIVE] ERROR: ${resp.error} | ${trade.title}`);
    } else if (resp.success === false || resp.errorMsg) {
      const errMsg = resp.errorMsg || resp.error_message || JSON.stringify(resp).slice(0, 200);
      db.prepare("UPDATE live_trades SET status = 'error', error = ? WHERE id = ?").run(errMsg, liveTradeId);
      console.log(`[LIVE] REJECTED: ${errMsg} | ${trade.title}`);
    } else {
      const orderId = resp.orderID || resp.order_id || JSON.stringify(resp).slice(0, 200);
      db.prepare("UPDATE live_trades SET status = 'filled', order_id = ? WHERE id = ?").run(orderId, liveTradeId);
      invalidateLiveState();
      const shares = resp.takingAmount ? parseFloat(resp.takingAmount).toFixed(1) : '?';
      console.log(`[LIVE] FILLED: ${side} ${shares} shares for $${betAmount.toFixed(2)} "${trade.outcome}" | ${trade.title}`);
    }
  } catch(e) {
    db.prepare("UPDATE live_trades SET status = 'error', error = ? WHERE id = ?").run(e.message, liveTradeId);
    console.log(`[LIVE] FAILED: ${e.message}`);
  }
  });
}

// ============================================================
// COPY ENGINE
// ============================================================

let pollingInterval = null;
const POLL_SECONDS = 5;

function startPolling() {
  if (pollingInterval) return;
  console.log(`[POLL] Starting — every ${POLL_SECONDS}s`);
  pollingInterval = setInterval(pollAllTargets, POLL_SECONDS * 1000);
  pollAllTargets();
}

function stopPolling() {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
    console.log('[POLL] Stopped');
  }
}

async function pollAllTargets() {
  try {
    await maybeAutoCollectPositions('poll');
    await cleanupStaleBuyOrders('poll');
  } catch (err) {
    console.error(`[LIVE] Maintenance error: ${err.message}`);
  }

  const targets = db.prepare('SELECT * FROM targets WHERE active = 1').all();
  for (const target of targets) {
    try {
      await pollTarget(target);
    } catch (err) {
      console.error(`[POLL] Error for ${target.name}: ${err.message}`);
    }
  }
}

async function pollTarget(target) {
  const state = db.prepare('SELECT * FROM poll_state WHERE target_id = ?').get(target.id);
  const lastTs = state?.last_trade_ts || null;

  const activities = await getTargetTrades(target.address, lastTs);
  if (!activities || !Array.isArray(activities) || activities.length === 0) {
    db.prepare(`INSERT OR REPLACE INTO poll_state (target_id, last_poll) VALUES (?, datetime('now'))`).run(target.id);
    return;
  }

  // Timestamps from PM API are unix seconds (integers)
  const parsedLast = lastTs ? parseInt(lastTs) : 0;

  // Filter new trades only (timestamp is unix seconds int)
  const newTrades = parsedLast > 0
    ? activities.filter(a => parseInt(a.timestamp) > parsedLast)
    : []; // first run: set baseline, don't copy old trades
  const freshTrades = newTrades.filter(trade => isTradeFresh(trade));
  const staleTrades = newTrades.length - freshTrades.length;

  // Always update last seen timestamp to newest
  const newestTs = Math.max(...activities.map(a => parseInt(a.timestamp) || 0));
  db.prepare(`INSERT OR REPLACE INTO poll_state (target_id, last_trade_ts, last_poll) VALUES (?, ?, datetime('now'))`).run(
    target.id, String(newestTs)
  );

  if (newTrades.length > 0) {
    console.log(`[POLL] ${target.name}: ${newTrades.length} new trades found${staleTrades ? `, ${staleTrades} stale` : ''}!`);
  }

  if (freshTrades.length === 0) return;

  const strategies = db.prepare('SELECT * FROM strategies WHERE target_id = ? AND active = 1').all(target.id);

  for (const trade of freshTrades) {
    for (const strat of strategies) {
      await processPaperTrade(strat, target, trade);
    }
  }
}

async function processPaperTrade(strategy, target, trade) {
  const side = (trade.side || '').toUpperCase();
  if (side === 'BUY' && !strategy.copy_buys) return;
  if (side === 'SELL' && !strategy.copy_sells) return;

  const targetSize = parseFloat(trade.size) || 0;
  const targetPrice = parseFloat(trade.price) || 0;
  const targetUsdcSize = parseFloat(trade.usdcSize) || 0;
  if (targetSize === 0 || targetPrice === 0) return;

  // Flat €10 per trade
  const notional = strategy.flat_bet;
  const size = Math.round((notional / targetPrice) * 100) / 100;

  // Check for duplicate (same target tx)
  const txHash = trade.transactionHash || '';
  if (txHash) {
    const dup = db.prepare('SELECT id FROM paper_trades WHERE target_tx = ? AND strategy_id = ?').get(txHash, strategy.id);
    if (dup) return;
  }

  // Convert unix timestamp to ISO for display
  const tradeTime = trade.timestamp
    ? new Date(parseInt(trade.timestamp) * 1000).toISOString()
    : new Date().toISOString();

  const ptInfo = db.prepare(`
    INSERT INTO paper_trades (strategy_id, target_id, market_slug, condition_id, token_id, title, outcome, side, size, price, notional, target_tx, target_size, target_price, timestamp, current_price, pnl)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `).run(
    strategy.id,
    target.id,
    trade.slug || trade.market_slug || '',
    trade.conditionId || '',
    trade.asset || '',
    trade.title || '',
    trade.outcome || '',
    side,
    Math.round(size * 100) / 100,
    targetPrice,
    notional,
    txHash,
    targetSize,
    targetPrice,
    tradeTime,
    targetPrice
  );

  console.log(`[PAPER] ${strategy.name} | ${side} "${trade.outcome || ''}" @ $${targetPrice.toFixed(3)} | €${notional} | ${trade.title || ''}`);

  // Execute live trade if this strategy has live trading enabled
  try {
    await executeLiveTrade(strategy, target, trade, ptInfo.lastInsertRowid);
  } catch(e) {
    console.error(`[LIVE] Error in executeLiveTrade: ${e.message}`);
  }
}

async function retryRecentLiveTrades() {
  const candidates = db.prepare(`
    SELECT
      pt.*,
      s.id as strategy_id,
      s.name as strategy_name,
      s.live_enabled,
      s.live_bet,
      s.flat_bet,
      t.id as target_id,
      t.name as target_name,
      t.address as target_address,
      lt.status as live_status,
      lt.error as live_error
    FROM paper_trades pt
    JOIN strategies s ON s.id = pt.strategy_id
    JOIN targets t ON t.id = pt.target_id
    LEFT JOIN (
      SELECT paper_trade_id, MAX(id) as max_id
      FROM live_trades
      GROUP BY paper_trade_id
    ) latest ON latest.paper_trade_id = pt.id
    LEFT JOIN live_trades lt ON lt.id = latest.max_id
    WHERE s.active = 1
      AND s.live_enabled = 1
      AND datetime(replace(replace(pt.timestamp, 'T', ' '), 'Z', '')) > datetime('now', ?)
      AND (
        lt.id IS NULL
        OR lt.status = 'blocked'
        OR (lt.status = 'error' AND (
          lt.error LIKE '%not enough balance%'
          OR lt.error LIKE '%allowance%'
          OR lt.error LIKE '%Max spend reached%'
        ))
      )
    ORDER BY pt.timestamp DESC
    LIMIT 5
  `).all(`-${MAX_LIVE_TRADE_AGE_SECONDS} seconds`);

  for (const candidate of candidates) {
    if (candidate.live_status === 'error' && !isRetryableLiveError(candidate.live_error || '')) continue;
    const strategy = {
      id: candidate.strategy_id,
      name: candidate.strategy_name,
      live_enabled: candidate.live_enabled,
      live_bet: candidate.live_bet,
      flat_bet: candidate.flat_bet,
    };
    const target = {
      id: candidate.target_id,
      name: candidate.target_name,
      address: candidate.target_address,
    };
    const trade = {
      asset: candidate.token_id,
      conditionId: candidate.condition_id,
      title: candidate.title,
      outcome: candidate.outcome,
      side: candidate.side,
      price: candidate.price,
      timestamp: candidate.timestamp,
    };
    await executeLiveTrade(strategy, target, trade, candidate.id);
  }
}

// ============================================================
// P&L UPDATER
// ============================================================

async function updateAllPnL() {
  const openTrades = db.prepare("SELECT * FROM paper_trades WHERE status = 'open'").all();
  const priceCache = {};

  for (const trade of openTrades) {
    if (!trade.token_id) continue;
    try {
      if (!(trade.token_id in priceCache)) {
        priceCache[trade.token_id] = await getMarketPrice(trade.token_id);
        // small delay to avoid hammering API
        await new Promise(r => setTimeout(r, 100));
      }
      const curPrice = priceCache[trade.token_id];
      if (curPrice === 0) continue;

      const pnl = trade.side === 'BUY'
        ? (curPrice - trade.price) * trade.size
        : (trade.price - curPrice) * trade.size;

      db.prepare('UPDATE paper_trades SET current_price = ?, pnl = ? WHERE id = ?').run(
        curPrice, Math.round(pnl * 100) / 100, trade.id
      );
    } catch(e) { /* skip */ }
  }

  // Snapshot P&L per strategy
  const strategies = db.prepare('SELECT * FROM strategies').all();
  const snapInsert = db.prepare(`INSERT INTO pnl_snapshots (strategy_id, timestamp, total_pnl, open_positions, total_trades) VALUES (?, datetime('now'), ?, ?, ?)`);

  for (const s of strategies) {
    const trades = db.prepare('SELECT * FROM paper_trades WHERE strategy_id = ?').all(s.id);
    const totalPnl = trades.reduce((sum, t) => sum + (t.pnl || 0), 0);
    const openCount = trades.filter(t => t.status === 'open').length;
    snapInsert.run(s.id, Math.round(totalPnl * 100) / 100, openCount, trades.length);
  }

  // Combined snapshot (strategy_id = 0)
  const allTrades = db.prepare('SELECT * FROM paper_trades').all();
  const combinedPnl = allTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
  const combinedOpen = allTrades.filter(t => t.status === 'open').length;
  snapInsert.run(0, Math.round(combinedPnl * 100) / 100, combinedOpen, allTrades.length);

  console.log(`[PNL] Updated ${openTrades.length} positions, ${Object.keys(priceCache).length} unique tokens`);
}

// Update P&L every 30 seconds
setInterval(updateAllPnL, 30000);
// First update after 5s
setTimeout(updateAllPnL, 5000);

// ============================================================
// API ROUTES
// ============================================================

app.get('/api/targets', (req, res) => {
  res.json(db.prepare('SELECT * FROM targets ORDER BY added_at DESC').all());
});

app.post('/api/targets', (req, res) => {
  const { name, address, profile_url } = req.body;
  if (!name || !address) return res.status(400).json({ error: 'name and address required' });
  try {
    const info = db.prepare('INSERT INTO targets (name, address, profile_url) VALUES (?, ?, ?)').run(name, address.toLowerCase(), profile_url || '');
    res.json({ id: info.lastInsertRowid });
  } catch(e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/targets/:id', (req, res) => {
  db.prepare('DELETE FROM targets WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/strategies', (req, res) => {
  res.json(db.prepare(`
    SELECT s.*, t.name as target_name, t.address as target_address, t.profile_url as target_url
    FROM strategies s JOIN targets t ON s.target_id = t.id
    ORDER BY s.created_at DESC
  `).all());
});

app.post('/api/strategies', (req, res) => {
  const { name, target_id, flat_bet, copy_buys, copy_sells } = req.body;
  if (!name || !target_id) return res.status(400).json({ error: 'name and target_id required' });
  const info = db.prepare('INSERT INTO strategies (name, target_id, flat_bet, copy_buys, copy_sells) VALUES (?, ?, ?, ?, ?)').run(
    name, target_id, flat_bet || 10, copy_buys ?? 1, copy_sells ?? 1
  );
  res.json({ id: info.lastInsertRowid });
});

app.patch('/api/strategies/:id', (req, res) => {
  const { active, flat_bet } = req.body;
  if (active !== undefined) db.prepare('UPDATE strategies SET active = ? WHERE id = ?').run(active ? 1 : 0, req.params.id);
  if (flat_bet !== undefined) db.prepare('UPDATE strategies SET flat_bet = ? WHERE id = ?').run(flat_bet, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/strategies/:id', (req, res) => {
  db.prepare('DELETE FROM paper_trades WHERE strategy_id = ?').run(req.params.id);
  db.prepare('DELETE FROM pnl_snapshots WHERE strategy_id = ?').run(req.params.id);
  db.prepare('DELETE FROM strategies WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/trades', (req, res) => {
  const { strategy_id, target_id, limit } = req.query;
  let sql = `
    SELECT pt.*, s.name as strategy_name, t.name as target_name
    FROM paper_trades pt
    JOIN strategies s ON pt.strategy_id = s.id
    JOIN targets t ON pt.target_id = t.id
  `;
  const conditions = [];
  const params = [];
  if (strategy_id) { conditions.push('pt.strategy_id = ?'); params.push(strategy_id); }
  if (target_id) { conditions.push('pt.target_id = ?'); params.push(target_id); }
  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY pt.timestamp DESC LIMIT ?';
  params.push(parseInt(limit) || 200);
  res.json(db.prepare(sql).all(...params));
});

app.get('/api/stats', (req, res) => {
  const strategies = db.prepare(`
    SELECT s.*, t.name as target_name, t.address as target_address, t.profile_url as target_url
    FROM strategies s JOIN targets t ON s.target_id = t.id
  `).all();

  const stats = strategies.map(s => {
    const trades = db.prepare('SELECT * FROM paper_trades WHERE strategy_id = ?').all(s.id);
    const totalPnl = trades.reduce((sum, t) => sum + (t.pnl || 0), 0);
    const totalNotional = trades.reduce((sum, t) => sum + (t.notional || 0), 0);
    const openCount = trades.filter(t => t.status === 'open').length;
    const winCount = trades.filter(t => (t.pnl || 0) > 0).length;
    return {
      strategy_id: s.id,
      strategy_name: s.name,
      target_name: s.target_name,
      target_address: s.target_address,
      target_url: s.target_url,
      flat_bet: s.flat_bet,
      active: s.active,
      total_trades: trades.length,
      open_trades: openCount,
      total_pnl: Math.round(totalPnl * 100) / 100,
      total_notional: Math.round(totalNotional * 100) / 100,
      win_rate: trades.length > 0 ? Math.round((winCount / trades.length) * 100) : 0,
      roi: totalNotional > 0 ? Math.round((totalPnl / totalNotional) * 10000) / 100 : 0
    };
  });

  // Combined stats
  const allTrades = db.prepare('SELECT * FROM paper_trades').all();
  const combinedPnl = allTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
  const combinedNotional = allTrades.reduce((sum, t) => sum + (t.notional || 0), 0);
  const combinedWins = allTrades.filter(t => (t.pnl || 0) > 0).length;

  res.json({
    strategies: stats,
    combined: {
      total_trades: allTrades.length,
      open_trades: allTrades.filter(t => t.status === 'open').length,
      total_pnl: Math.round(combinedPnl * 100) / 100,
      total_notional: Math.round(combinedNotional * 100) / 100,
      win_rate: allTrades.length > 0 ? Math.round((combinedWins / allTrades.length) * 100) : 0,
      roi: combinedNotional > 0 ? Math.round((combinedPnl / combinedNotional) * 10000) / 100 : 0
    }
  });
});

// P&L chart data
app.get('/api/pnl-history', (req, res) => {
  const { strategy_id, hours } = req.query;
  const h = parseInt(hours) || 168; // default 7 days
  const sid = parseInt(strategy_id) || 0; // 0 = combined

  const snapshots = db.prepare(`
    SELECT * FROM pnl_snapshots
    WHERE strategy_id = ? AND timestamp > datetime('now', ?)
    ORDER BY timestamp ASC
  `).all(sid, `-${h} hours`);

  res.json(snapshots);
});

// Proxy to Polymarket
app.get('/api/pm/positions/:address', async (req, res) => {
  try { res.json(await getTargetPositions(req.params.address)); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/pm/trades/:address', async (req, res) => {
  try { res.json(await getTargetTrades(req.params.address)); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// Polling control
app.post('/api/polling/start', (req, res) => { startPolling(); res.json({ status: 'running' }); });
app.post('/api/polling/stop', (req, res) => { stopPolling(); res.json({ status: 'stopped' }); });
app.get('/api/polling/status', (req, res) => { res.json({ running: !!pollingInterval }); });

// ============================================================
// LIVE TRADING API
// ============================================================

// Get live config
app.get('/api/live/config', async (req, res) => {
  try {
    const keys = ['kill_switch', 'max_loss', 'max_trades_per_hour'];
    const config = {};
    for (const k of keys) {
      const row = getConfig.get(k);
      config[k] = row ? row.value : null;
    }
    // Include strategies with live info + budget
    const strategies = db.prepare(`
      SELECT s.id, s.name, s.target_id, s.live_enabled, s.live_bet, s.live_budget, s.live_start_capital, t.name as target_name
      FROM strategies s JOIN targets t ON s.target_id = t.id
    `).all();
    // Add budget usage per strategy
    for (const s of strategies) {
      if (s.live_enabled && s.live_budget > 0) {
        const spent = db.prepare("SELECT COALESCE(SUM(amount),0) as t FROM live_trades WHERE strategy_id=? AND status IN ('filled','pending') AND side='BUY'").get(s.id).t || 0;
        const collected = db.prepare("SELECT COALESCE(SUM(amount),0) as t FROM live_trades WHERE strategy_id=? AND status='filled' AND side='SELL'").get(s.id).t || 0;
        s.budget_spent = Math.round(spent * 100) / 100;
        s.budget_collected = Math.round(collected * 100) / 100;
        s.budget_remaining = Math.round((s.live_budget - spent + collected) * 100) / 100;
      }
    }
    config.strategies = strategies;
    config.safety = await checkSafetyLimits();
    res.json(config);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update live config
app.patch('/api/live/config', (req, res) => {
  const { max_loss, max_trades_per_hour } = req.body;
  if (max_loss !== undefined) setConfig.run('max_loss', String(max_loss));
  if (max_trades_per_hour !== undefined) setConfig.run('max_trades_per_hour', String(max_trades_per_hour));
  res.json({ ok: true });
});

// Kill switch
app.post('/api/live/kill', (req, res) => {
  setConfig.run('kill_switch', '1');
  console.log('[LIVE] KILL SWITCH ACTIVATED');
  res.json({ ok: true, kill_switch: true });
});

// Resume (disable kill switch)
app.post('/api/live/resume', (req, res) => {
  setConfig.run('kill_switch', '0');
  console.log('[LIVE] Kill switch deactivated — live trading resumed');
  res.json({ ok: true, kill_switch: false });
});

// Enable/disable live trading for a strategy
app.patch('/api/live/strategies/:id', (req, res) => {
  const { live_enabled, live_bet } = req.body;
  if (live_enabled !== undefined) db.prepare('UPDATE strategies SET live_enabled = ? WHERE id = ?').run(live_enabled ? 1 : 0, req.params.id);
  if (live_bet !== undefined) db.prepare('UPDATE strategies SET live_bet = ? WHERE id = ?').run(live_bet, req.params.id);
  res.json({ ok: true });
});

// Helper: resolve strategy filter from query
function resolveStrategyFilter(query) {
  if (query.strategy_id) return parseInt(query.strategy_id);
  if (query.strategy) {
    const row = db.prepare(`
      SELECT s.id FROM strategies s JOIN targets t ON s.target_id = t.id
      WHERE t.name = ? AND s.live_enabled = 1 LIMIT 1
    `).get(query.strategy);
    return row ? row.id : null;
  }
  return null;
}

// Get token_ids belonging to a strategy (from filled live_trades)
function getStrategyTokenIds(strategyId) {
  return new Set(
    db.prepare("SELECT DISTINCT token_id FROM live_trades WHERE strategy_id = ? AND status = 'filled'")
      .all(strategyId).map(r => r.token_id)
  );
}

// Get live trades
app.get('/api/live/trades', (req, res) => {
  const { limit, status } = req.query;
  const stratId = resolveStrategyFilter(req.query);
  const conditions = [];
  const params = [];
  if (status) { conditions.push('status = ?'); params.push(status); }
  if (stratId) { conditions.push('strategy_id = ?'); params.push(stratId); }
  let sql = 'SELECT * FROM live_trades';
  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY timestamp DESC LIMIT ?';
  params.push(parseInt(limit) || 100);
  res.json(db.prepare(sql).all(...params));
});

// Get live stats
app.get('/api/live/stats', async (req, res) => {
  try {
    const stratId = resolveStrategyFilter(req.query);
    const where = stratId ? ' WHERE strategy_id = ?' : '';
    const p = stratId ? [stratId] : [];

    const all = db.prepare('SELECT * FROM live_trades' + where).all(...p);
    const filled = all.filter(t => t.status === 'filled');
    const errors = all.filter(t => t.status === 'error');
    const pending = all.filter(t => t.status === 'pending');
    const skipped = all.filter(t => t.status === 'skipped');

    const hourAgo = new Date(Date.now() - 3600000).toISOString();
    const hourSql = stratId
      ? "SELECT COUNT(*) as c FROM live_trades WHERE timestamp > ? AND strategy_id = ?"
      : "SELECT COUNT(*) as c FROM live_trades WHERE timestamp > ?";
    const hourParams = stratId ? [hourAgo, stratId] : [hourAgo];
    const tradesLastHour = db.prepare(hourSql).get(...hourParams).c;

    const liveState = await getLiveState();

    // If filtering by strategy, calculate strategy-specific exposure
    let totalSpent = liveState.positionsInitialValue;
    let positionsValue = liveState.positionsCurrentValue;
    if (stratId) {
      const tokenIds = getStrategyTokenIds(stratId);
      totalSpent = liveState.positions
        .filter(pos => tokenIds.has(String(pos.asset)))
        .reduce((s, pos) => s + getPositionInitialValue(pos), 0);
      positionsValue = liveState.positions
        .filter(pos => tokenIds.has(String(pos.asset)))
        .reduce((s, pos) => s + getPositionCurrentValue(pos), 0);
    }

    // Strategy budget info
    let budget = null;
    if (stratId) {
      const strat = db.prepare('SELECT live_budget, live_start_capital FROM strategies WHERE id = ?').get(stratId);
      if (strat && strat.live_budget > 0) {
        const spent = db.prepare("SELECT COALESCE(SUM(amount),0) as t FROM live_trades WHERE strategy_id=? AND status IN ('filled','pending') AND side='BUY'").get(stratId).t || 0;
        const collected = db.prepare("SELECT COALESCE(SUM(amount),0) as t FROM live_trades WHERE strategy_id=? AND status='filled' AND side='SELL'").get(stratId).t || 0;
        budget = {
          total: strat.live_budget,
          start_capital: strat.live_start_capital,
          spent: Math.round(spent * 100) / 100,
          collected: Math.round(collected * 100) / 100,
          remaining: Math.round((strat.live_budget - spent + collected) * 100) / 100,
        };
      }
    }

    res.json({
      total: all.length,
      filled: filled.length,
      errors: errors.length,
      pending: pending.length,
      skipped: skipped.length,
      trades_last_hour: tradesLastHour,
      total_spent: Math.round(totalSpent * 10000) / 10000,
      positions_value: Math.round(positionsValue * 10000) / 10000,
      open_buy_orders: Math.round(liveState.openBuyNotional * 10000) / 10000,
      total_exposure: Math.round(liveState.totalExposure * 10000) / 10000,
      safety: await checkSafetyLimits(),
      kill_switch: getConfig.get('kill_switch')?.value === '1',
      budget,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Proxy to trading server balance
app.get('/api/live/balance', async (req, res) => {
  try {
    const r = await fetch(`${TRADING_SERVER}/api/balance`);
    res.json(await r.json());
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// COLLECT (sell winning positions)
// ============================================================

app.get('/api/live/positions', async (req, res) => {
  try {
    const stratId = resolveStrategyFilter(req.query);
    const tokenFilter = stratId ? getStrategyTokenIds(stratId) : null;

    const positions = (await getTradingPositions())
      .filter(position => getPositionSize(position) > 0)
      .filter(position => !tokenFilter || tokenFilter.has(String(position.asset)))
      .sort((a, b) => getPositionCurrentValue(b) - getPositionCurrentValue(a))
      .map(position => {
        const currentPrice = getPositionPrice(position);
        return {
          token_id: position.asset,
          condition_id: position.conditionId,
          title: position.title,
          outcome: position.outcome,
          size: getPositionSize(position),
          total_cost: getPositionInitialValue(position),
          current_price: currentPrice,
          current_value: getPositionCurrentValue(position),
          redeemable: !!position.redeemable,
          negative_risk: !!position.negativeRisk,
          is_collectable: isCollectablePosition(position),
          is_winner: currentPrice >= 0.90,
          is_loser: currentPrice > 0 && currentPrice <= 0.10,
        };
      });
    res.json(positions);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Collect: sell all winning positions
app.post('/api/live/collect', async (req, res) => {
  try {
    const results = await collectLivePositions('manual');
    const successCount = results.filter(r => r.success).length;
    const actionableCount = results.filter(r => !r.skipped).length;

    if (actionableCount === 0) {
      return res.json({ message: 'No collectable positions right now', results });
    }

    res.json({
      message: `Completed ${successCount}/${actionableCount} collect actions`,
      results,
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// PORTFOLIO SNAPSHOTS
// ============================================================

const START_CAPITAL = 26; // total deposited: $11 + $15
const SNAPSHOT_INTERVAL_MS = 60000; // every 60s

async function takePortfolioSnapshot() {
  try {
    const [balance, state] = await Promise.all([getTradingBalance(), getLiveState()]);
    const cash = toNumber(balance.usdc_bridged ?? balance.usdc);
    const positionsValue = state.positionsCurrentValue;
    const totalValue = cash + positionsValue;

    db.prepare(`
      INSERT INTO portfolio_snapshots (cash, positions_value, total_value, start_capital)
      VALUES (?, ?, ?, ?)
    `).run(
      Math.round(cash * 10000) / 10000,
      Math.round(positionsValue * 10000) / 10000,
      Math.round(totalValue * 10000) / 10000,
      START_CAPITAL
    );

    // Record per-position prices
    const insertPos = db.prepare(`
      INSERT INTO position_snapshots (token_id, price, size, value, cost)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const pos of state.positions) {
      if (getPositionSize(pos) <= 0) continue;
      insertPos.run(
        pos.asset,
        Math.round(getPositionPrice(pos) * 10000) / 10000,
        Math.round(getPositionSize(pos) * 10000) / 10000,
        Math.round(getPositionCurrentValue(pos) * 10000) / 10000,
        Math.round(getPositionInitialValue(pos) * 10000) / 10000
      );
    }
  } catch(e) {
    console.error('[SNAPSHOT] Error:', e.message);
  }
}

// Portfolio history API
app.get('/api/live/portfolio-history', (req, res) => {
  try {
    const stratId = resolveStrategyFilter(req.query);
    const limit = parseInt(req.query.limit) || 1440;

    if (stratId) {
      // Per-strategy portfolio history: reconstruct from position_snapshots + budget
      const strat = db.prepare('SELECT live_budget, live_start_capital FROM strategies WHERE id = ?').get(stratId);
      const startCap = strat ? (strat.live_start_capital || strat.live_budget || START_CAPITAL) : START_CAPITAL;
      const tokenIds = getStrategyTokenIds(stratId);

      if (tokenIds.size === 0) {
        return res.json({ start_capital: startCap, snapshots: [] });
      }

      // Get unique snapshot timestamps
      const placeholders = [...tokenIds].map(() => '?').join(',');
      const timestamps = db.prepare(`
        SELECT DISTINCT timestamp FROM position_snapshots
        WHERE token_id IN (${placeholders})
        ORDER BY id DESC LIMIT ?
      `).all(...tokenIds, limit).map(r => r.timestamp);
      timestamps.reverse();

      // For each timestamp, sum position values for this strategy's tokens
      const snapshots = timestamps.map(ts => {
        const posRows = db.prepare(`
          SELECT SUM(value) as pv, SUM(cost) as pc FROM position_snapshots
          WHERE timestamp = ? AND token_id IN (${placeholders})
        `).get(ts, ...tokenIds);
        const posValue = posRows.pv || 0;
        const posCost = posRows.pc || 0;
        const cash = Math.max(0, startCap - posCost);
        return {
          timestamp: ts,
          cash: Math.round(cash * 10000) / 10000,
          positions_value: Math.round(posValue * 10000) / 10000,
          total_value: Math.round((cash + posValue) * 10000) / 10000,
          start_capital: startCap,
        };
      });

      return res.json({ start_capital: startCap, snapshots });
    }

    // No strategy filter — return global snapshots
    const rows = db.prepare(`
      SELECT timestamp, cash, positions_value, total_value, start_capital
      FROM portfolio_snapshots
      ORDER BY id DESC
      LIMIT ?
    `).all(limit);
    rows.reverse();
    res.json({
      start_capital: START_CAPITAL,
      snapshots: rows,
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Position price history API
app.get('/api/live/position-history', (req, res) => {
  try {
    const stratId = resolveStrategyFilter(req.query);
    const tokenFilter = stratId ? getStrategyTokenIds(stratId) : null;

    // Get all position sparkline data grouped by token_id
    const rows = db.prepare(`
      SELECT token_id, price, value, cost, timestamp
      FROM position_snapshots
      WHERE timestamp > datetime('now', '-24 hours')
      ORDER BY id ASC
    `).all();

    const byToken = {};
    for (const r of rows) {
      if (tokenFilter && !tokenFilter.has(r.token_id)) continue;
      if (!byToken[r.token_id]) byToken[r.token_id] = [];
      byToken[r.token_id].push({ price: r.price, value: r.value, cost: r.cost, t: r.timestamp });
    }
    res.json(byToken);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// START
// ============================================================

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`\n  Polymarket CopyTrader running on port ${PORT}`);
  console.log(`  http://localhost:${PORT}\n`);
  startPolling(); // always start polling
  // Start portfolio snapshots
  takePortfolioSnapshot();
  setInterval(takePortfolioSnapshot, SNAPSHOT_INTERVAL_MS);
});
