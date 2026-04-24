require('dotenv').config();
const express = require('express');
const path = require('path');
const Database = require('better-sqlite3');
const { kellyBetSize, kellyFraction } = require('./orchestrator/kelly');

// ── Config ──
const PORT = process.env.TEST_BOT_PORT || 4010;
const STARTING_BANKROLL = parseFloat(process.env.TEST_BOT_BANKROLL || '100');
const CYCLE_MS = parseInt(process.env.TEST_BOT_CYCLE_MS || '30000'); // 30s
const MIN_CONFIDENCE = parseFloat(process.env.MIN_CONFIDENCE || '0.52');
const GAMMA_API = 'https://gamma-api.polymarket.com';
const MAX_POSITIONS = 25;

// ── DB ──
const db = new Database(path.join(__dirname, 'test-bot.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS paper_positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    condition_id TEXT,
    token_id TEXT UNIQUE,
    question TEXT,
    outcome TEXT,
    entry_price REAL,
    shares REAL,
    cost REAL,
    opened_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS equity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT DEFAULT (datetime('now')),
    bankroll REAL,
    positions_value REAL,
    equity REAL
  );
  CREATE TABLE IF NOT EXISTS trade_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT DEFAULT (datetime('now')),
    action TEXT,
    question TEXT,
    outcome TEXT,
    price REAL,
    shares REAL,
    cost REAL,
    confidence REAL,
    reason TEXT
  );
  CREATE TABLE IF NOT EXISTS resolved_positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    condition_id TEXT,
    token_id TEXT,
    question TEXT,
    outcome TEXT,
    entry_price REAL,
    exit_price REAL,
    shares REAL,
    pnl REAL,
    opened_at TEXT,
    resolved_at TEXT DEFAULT (datetime('now'))
  );
`);

// ── State ──
let bankroll = STARTING_BANKROLL;
let cycleRunning = false;
let botRunning = true;
let lastCycleTs = null;

// Load last equity state if exists
const lastEquity = db.prepare('SELECT equity, bankroll FROM equity_log ORDER BY id DESC LIMIT 1').get();
if (lastEquity) {
  bankroll = lastEquity.bankroll;
  console.log(`[TEST-BOT] Resuming from bankroll $${bankroll.toFixed(2)}`);
}

// ── Market Fetching ──
const SEARCH_QUERIES = [
  'Bitcoin', 'Ethereum', 'Trump', 'Fed', 'AI', 'election',
  'crypto', 'stock market', 'recession', 'inflation', 'China', 'Ukraine'
];

async function fetchMarkets(query) {
  const url = `${GAMMA_API}/markets?closed=false&limit=15&title_contains=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) return [];
  const markets = await res.json();
  return markets.map(m => {
    const tokenIds = JSON.parse(m.clobTokenIds || '[]');
    const outcomes = JSON.parse(m.outcomes || '[]');
    const prices = JSON.parse(m.outcomePrices || '[]');
    return {
      conditionId: m.conditionId,
      question: m.question,
      slug: m.slug,
      volume: parseFloat(m.volume || 0),
      tokens: tokenIds.map((id, i) => ({
        tokenId: id,
        outcome: outcomes[i],
        price: parseFloat(prices[i] || 0)
      })).filter(t => t.price > 0.05 && t.price < 0.95),
      closed: m.closed
    };
  }).filter(m => m.tokens.length > 0 && !m.closed && m.volume > 500);
}

async function fetchCurrentPrice(tokenId) {
  try {
    const url = `${GAMMA_API}/markets?closed=false&limit=1&clob_token_ids=${tokenId}`;
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) return null;
    const markets = await res.json();
    if (!markets.length) return null;
    const prices = JSON.parse(markets[0].outcomePrices || '[]');
    const tokenIds = JSON.parse(markets[0].clobTokenIds || '[]');
    const idx = tokenIds.indexOf(tokenId);
    if (idx === -1) return null;
    return parseFloat(prices[idx]);
  } catch {
    return null;
  }
}

// ── Confidence Estimation (simple heuristic from market data) ──
function estimateConfidence(price, volume) {
  // Simple heuristic: volume signals market conviction
  // Low volume = less confident, high volume = more confident
  // Distance from 0.5 = market has stronger opinion
  const volumeSignal = Math.min(volume / 100000, 1) * 0.1;
  const convictionSignal = Math.abs(price - 0.5) * 0.2;
  const baseConfidence = price > 0.5 ? price : (1 - price);
  // Add a small edge over the market price to represent "our view"
  const edge = baseConfidence + volumeSignal + convictionSignal;
  return Math.min(Math.max(edge, 0), 0.95);
}

// ── Trading Logic ──
async function runCycle() {
  if (cycleRunning) return;
  cycleRunning = true;
  lastCycleTs = new Date().toISOString();

  try {
    // 1. Mark resolved positions
    await resolvePositions();

    // 2. Scan for new opportunities
    const positions = db.prepare('SELECT COUNT(*) as cnt FROM paper_positions').get().cnt;
    if (positions >= MAX_POSITIONS) {
      console.log(`[TEST-BOT] Max positions (${MAX_POSITIONS}) reached, skipping scan`);
      return;
    }

    // Shuffle queries for variety
    const shuffled = [...SEARCH_QUERIES].sort(() => Math.random() - 0.5);
    let newTrades = 0;

    for (const query of shuffled) {
      if (newTrades >= 3) break; // max 3 new trades per cycle
      if (positions + newTrades >= MAX_POSITIONS) break;

      const markets = await fetchMarkets(query);
      for (const market of markets) {
        if (newTrades >= 3) break;

        for (const token of market.tokens) {
          if (newTrades >= 3) break;

          // Skip if already holding
          const existing = db.prepare('SELECT id FROM paper_positions WHERE token_id = ?').get(token.tokenId);
          if (existing) continue;

          // Skip very cheap or very expensive
          if (token.price < 0.05 || token.price > 0.95) continue;

          const confidence = estimateConfidence(token.price, market.volume);
          if (confidence < MIN_CONFIDENCE) continue;

          const betSize = kellyBetSize(confidence, token.price, bankroll);
          if (betSize <= 0 || betSize < 1) continue;

          // Cap bet at 5% of bankroll
          const actualBet = Math.min(betSize, bankroll * 0.05, bankroll);
          if (actualBet < 1) continue;

          const shares = actualBet / token.price;
          bankroll -= actualBet;

          db.prepare(`
            INSERT INTO paper_positions (condition_id, token_id, question, outcome, entry_price, shares, cost)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(market.conditionId, token.tokenId, market.question, token.outcome, token.price, shares, actualBet);

          db.prepare(`
            INSERT INTO trade_log (action, question, outcome, price, shares, cost, confidence, reason)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run('BUY', market.question, token.outcome, token.price, shares, actualBet, confidence, `Kelly ${confidence.toFixed(2)} vol $${market.volume.toFixed(0)}`);

          newTrades++;
          console.log(`[TEST-BOT] BUY ${token.outcome} @ $${token.price} | ${market.question.slice(0, 50)} | $${actualBet.toFixed(2)}`);
        }
      }
    }

    if (newTrades === 0) {
      console.log(`[TEST-BOT] No new trades this cycle`);
    }

  } catch (e) {
    console.error('[TEST-BOT] Cycle error:', e.message);
  } finally {
    // 3. Snapshot equity
    await snapshotEquity();
    cycleRunning = false;
  }
}

async function resolvePositions() {
  const positions = db.prepare('SELECT * FROM paper_positions').all();
  let resolved = 0;

  for (const pos of positions) {
    const currentPrice = await fetchCurrentPrice(pos.token_id);
    if (currentPrice === null) continue;

    // Check if market resolved (price at ~0.99 or ~0.01 for an extended time = effectively resolved)
    if (currentPrice >= 0.99) {
      // YES resolved — YES holders win
      const exitValue = pos.shares; // shares pay $1 each
      const pnl = exitValue - pos.cost;
      bankroll += exitValue;

      db.prepare(`
        INSERT INTO resolved_positions (condition_id, token_id, question, outcome, entry_price, exit_price, shares, pnl, opened_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(pos.condition_id, pos.token_id, pos.question, pos.outcome, pos.entry_price, 1.0, pos.shares, pnl, pos.opened_at);

      db.prepare('DELETE FROM paper_positions WHERE id = ?').run(pos.id);
      db.prepare(`
        INSERT INTO trade_log (action, question, outcome, price, shares, cost, confidence, reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run('RESOLVE WIN', pos.question, pos.outcome, 1.0, pos.shares, pos.cost, 1.0, `PnL +$${pnl.toFixed(2)}`);

      resolved++;
      console.log(`[TEST-BOT] WIN ${pos.question.slice(0, 40)} | +$${pnl.toFixed(2)}`);
    } else if (currentPrice <= 0.01) {
      // NO resolved — YES holders lose
      const pnl = -pos.cost;
      // No payout

      db.prepare(`
        INSERT INTO resolved_positions (condition_id, token_id, question, outcome, entry_price, exit_price, shares, pnl, opened_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(pos.condition_id, pos.token_id, pos.question, pos.outcome, pos.entry_price, 0.0, pos.shares, pnl, pos.opened_at);

      db.prepare('DELETE FROM paper_positions WHERE id = ?').run(pos.id);
      db.prepare(`
        INSERT INTO trade_log (action, question, outcome, price, shares, cost, confidence, reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run('RESOLVE LOSS', pos.question, pos.outcome, 0.0, pos.shares, pos.cost, 0.0, `PnL -$${Math.abs(pnl).toFixed(2)}`);

      resolved++;
      console.log(`[TEST-BOT] LOSS ${pos.question.slice(0, 40)} | -$${Math.abs(pnl).toFixed(2)}`);
    }
  }

  if (resolved > 0) {
    console.log(`[TEST-BOT] Resolved ${resolved} position(s)`);
  }
}

async function snapshotEquity() {
  const positions = db.prepare('SELECT * FROM paper_positions').all();
  let positionsValue = 0;

  for (const pos of positions) {
    const price = await fetchCurrentPrice(pos.token_id);
    if (price !== null) {
      positionsValue += pos.shares * price;
    } else {
      positionsValue += pos.cost; // fallback to cost
    }
  }

  const equity = bankroll + positionsValue;

  db.prepare('INSERT INTO equity_log (bankroll, positions_value, equity) VALUES (?, ?, ?)')
    .run(bankroll, positionsValue, equity);

  return { bankroll, positionsValue, equity };
}

// ── API ──
const app = express();
// Don't serve the main project's public/ — test bot has its own inline dashboard

app.get('/api/status', async (req, res) => {
  const eq = await snapshotEquity();
  const positions = db.prepare('SELECT * FROM paper_positions ORDER BY opened_at DESC').all();
  const recentTrades = db.prepare('SELECT * FROM trade_log ORDER BY id DESC LIMIT 20').all();
  const resolved = db.prepare('SELECT * FROM resolved_positions ORDER BY resolved_at DESC LIMIT 20').all();
  const equityHistory = db.prepare('SELECT * FROM equity_log ORDER BY id ASC LIMIT 500').all();
  const totalPnl = resolved.reduce((sum, r) => sum + r.pnl, 0);
  const wins = resolved.filter(r => r.pnl > 0).length;
  const losses = resolved.filter(r => r.pnl <= 0).length;

  res.json({
    running: botRunning,
    lastCycle: lastCycleTs,
    bankroll: eq.bankroll,
    positionsValue: eq.positionsValue,
    equity: eq.equity,
    startCapital: STARTING_BANKROLL,
    totalPnl,
    winRate: (wins + losses) > 0 ? (wins / (wins + losses) * 100).toFixed(1) : '0',
    wins,
    losses,
    openPositions: positions.length,
    positions,
    recentTrades,
    resolved,
    equityHistory
  });
});

app.post('/api/start', (req, res) => {
  botRunning = true;
  res.json({ status: 'started' });
});

app.post('/api/stop', (req, res) => {
  botRunning = false;
  res.json({ status: 'stopped' });
});

app.post('/api/reset', (req, res) => {
  db.exec('DELETE FROM paper_positions');
  db.exec('DELETE FROM equity_log');
  db.exec('DELETE FROM trade_log');
  db.exec('DELETE FROM resolved_positions');
  bankroll = STARTING_BANKROLL;
  res.json({ status: 'reset', bankroll });
});

// ── Dashboard ──
app.get('/', (req, res) => {
  res.send(dashboardHTML());
});

function dashboardHTML() {
  return `<!DOCTYPE html>
<html>
<head>
  <title>Test Bot — Paper Equity Dashboard</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family: -apple-system, sans-serif; background:#0a0a0a; color:#e0e0e0; padding:20px; }
    h1 { color:#00d4ff; font-size:1.4em; margin-bottom:4px; }
    .sub { color:#888; font-size:0.85em; margin-bottom:16px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:12px; margin-bottom:20px; }
    .card { background:#141414; border:1px solid #222; border-radius:8px; padding:16px; }
    .card .label { color:#888; font-size:0.75em; text-transform:uppercase; letter-spacing:0.05em; }
    .card .value { font-size:1.6em; font-weight:700; margin-top:4px; }
    .positive { color:#00e676; }
    .negative { color:#ff5252; }
    .neutral { color:#ffab40; }
    canvas { background:#141414; border:1px solid #222; border-radius:8px; width:100%; height:220px; }
    .section { margin-top:16px; }
    .section h2 { font-size:1em; color:#aaa; margin-bottom:8px; }
    table { width:100%; border-collapse:collapse; font-size:0.8em; }
    th { text-align:left; color:#888; padding:6px 8px; border-bottom:1px solid #222; font-weight:500; }
    td { padding:6px 8px; border-bottom:1px solid #1a1a1a; }
    tr:hover td { background:#1a1a1a; }
    .btn { padding:6px 14px; border:1px solid #333; background:#1a1a1a; color:#e0e0e0; border-radius:4px; cursor:pointer; font-size:0.8em; }
    .btn:hover { background:#2a2a2a; }
    .btn.danger { border-color:#ff5252; color:#ff5252; }
    .controls { margin-bottom:12px; display:flex; gap:8px; align-items:center; }
    .live-dot { width:8px; height:8px; border-radius:50%; display:inline-block; margin-right:6px; }
    .live-dot.on { background:#00e676; animation:pulse 2s infinite; }
    .live-dot.off { background:#ff5252; }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
    .truncate { max-width:300px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  </style>
</head>
<body>
  <h1>Test Bot — Paper Equity</h1>
  <div class="sub">Kelly criterion sizing &middot; Polymarket live prices &middot; No real money</div>

  <div class="controls">
    <span class="live-dot off" id="liveDot"></span>
    <span id="statusText" style="font-size:0.85em">Stopped</span>
    <button class="btn" onclick="toggleBot()" id="toggleBtn">Start</button>
    <button class="btn danger" onclick="resetBot()">Reset</button>
  </div>

  <div class="grid" id="cards"></div>
  <canvas id="chart"></canvas>

  <div class="section">
    <h2>Open Positions</h2>
    <table><thead><tr><th>Market</th><th>Side</th><th>Entry</th><th>Shares</th><th>Cost</th><th>Opened</th></tr></thead><tbody id="positions"></tbody></table>
  </div>

  <div class="section">
    <h2>Resolved</h2>
    <table><thead><tr><th>Market</th><th>Entry</th><th>Exit</th><th>PnL</th><th>Resolved</th></tr></thead><tbody id="resolved"></tbody></table>
  </div>

  <div class="section">
    <h2>Trade Log</h2>
    <table><thead><tr><th>Time</th><th>Action</th><th>Market</th><th>Price</th><th>Size</th><th>Confidence</th></tr></thead><tbody id="log"></tbody></table>
  </div>

  <script>
    let running = false;
    let interval = null;

    async function refresh() {
      const r = await fetch('/api/status').then(r => r.json());
      running = r.running;

      const pnl = r.equity - r.startCapital;
      const pnlPct = ((pnl / r.startCapital) * 100).toFixed(1);
      const pnlClass = pnl >= 0 ? 'positive' : 'negative';
      const pnlSign = pnl >= 0 ? '+' : '';

      document.getElementById('cards').innerHTML = \`
        <div class="card"><div class="label">Equity</div><div class="value">$\{r.equity.toFixed(2)}</div></div>
        <div class="card"><div class="label">Bankroll (Cash)</div><div class="value">$\{r.bankroll.toFixed(2)}</div></div>
        <div class="card"><div class="label">Positions Value</div><div class="value">$\{r.positionsValue.toFixed(2)}</div></div>
        <div class="card"><div class="label">Total PnL</div><div class="value \${pnlClass}">\${pnlSign}$\{pnl.toFixed(2)} (\${pnlPct}%)</div></div>
        <div class="card"><div class="label">Win Rate</div><div class="value">\${r.winRate}% (\${r.wins}W / \${r.losses}L)</div></div>
        <div class="card"><div class="label">Open Positions</div><div class="value">\${r.openPositions}</div></div>
      \`;

      // Chart
      const canvas = document.getElementById('chart');
      const ctx = canvas.getContext('2d');
      canvas.width = canvas.offsetWidth * 2;
      canvas.height = canvas.offsetHeight * 2;
      ctx.scale(2, 2);
      const w = canvas.offsetWidth, h = canvas.offsetHeight;
      ctx.clearRect(0, 0, w, h);

      const data = r.equityHistory;
      if (data.length > 1) {
        const vals = data.map(d => d.equity);
        const min = Math.min(...vals) * 0.95;
        const max = Math.max(...vals) * 1.05;
        const range = max - min || 1;
        const pad = 40;

        // Grid
        ctx.strokeStyle = '#222';
        ctx.lineWidth = 0.5;
        for (let i = 0; i <= 4; i++) {
          const y = pad + (i / 4) * (h - pad * 2);
          ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(w - pad, y); ctx.stroke();
          const val = max - (i / 4) * range;
          ctx.fillStyle = '#555'; ctx.font = '10px monospace';
          ctx.fillText('$' + val.toFixed(0), 2, y + 3);
        }

        // Start capital line
        const startY = pad + ((max - r.startCapital) / range) * (h - pad * 2);
        ctx.strokeStyle = '#333'; ctx.setLineDash([4,4]);
        ctx.beginPath(); ctx.moveTo(pad, startY); ctx.lineTo(w - pad, startY); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#444'; ctx.font = '9px monospace';
        ctx.fillText('start', w - pad - 30, startY - 4);

        // Equity line
        ctx.beginPath();
        ctx.strokeStyle = pnl >= 0 ? '#00e676' : '#ff5252';
        ctx.lineWidth = 1.5;
        for (let i = 0; i < vals.length; i++) {
          const x = pad + (i / (vals.length - 1)) * (w - pad * 2);
          const y = pad + ((max - vals[i]) / range) * (h - pad * 2);
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();

        // Fill area
        const lastX = pad + ((vals.length - 1) / (vals.length - 1)) * (w - pad * 2);
        ctx.lineTo(lastX, h - pad);
        ctx.lineTo(pad, h - pad);
        ctx.closePath();
        ctx.fillStyle = pnl >= 0 ? 'rgba(0,230,118,0.06)' : 'rgba(255,82,82,0.06)';
        ctx.fill();
      } else {
        ctx.fillStyle = '#555'; ctx.font = '12px sans-serif';
        ctx.fillText('Waiting for data...', w/2 - 50, h/2);
      }

      // Positions table
      document.getElementById('positions').innerHTML = r.positions.map(p => \`<tr>
        <td class="truncate">\${p.question}</td><td>\${p.outcome}</td><td>$\{p.entry_price.toFixed(3)}</td>
        <td>\${p.shares.toFixed(2)}</td><td>$\{p.cost.toFixed(2)}</td><td>\${p.opened_at?.slice(5,16)}</td>
      </tr>\`).join('') || '<tr><td colspan="6" style="color:#555">No open positions</td></tr>';

      // Resolved table
      document.getElementById('resolved').innerHTML = r.resolved.map(p => {
        const cls = p.pnl >= 0 ? 'positive' : 'negative';
        const sign = p.pnl >= 0 ? '+' : '';
        return \`<tr><td class="truncate">\${p.question}</td><td>$\{p.entry_price.toFixed(3)}</td>
        <td>$\{p.exit_price.toFixed(2)}</td><td class="\${cls}">\${sign}$\{p.pnl.toFixed(2)}</td>
        <td>\${p.resolved_at?.slice(5,16)}</td></tr>\`;
      }).join('') || '<tr><td colspan="5" style="color:#555">No resolved positions</td></tr>';

      // Trade log
      document.getElementById('log').innerHTML = r.recentTrades.map(t => {
        const actionCls = t.action.includes('WIN') ? 'positive' : t.action.includes('LOSS') ? 'negative' : 'neutral';
        return \`<tr><td>\${t.ts?.slice(5,19)}</td><td class="\${actionCls}">\${t.action}</td>
        <td class="truncate">\${t.question}</td><td>$\{t.price.toFixed(3)}</td>
        <td>$\{t.cost.toFixed(2)}</td><td>\${t.confidence.toFixed(2)}</td></tr>\`;
      }).join('');

      // Status indicator
      const dot = document.getElementById('liveDot');
      const st = document.getElementById('statusText');
      const btn = document.getElementById('toggleBtn');
      dot.className = 'live-dot ' + (running ? 'on' : 'off');
      st.textContent = running ? 'Running' : 'Stopped';
      btn.textContent = running ? 'Pause' : 'Start';
    }

    async function toggleBot() {
      if (running) {
        await fetch('/api/stop', { method: 'POST' });
      } else {
        await fetch('/api/start', { method: 'POST' });
      }
      refresh();
    }

    async function resetBot() {
      if (!confirm('Reset all paper trading data?')) return;
      await fetch('/api/reset', { method: 'POST' });
      refresh();
    }

    // Poll every 5s
    setInterval(refresh, 5000);
    refresh();
  </script>
</body>
</html>`;
}

// ── Start ──
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  Test Bot running on http://localhost:${PORT}\n  Starting bankroll: $${STARTING_BANKROLL}\n  Cycle: every ${CYCLE_MS / 1000}s\n`);
});

// Initial equity snapshot
snapshotEquity();

// Main cycle loop
setInterval(() => {
  if (botRunning && !cycleRunning) {
    runCycle();
  }
}, CYCLE_MS);

// Run first cycle immediately
if (botRunning) {
  setTimeout(runCycle, 2000);
}