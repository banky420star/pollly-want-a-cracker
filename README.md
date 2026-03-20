# Polymarket CopyTrader

Automated copy-trading bot for [Polymarket](https://polymarket.com) prediction markets. Monitors top traders, mirrors their positions, and manages a live portfolio on Polygon.

## Architecture

Two separate servers work together:

### CopyTrade Server (port 4000)
The brain — polls Polymarket for trader activity, decides what to copy, manages paper trading and live execution.

- **Paper trading**: Simulates trades with virtual money to test strategies risk-free
- **Live trading**: Executes real $1 market orders (FOK) via the trading server
- **Multi-strategy**: Run multiple copy-trading strategies simultaneously (e.g. follow different traders)
- **Dashboard**: Real-time web UI showing positions, P&L, portfolio history, and trade log
- **Per-strategy dashboards**: Filter by strategy via `?strategy=RN1` or `?strategy=geniusMC`

### Trading Server (port 4001)
The executor — handles all on-chain operations and Polymarket CLOB API interaction.

- **CLOB client**: Authenticated connection to Polymarket's Central Limit Order Book
- **Market orders**: FOK (Fill or Kill) orders with $1 minimum, no share minimum
- **Wallet management**: USDC.e balance, approvals, position tracking
- **Proxy support**: Routes CLOB API through proxy (for geo-restricted regions) while keeping Polygon RPC direct

## Tech Stack

- **Runtime**: Node.js
- **Server**: Express
- **Database**: SQLite (better-sqlite3)
- **Frontend**: Vanilla HTML/CSS/JS (no framework)
- **Blockchain**: Polygon via ethers.js
- **Trading**: Polymarket CLOB API (`@polymarket/clob-client`)

## Setup

### Prerequisites
- Node.js 18+
- A Polygon wallet with USDC.e (bridged USDC)
- Polymarket API credentials

### Environment Variables

Create a `.env` file for the trading server:

```
PRIVATE_KEY=your_polygon_private_key
POLYMARKET_API_KEY=your_api_key
POLYMARKET_SECRET=your_secret
POLYMARKET_PASSPHRASE=your_passphrase
PROXY_URL=socks5://user:pass@host:port  # optional, for geo-restricted regions
```

### Install & Run

```bash
# Install dependencies
npm install

# CopyTrade server (port 4000)
node server.js

# Trading server (port 4001) — in a separate terminal
node trading-server.js
```

### PM2 (Production)

```bash
pm2 start server.js --name polymarket-copytrade
pm2 start trading-server.js --name polymarket-trading
```

## Dashboard

- **Paper trading**: `http://localhost:4000/`
- **Live trading**: `http://localhost:4000/live.html`
- **Per strategy**: `http://localhost:4000/live.html?strategy=RN1`

## How It Works

1. **Poll**: Every 5 seconds, checks configured traders' recent activity on Polymarket
2. **Analyze**: Compares with existing positions to avoid duplicates
3. **Paper trade**: Logs a simulated trade for backtesting
4. **Live execute**: If live trading is enabled, sends a $1 market order via the trading server
5. **Track**: Records all trades, snapshots positions periodically, builds portfolio history

## Dev Notes

- Market orders (FOK) are used instead of limit orders (GTC) because GTC has a 5-share minimum that blocks small trades
- The duplicate check prevents buying more of a token you already hold a position on
- Both strategies share one wallet — positions are attributed per strategy by matching token IDs from the trade log
- The `swap-usdc.js` utility swaps native USDC to USDC.e (bridged) via Uniswap V3 — Polymarket only accepts USDC.e
- For geo-restricted regions: CLOB API routes through a SOCKS5 proxy, but Polygon RPCs use a custom `DirectRpcProvider` to bypass the proxy (RPCs fail through proxy)

## Results

Started with $26 total deposit. Currently running two strategies (RN1 and geniusMC) placing $1 bets on prediction markets. The bot runs 24/7 and compounds winnings automatically.
