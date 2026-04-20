// Calibrate target_bankroll from Polymarket activity data
const Database = require('better-sqlite3');
const db = new Database(__dirname + '/data.db');

const DATA_API = 'https://data-api.polymarket.com';

async function pmFetch(url) {
  const res = await fetch(url, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
  });
  if (!res.ok) throw new Error(`PM API ${res.status}`);
  return res.json();
}

async function calibrateTarget(target) {
  try {
    // Get positions to estimate bankroll
    const positions = await pmFetch(`${DATA_API}/positions?user=${target.address}&limit=200&sizeThreshold=0.1&sortBy=CURRENT`);
    
    // Get recent trades to estimate typical trade size
    const trades = await pmFetch(`${DATA_API}/activity?user=${target.address}&type=TRADE&sortBy=TIMESTAMP&sortDirection=DESC&limit=50`);
    
    // Calculate position value
    const positionValue = (Array.isArray(positions) ? positions : []).reduce((sum, p) => {
      const size = parseFloat(p.size) || 0;
      const price = parseFloat(p.curPrice || p.current_price) || 0;
      return sum + (size * price);
    }, 0);

    // Calculate average trade size (notional value)
    const tradeValues = (Array.isArray(trades) ? trades : []).map(t => {
      return (parseFloat(t.size) || 0) * (parseFloat(t.price) || 0);
    }).filter(v => v > 0);
    
    const avgTradeValue = tradeValues.length > 0 
      ? tradeValues.reduce((a, b) => a + b, 0) / tradeValues.length 
      : 0;
    
    const medianTradeValue = tradeValues.length > 0
      ? tradeValues.sort((a, b) => a - b)[Math.floor(tradeValues.length / 2)]
      : 0;

    // Estimate bankroll: position value + some cash buffer (~30%)
    const estimatedBankroll = Math.max(positionValue * 1.3, avgTradeValue * 20, 100);
    
    console.log(`${target.name}:`);
    console.log(`  Positions value: $${positionValue.toFixed(2)}`);
    console.log(`  Avg trade value: $${avgTradeValue.toFixed(2)}`);
    console.log(`  Median trade:    $${medianTradeValue.toFixed(2)}`);
    console.log(`  Est. bankroll:   $${estimatedBankroll.toFixed(0)}`);
    console.log(`  Trades sampled:  ${tradeValues.length}`);
    
    // Update DB
    db.prepare('UPDATE strategies SET target_bankroll = ? WHERE target_id = ?')
      .run(Math.round(estimatedBankroll), target.id);
    
    return { name: target.name, bankroll: estimatedBankroll, positionValue, avgTradeValue };
  } catch (e) {
    console.error(`  ${target.name}: Error - ${e.message}`);
    return null;
  }
}

async function main() {
  const targets = db.prepare('SELECT * FROM targets WHERE active = 1').all();
  console.log(`\nCalibrating ${targets.length} targets...\n`);
  
  for (const target of targets) {
    await calibrateTarget(target);
    await new Promise(r => setTimeout(r, 300)); // rate limit
    console.log('');
  }
  
  // Show results
  const strategies = db.prepare(`
    SELECT s.name, t.name as target_name, s.target_bankroll, s.live_bet, s.live_start_capital, s.active
    FROM strategies s JOIN targets t ON t.id = s.target_id
    ORDER BY s.target_bankroll DESC
  `).all();
  
  console.log('\n=== Updated Bankrolls ===');
  for (const s of strategies) {
    const ratio = s.live_start_capital > 0 && s.target_bankroll > 0 
      ? (s.live_start_capital / s.target_bankroll * 100).toFixed(2) 
      : '?';
    console.log(`${s.target_name.padEnd(20)} bankroll=$${s.target_bankroll.toString().padEnd(8)} ratio=${ratio}% ${s.active ? '✓' : '✗'}`);
  }
  
  db.close();
}

main().catch(console.error);
