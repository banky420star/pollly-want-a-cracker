# Profit Orchestrator - $100M Agent

An autonomous profit-seeking agent for Polymarket designed to compound from any starting balance to $100M.

## Quick Start

```bash
# Start everything
node trading-server.js &  # Trading server (port 4002)
node orchestrator/bot.js & # Orchestrator (port 4003)

# Start the $100M agent
curl -X POST http://localhost:4003/api/orchestrator/agent/start
```

## Agent Endpoints

```bash
# Status & Control
curl http://localhost:4003/api/orchestrator/progress         # $100M progress
curl http://localhost:4003/api/orchestrator/agent/status  # Agent status
curl -X POST http://localhost:4003/api/orchestrator/agent/start
curl -X POST http://localhost:4003/api/orchestrator/agent/stop

# Configuration
curl -X POST http://localhost:4003/api/orchestrator/target \
  -H "Content-Type: application/json" \
  -d '{"targetProfit":100000000,"compoundRate":1.5,"leverage":5}'
```

## Environment Variables

```bash
# Agent settings
MIN_CONFIDENCE=0.52           # Lower = more trades
MAX_BET=50                # Max bet size
MIN_BET=0.50             # Min bet
BASE_BET=1                

# Performance  
COMPOUND_RATE=1.5           # Leverage multiplier after wins
ORCHESTRATOR_CYCLE_MS=15000   # Cycles every 15s

# Trading server
TRADING_SERVER_URL=http://127.0.0.1:4002
ORCHESTRATOR_PORT=4003
```

## Current Status

- **Agent**: Running on port 4003
- **Cycle**: Every 15 seconds
- **Markets**: 20 search topics
- **Target**: $100,000,000
- **Strategy**: Kelly Criterion + Sentiment + Pattern Learning

## Architecture

```
Cycle (15s):
  1. Search 20 market topics
  2. Fetch news/sentiment
  3. Check learned patterns
  4. Calculate confidence
  5. Execute up to 10 trades
  6. Manage existing positions
  7. Compound on wins
```

## Required: Capital

Current balance is **$0.41**. To reach $100M:

1. **Fund the trading wallet** (0x2302703692dfb6d4f7c02cc32a36a6e75cada4d2) with USDC.e on Polygon
2. **Start the agent** and let it compound

The agent works with any balance - it will compound aggressively (1.5x leverage multiplier after wins) to grow to $100M.