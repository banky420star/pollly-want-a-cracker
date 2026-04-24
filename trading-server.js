require('dotenv').config({ path: __dirname + '/.env' });

// Proxy setup — deep-patch axios to route ALL requests through proxy
if (process.env.PROXY_URL) {
  const HttpsProxyAgent = require('https-proxy-agent');
  const HttpProxyAgent = require('http-proxy-agent');
  const proxyUrl = process.env.PROXY_URL;
  const httpsAgent = new HttpsProxyAgent(proxyUrl);
  const httpAgent = new HttpProxyAgent(proxyUrl);

  const axios = require('axios');

  axios.defaults.httpsAgent = httpsAgent;
  axios.defaults.httpAgent = httpAgent;
  axios.defaults.proxy = false;

  const origCreate = axios.create.bind(axios);
  axios.create = function(config = {}) {
    config.httpsAgent = httpsAgent;
    config.httpAgent = httpAgent;
    config.proxy = false;
    return origCreate(config);
  };

  const http = require('http');
  const https = require('https');
  const _origHttpsAgent = https.globalAgent;
  const _origHttpAgent = http.globalAgent;
  http.globalAgent = httpAgent;
  https.globalAgent = httpsAgent;

  const origFetch = globalThis.fetch;
  globalThis.fetch = function(url, opts = {}) {
    if (typeof url === 'string' && url.includes('polymarket.com')) {
      opts.agent = httpsAgent;
    }
    return origFetch(url, opts);
  };

  global._origHttpsAgent = _origHttpsAgent;
  global._origHttpAgent = _origHttpAgent;

  console.log('[PROXY] Routing via:', proxyUrl.replace(/:[^:]+@/, ':***@'));
}

const express = require('express');
const path = require('path');
const { ethers } = require('ethers');
const { ClobClient, Side, OrderType } = require('@polymarket/clob-client');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const HOST = 'https://clob.polymarket.com';
const CHAIN_ID = 137;

const PK = process.env.POLY_PRIVATE_KEY;
const FUNDER_ADDRESS = process.env.FUNDER_ADDRESS || null;
const SIGNATURE_TYPE = Number(process.env.SIGNATURE_TYPE || 1);

if (!PK) {
  console.error('Missing POLY_PRIVATE_KEY in .env');
  process.exit(1);
}

const wallet = new ethers.Wallet(PK);
const TRADING_ADDRESS = FUNDER_ADDRESS || wallet.address;

console.log('Signer wallet:', wallet.address);
console.log('Trading/funder address:', TRADING_ADDRESS);
console.log('Signature type:', SIGNATURE_TYPE);

// ── State ──
let apiCreds = null;
let clobClient = null;

// ── Helper: build Polymarket client ──
function makeClobClient(creds = null, throwOnError = false) {
  return new ClobClient(
    HOST,
    CHAIN_ID,
    wallet,
    creds,
    SIGNATURE_TYPE,
    TRADING_ADDRESS,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    throwOnError
  );
}

// ── Init: derive API creds ──
async function initClient() {
  try {
    const tempClient = makeClobClient(null);
    console.log('[INIT] Deriving API credentials...');
    apiCreds = await tempClient.createOrDeriveApiKey();
    console.log('[INIT] API Key:', apiCreds.key);
    console.log('[INIT] Credentials ready');

    clobClient = makeClobClient({
      key: apiCreds.key,
      secret: apiCreds.secret,
      passphrase: apiCreds.passphrase,
    });

    // Save creds to env file for reuse
    const fs = require('fs');
    const envPath = __dirname + '/.env';
    let env = fs.readFileSync(envPath, 'utf8');
    if (!env.includes('CLOB_API_KEY=')) {
      env += `\nCLOB_API_KEY=${apiCreds.key}\nCLOB_SECRET=${apiCreds.secret}\nCLOB_PASSPHRASE=${apiCreds.passphrase}\n`;
      fs.writeFileSync(envPath, env);
      console.log('[INIT] Saved credentials to .env');
    }

    return true;
  } catch (e) {
    console.error('[INIT] Failed:', e.message);
    return false;
  }
}

// ── Try loading saved creds ──
async function loadOrDerive() {
  if (process.env.CLOB_API_KEY && process.env.CLOB_SECRET && process.env.CLOB_PASSPHRASE) {
    console.log('[INIT] Loading saved API credentials...');
    apiCreds = {
      key: process.env.CLOB_API_KEY,
      secret: process.env.CLOB_SECRET,
      passphrase: process.env.CLOB_PASSPHRASE,
    };
    clobClient = makeClobClient(apiCreds);
    console.log('[INIT] Client ready with saved creds');
    return true;
  }
  return initClient();
}

// ── GAMMA API for market search ──
async function searchMarkets(query) {
  const res = await fetch(`https://gamma-api.polymarket.com/markets?closed=false&limit=10&title_contains=${encodeURIComponent(query)}`);
  return res.json();
}

// ── API Routes ──

app.get('/api/status', (req, res) => {
  res.json({
    signer_wallet: wallet.address,
    trading_wallet: TRADING_ADDRESS,
    connected: !!clobClient,
    hasCredentials: !!apiCreds,
    signatureType: SIGNATURE_TYPE,
  });
});

// ── Polygon provider helper ──
const RPCS = [
  'https://polygon-bor-rpc.publicnode.com',
  'https://polygon.drpc.org',
  'https://polygon.gateway.tenderly.co',
];
const POLYGON_NETWORK = { name: 'matic', chainId: 137 };
const USDC_BRIDGED = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'; // USDC.e
const USDC_NATIVE  = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'; // Native USDC
const CTF_EXCHANGE = '0xC5d563A36AE78145C45a50134d48A1215220f80a';
const NEG_RISK_EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const NEG_RISK_ADAPTER = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';
const CTF_CONTRACT = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
];
const CTF_ABI = [
  'function isApprovedForAll(address,address) view returns (bool)',
  'function setApprovalForAll(address,bool)',
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
  'function balanceOf(address,uint256) view returns (uint256)',
  'function payoutDenominator(bytes32) view returns (uint256)',
  'function payoutNumerators(bytes32,uint256) view returns (uint256)',
];
const NEG_RISK_ADAPTER_ABI = [
  'function redeemPositions(bytes32 conditionId, uint256[] indexSets)',
];

// Custom provider that bypasses proxy for RPC calls
class DirectRpcProvider extends ethers.providers.StaticJsonRpcProvider {
  constructor(url) {
    super({ url, timeout: 10000 }, POLYGON_NETWORK);
    this._directAgent = new (require('https').Agent)({ keepAlive: true });
    this._rpcUrl = url;
  }
  async send(method, params) {
    const body = JSON.stringify({ jsonrpc: '2.0', method, params, id: Date.now() });
    const resp = await globalThis.fetch(this._rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      agent: this._directAgent,
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) throw new Error(`RPC ${resp.status}`);
    const json = await resp.json();
    if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
    return json.result;
  }
}

let providerCache = null;
let providerCacheTime = 0;
let preferredRpcIndex = 0;
const PROVIDER_CACHE_MS = 30000;

async function getProvider() {
  if (providerCache && (Date.now() - providerCacheTime) < PROVIDER_CACHE_MS) {
    return providerCache;
  }

  let lastError = null;
  for (let i = 0; i < RPCS.length; i++) {
    const idx = (preferredRpcIndex + i) % RPCS.length;
    const rpc = RPCS[idx];
    try {
      const p = new DirectRpcProvider(rpc);
      await p.getBlockNumber();
      preferredRpcIndex = idx;
      providerCache = p;
      providerCacheTime = Date.now();
      return p;
    } catch (e) {
      lastError = e;
    }
  }

  providerCache = null;
  providerCacheTime = 0;
  throw new Error(`No working Polygon RPC${lastError ? `: ${lastError.message}` : ''}`);
}

// Gas override for Polygon
const GAS_OVERRIDES = {
  maxPriorityFeePerGas: ethers.utils.parseUnits('40', 'gwei'),
  maxFeePerGas: ethers.utils.parseUnits('250', 'gwei'),
};

// Balance cache
let balanceCache = null;
let balanceCacheTime = 0;
const BALANCE_CACHE_MS = 20000;

async function refreshBalance() {
  try {
    const provider = await getProvider();
    const bridged = new ethers.Contract(USDC_BRIDGED, ERC20_ABI, provider);
    const native  = new ethers.Contract(USDC_NATIVE, ERC20_ABI, provider);

    const [bal1, bal2, signerPol, tradingPol, allow1, allow2, allow3] = await Promise.all([
      bridged.balanceOf(TRADING_ADDRESS),
      native.balanceOf(TRADING_ADDRESS),
      provider.getBalance(wallet.address),
      provider.getBalance(TRADING_ADDRESS),
      bridged.allowance(TRADING_ADDRESS, CTF_EXCHANGE),
      bridged.allowance(TRADING_ADDRESS, NEG_RISK_EXCHANGE),
      bridged.allowance(TRADING_ADDRESS, NEG_RISK_ADAPTER),
    ]);

    const bridgedBal = parseFloat(ethers.utils.formatUnits(bal1, 6));
    const nativeBal = parseFloat(ethers.utils.formatUnits(bal2, 6));

    balanceCache = {
      signer_wallet: wallet.address,
      trading_wallet: TRADING_ADDRESS,
      usdc_bridged: bridgedBal,
      usdc_native: nativeBal,
      usdc: bridgedBal + nativeBal,
      pol: parseFloat(ethers.utils.formatEther(tradingPol)),
      pol_signer: parseFloat(ethers.utils.formatEther(signerPol)),
      allowance_ctf: ethers.utils.formatUnits(allow1, 6),
      allowance_neg_risk: ethers.utils.formatUnits(allow2, 6),
      allowance_adapter: ethers.utils.formatUnits(allow3, 6),
      note: bridgedBal === 0 && nativeBal > 0
        ? 'WARNING: You have native USDC but Polymarket needs USDC.e (bridged). Swap needed!'
        : undefined,
      _cached_at: Date.now(),
    };
    balanceCacheTime = Date.now();
  } catch (e) {
    providerCache = null;
    providerCacheTime = 0;
    console.error('[BALANCE] Refresh error:', e.message);
  }
}

setInterval(refreshBalance, BALANCE_CACHE_MS);
setTimeout(refreshBalance, 1000);

app.get('/api/balance', async (req, res) => {
  try {
    if (balanceCache && (Date.now() - balanceCacheTime) < BALANCE_CACHE_MS * 3) {
      return res.json(balanceCache);
    }

    await refreshBalance();
    if (balanceCache) return res.json(balanceCache);

    const provider = await getProvider();
    const bridged = new ethers.Contract(USDC_BRIDGED, ERC20_ABI, provider);
    const native  = new ethers.Contract(USDC_NATIVE, ERC20_ABI, provider);

    const [bal1, bal2, signerPol, tradingPol, allow1, allow2, allow3] = await Promise.all([
      bridged.balanceOf(TRADING_ADDRESS),
      native.balanceOf(TRADING_ADDRESS),
      provider.getBalance(wallet.address),
      provider.getBalance(TRADING_ADDRESS),
      bridged.allowance(TRADING_ADDRESS, CTF_EXCHANGE),
      bridged.allowance(TRADING_ADDRESS, NEG_RISK_EXCHANGE),
      bridged.allowance(TRADING_ADDRESS, NEG_RISK_ADAPTER),
    ]);

    const bridgedBal = parseFloat(ethers.utils.formatUnits(bal1, 6));
    const nativeBal = parseFloat(ethers.utils.formatUnits(bal2, 6));

    res.json({
      signer_wallet: wallet.address,
      trading_wallet: TRADING_ADDRESS,
      usdc_bridged: bridgedBal,
      usdc_native: nativeBal,
      usdc: bridgedBal + nativeBal,
      pol: parseFloat(ethers.utils.formatEther(tradingPol)),
      pol_signer: parseFloat(ethers.utils.formatEther(signerPol)),
      allowance_ctf: ethers.utils.formatUnits(allow1, 6),
      allowance_neg_risk: ethers.utils.formatUnits(allow2, 6),
      allowance_adapter: ethers.utils.formatUnits(allow3, 6),
      note: bridgedBal === 0 && nativeBal > 0
        ? 'WARNING: You have native USDC but Polymarket needs USDC.e (bridged). Swap needed!'
        : undefined,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── CLOB balance/allowance check ──
app.get('/api/clob-balance', async (req, res) => {
  try {
    if (!clobClient) return res.status(503).json({ error: 'Client not initialized' });
    const bal = await clobClient.getBalanceAllowance({ asset_type: 'COLLATERAL' });
    res.json(bal);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Approve USDC.e for all Polymarket exchange contracts ──
// NOTE: This only works when signer wallet controls the funded wallet.
// If signer and funder differ, on-chain approvals from this script are not supported.
app.post('/api/approve', async (req, res) => {
  try {
    if (TRADING_ADDRESS.toLowerCase() !== wallet.address.toLowerCase()) {
      return res.status(400).json({
        error: 'Separate FUNDER_ADDRESS detected. This route can only approve tokens for the signer wallet. Use a same-wallet setup or extend with proxy-safe approval flow.',
        signer_wallet: wallet.address,
        trading_wallet: TRADING_ADDRESS,
      });
    }

    const provider = await getProvider();
    const signer = wallet.connect(provider);
    const usdc = new ethers.Contract(USDC_BRIDGED, ERC20_ABI, signer);
    const maxApproval = ethers.constants.MaxUint256;
    const results = [];

    for (const [name, addr] of [['CTF Exchange', CTF_EXCHANGE], ['Neg Risk Exchange', NEG_RISK_EXCHANGE], ['Neg Risk Adapter', NEG_RISK_ADAPTER]]) {
      try {
        console.log(`[APPROVE] Approving ${name} (${addr})...`);
        const tx = await usdc.approve(addr, maxApproval, GAS_OVERRIDES);
        console.log(`[APPROVE] ${name} tx: ${tx.hash}`);
        await tx.wait();
        console.log(`[APPROVE] ${name} confirmed!`);
        results.push({ name, tx: tx.hash, status: 'confirmed' });
      } catch (e) {
        console.error(`[APPROVE] ${name} failed:`, e.message);
        results.push({ name, error: e.message });
      }
    }

    const ctf = new ethers.Contract(CTF_CONTRACT, CTF_ABI, signer);
    for (const [name, addr] of [['CTF Exchange', CTF_EXCHANGE], ['Neg Risk Exchange', NEG_RISK_EXCHANGE], ['Neg Risk Adapter', NEG_RISK_ADAPTER]]) {
      try {
        const approved = await ctf.isApprovedForAll(wallet.address, addr);
        if (!approved) {
          console.log(`[APPROVE] Approving CTF for ${name}...`);
          const tx = await ctf.setApprovalForAll(addr, true, GAS_OVERRIDES);
          await tx.wait();
          console.log(`[APPROVE] CTF ${name} confirmed!`);
          results.push({ name: 'CTF-' + name, tx: tx.hash, status: 'confirmed' });
        }
      } catch (e) {
        results.push({ name: 'CTF-' + name, error: e.message });
      }
    }

    try { await clobClient.updateBalanceAllowance({ asset_type: 'COLLATERAL' }); } catch (e) {}
    try { await clobClient.updateBalanceAllowance({ asset_type: 'CONDITIONAL' }); } catch (e) {}

    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Swap native USDC → USDC.e via Uniswap V3 ──
// NOTE: This only works when signer wallet controls the funded wallet.
app.post('/api/swap-usdc', async (req, res) => {
  try {
    if (TRADING_ADDRESS.toLowerCase() !== wallet.address.toLowerCase()) {
      return res.status(400).json({
        error: 'Separate FUNDER_ADDRESS detected. This route only supports swapping for the signer wallet.',
        signer_wallet: wallet.address,
        trading_wallet: TRADING_ADDRESS,
      });
    }

    const { amount } = req.body;
    const provider = await getProvider();
    const signer = wallet.connect(provider);

    const SWAP_ROUTER = '0xE592427A0AEce92De3Edee1F18E0157C05861564';
    const swapAbi = [
      'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)',
    ];
    const amountIn = ethers.utils.parseUnits(String(amount || '10'), 6);

    const nativeUsdc = new ethers.Contract(USDC_NATIVE, ERC20_ABI, signer);
    console.log('[SWAP] Approving native USDC for Uniswap...');
    const approveTx = await nativeUsdc.approve(SWAP_ROUTER, amountIn, GAS_OVERRIDES);
    await approveTx.wait();
    console.log('[SWAP] Approved, swapping...');

    const router = new ethers.Contract(SWAP_ROUTER, swapAbi, signer);
    const deadline = Math.floor(Date.now() / 1000) + 300;
    const swapTx = await router.exactInputSingle({
      tokenIn: USDC_NATIVE,
      tokenOut: USDC_BRIDGED,
      fee: 100,
      recipient: wallet.address,
      deadline,
      amountIn,
      amountOutMinimum: amountIn.mul(995).div(1000),
      sqrtPriceLimitX96: 0,
    }, GAS_OVERRIDES);
    console.log('[SWAP] Swap tx:', swapTx.hash);
    await swapTx.wait();
    console.log('[SWAP] Swap confirmed!');
    res.json({ tx: swapTx.hash, status: 'confirmed' });
  } catch (e) {
    console.error('[SWAP] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Full setup: swap + approve + verify ──
// NOTE: This only works when signer wallet controls the funded wallet.
app.post('/api/setup', async (req, res) => {
  try {
    if (TRADING_ADDRESS.toLowerCase() !== wallet.address.toLowerCase()) {
      return res.status(400).json({
        error: 'Separate FUNDER_ADDRESS detected. This route only supports same-wallet setup. For proxy/funder wallets, fund the proxy and use CLOB trading with funder enabled.',
        signer_wallet: wallet.address,
        trading_wallet: TRADING_ADDRESS,
      });
    }

    const provider = await getProvider();
    const signer = wallet.connect(provider);
    const polBal = await provider.getBalance(wallet.address);
    if (polBal.isZero()) return res.status(400).json({ error: 'No POL for gas! Send ~0.1 POL to ' + wallet.address });

    const native = new ethers.Contract(USDC_NATIVE, ERC20_ABI, signer);
    const bridged = new ethers.Contract(USDC_BRIDGED, ERC20_ABI, signer);
    const nativeBal = await native.balanceOf(wallet.address);
    const bridgedBal = await bridged.balanceOf(wallet.address);
    const steps = [];

    if (nativeBal.gt(0) && bridgedBal.lt(ethers.utils.parseUnits('5', 6))) {
      console.log('[SETUP] Swapping native USDC to USDC.e...');
      const SWAP_ROUTER = '0xE592427A0AEce92De3Edee1F18E0157C05861564';
      const swapAbi = ['function exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160)) external payable returns (uint256)'];

      const appTx = await native.approve(SWAP_ROUTER, nativeBal, GAS_OVERRIDES);
      await appTx.wait();

      const router = new ethers.Contract(SWAP_ROUTER, swapAbi, signer);
      const swapTx = await router.exactInputSingle([
        USDC_NATIVE, USDC_BRIDGED, 100, wallet.address,
        Math.floor(Date.now() / 1000) + 300,
        nativeBal, nativeBal.mul(995).div(1000), 0
      ], GAS_OVERRIDES);
      await swapTx.wait();
      steps.push({ step: 'swap', tx: swapTx.hash, amount: ethers.utils.formatUnits(nativeBal, 6) });
      console.log('[SETUP] Swap done:', swapTx.hash);
    }

    const maxApproval = ethers.constants.MaxUint256;
    for (const [name, addr] of [['CTF Exchange', CTF_EXCHANGE], ['Neg Risk Exchange', NEG_RISK_EXCHANGE], ['Neg Risk Adapter', NEG_RISK_ADAPTER]]) {
      const currentAllowance = await bridged.allowance(wallet.address, addr);
      if (currentAllowance.lt(ethers.utils.parseUnits('1000000', 6))) {
        const tx = await bridged.connect(signer).approve(addr, maxApproval, GAS_OVERRIDES);
        await tx.wait();
        steps.push({ step: 'approve', contract: name, tx: tx.hash });
        console.log(`[SETUP] Approved ${name}:`, tx.hash);
      }
    }

    const ctf = new ethers.Contract(CTF_CONTRACT, CTF_ABI, signer);
    for (const [name, addr] of [['CTF Exchange', CTF_EXCHANGE], ['Neg Risk Exchange', NEG_RISK_EXCHANGE], ['Neg Risk Adapter', NEG_RISK_ADAPTER]]) {
      const approved = await ctf.isApprovedForAll(wallet.address, addr);
      if (!approved) {
        const tx = await ctf.setApprovalForAll(addr, true, GAS_OVERRIDES);
        await tx.wait();
        steps.push({ step: 'approve-ctf', contract: name, tx: tx.hash });
        console.log(`[SETUP] CTF approved for ${name}:`, tx.hash);
      }
    }

    try { await clobClient.updateBalanceAllowance({ asset_type: 'COLLATERAL' }); } catch (e) {}
    try { await clobClient.updateBalanceAllowance({ asset_type: 'CONDITIONAL' }); } catch (e) {}

    const finalBal = await bridged.balanceOf(wallet.address);
    res.json({
      status: 'ready',
      usdc_bridged: ethers.utils.formatUnits(finalBal, 6),
      steps,
    });
  } catch (e) {
    console.error('[SETUP] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/search', async (req, res) => {
  try {
    const q = req.query.q;
    if (!q) return res.json([]);
    const markets = await searchMarkets(q);
    res.json(markets.map(m => {
      const tokenIds = JSON.parse(m.clobTokenIds || '[]');
      const outcomes = JSON.parse(m.outcomes || '[]');
      const prices = JSON.parse(m.outcomePrices || '[]');
      const tokens = tokenIds.map((id, i) => ({
        token_id: id,
        outcome: outcomes[i] || `Outcome ${i}`,
        price: prices[i] || '0',
      }));
      return {
        condition_id: m.conditionId,
        question: m.question,
        slug: m.slug,
        tokens,
        active: m.active,
        closed: m.closed,
        neg_risk: m.negRisk || false,
        minimum_tick_size: m.orderPriceMinTickSize ? String(m.orderPriceMinTickSize) : '0.01',
        image: m.image,
      };
    }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/price/:tokenId', async (req, res) => {
  try {
    const tokenId = req.params.tokenId;
    if (!tokenId || !/^0x[0-9a-f]+$/i.test(tokenId)) {
      return res.status(400).json({ error: 'Invalid token ID format' });
    }
    const tempClient = new ClobClient(HOST, CHAIN_ID);
    const price = await tempClient.getPrice(tokenId, Side.BUY);
    res.json(price);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function fetchAllPositions() {
  const limit = 100;
  const sizeThreshold = '0.0001';
  const positions = [];

  for (let offset = 0; ; ) {
    const url = `https://data-api.polymarket.com/positions?user=${TRADING_ADDRESS}&limit=${limit}&offset=${offset}&sizeThreshold=${sizeThreshold}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Positions API ${r.status}`);

    const batch = await r.json();
    if (!Array.isArray(batch)) throw new Error('Positions API returned non-array payload');

    positions.push(...batch);
    if (batch.length < limit) break;
    offset += batch.length;
  }

  return positions;
}

app.get('/api/positions', async (req, res) => {
  try {
    if (!clobClient) return res.status(503).json({ error: 'Client not initialized' });
    res.json(await fetchAllPositions());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/orders', async (req, res) => {
  try {
    if (!clobClient) return res.status(503).json({ error: 'Client not initialized' });
    const orders = await clobClient.getOpenOrders();
    res.json(orders);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── TRADING ──

app.post('/api/buy', async (req, res) => {
  try {
    if (!clobClient) return res.status(503).json({ error: 'Client not initialized' });
    const { tokenId, price, size, tickSize, negRisk, orderType } = req.body;
    if (!tokenId || !price || !size) return res.status(400).json({ error: 'Missing tokenId, price, size' });

    const ot = orderType === 'FOK' ? OrderType.FOK : orderType === 'GTD' ? OrderType.GTD : OrderType.GTC;
    console.log(`[TRADE] BUY ${size} shares @ $${price} (${ot}) token=${tokenId.slice(0, 10)}...`);

    const orderPayload = { tokenID: tokenId, price: parseFloat(price), side: Side.BUY, size: parseFloat(size) };
    if (ot === OrderType.GTD) orderPayload.expiration = Math.floor(Date.now() / 1000) + 300;

    const resp = await clobClient.createAndPostOrder(
      orderPayload,
      { tickSize: tickSize || '0.01', negRisk: negRisk || false },
      ot
    );

    console.log('[TRADE] Result:', JSON.stringify(resp));
    res.json(resp);
  } catch (e) {
    console.error('[TRADE] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/market-buy', async (req, res) => {
  try {
    if (!clobClient) return res.status(503).json({ error: 'Client not initialized' });
    const { tokenId, amount, tickSize, negRisk, maxSlippage } = req.body;
    if (!tokenId || !amount) return res.status(400).json({ error: 'Missing tokenId, amount' });

    const slippageLimit = parseFloat(maxSlippage) || 0.03;

    // Slippage protection: check order book depth before placing FOK
    try {
      const orderbook = await clobClient.getOrderBook(tokenId);
      const bestAsk = parseFloat(orderbook.asks?.[0]?.price || 0);
      const bestBid = parseFloat(orderbook.bids?.[0]?.price || 0);
      if (bestAsk > 0 && bestBid > 0) {
        const midpoint = (bestAsk + bestBid) / 2;
        const slippage = (bestAsk - midpoint) / midpoint;
        if (slippage > slippageLimit) {
          console.log(`[SLIPPAGE] BUY rejected: bestAsk=${bestAsk} mid=${midpoint.toFixed(4)} slippage=${(slippage*100).toFixed(1)}%`);
          return res.status(400).json({ error: 'Slippage too high', bestAsk, midpoint, slippagePct: (slippage*100).toFixed(2) + '%' });
        }
      } else if (bestAsk === 0) {
        console.log(`[SLIPPAGE] BUY rejected: no asks in order book for token ${tokenId.slice(0,10)}...`);
        return res.status(400).json({ error: 'No asks available in order book' });
      }
    } catch (e) {
      console.error('[SLIPPAGE] Order book check failed, rejecting trade for safety:', e.message);
      return res.status(503).json({ error: 'Order book unavailable, cannot verify slippage', detail: e.message });
    }

    console.log(`[TRADE] MARKET BUY $${amount} token=${tokenId.slice(0, 10)}...`);

    const resp = await clobClient.createAndPostMarketOrder(
      { tokenID: tokenId, amount: parseFloat(amount), side: Side.BUY, orderType: OrderType.FOK },
      { tickSize: tickSize || '0.01', negRisk: negRisk || false },
      OrderType.FOK
    );

    console.log('[TRADE] Result:', JSON.stringify(resp));
    res.json(resp);
  } catch (e) {
    console.error('[TRADE] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/market-sell', async (req, res) => {
  try {
    if (!clobClient) return res.status(503).json({ error: 'Client not initialized' });
    const { tokenId, amount, tickSize, negRisk, maxSlippage } = req.body;
    // Note: 'amount' here is number of shares to sell (taker-amount)
    if (!tokenId || !amount) return res.status(400).json({ error: 'Missing tokenId, amount' });

    const slippageLimit = parseFloat(maxSlippage) || 0.03;

    // Slippage protection: check order book before placing FOK sell
    try {
      const orderbook = await clobClient.getOrderBook(tokenId);
      const bestAsk = parseFloat(orderbook.asks?.[0]?.price || 0);
      const bestBid = parseFloat(orderbook.bids?.[0]?.price || 0);
      if (bestAsk > 0 && bestBid > 0) {
        const midpoint = (bestAsk + bestBid) / 2;
        const slippage = (midpoint - bestBid) / midpoint;
        if (slippage > slippageLimit) {
          console.log(`[SLIPPAGE] SELL rejected: bestBid=${bestBid} mid=${midpoint.toFixed(4)} slippage=${(slippage*100).toFixed(1)}%`);
          return res.status(400).json({ error: 'Slippage too high', bestBid, midpoint, slippagePct: (slippage*100).toFixed(2) + '%' });
        }
      } else if (bestBid === 0) {
        console.log(`[SLIPPAGE] SELL rejected: no bids in order book for token ${tokenId.slice(0,10)}...`);
        return res.status(400).json({ error: 'No bids available in order book' });
      }
    } catch (e) {
      console.error('[SLIPPAGE] Order book check failed, rejecting trade for safety:', e.message);
      return res.status(503).json({ error: 'Order book unavailable, cannot verify slippage', detail: e.message });
    }

    console.log(`[TRADE] MARKET SELL ${amount} shares token=${tokenId.slice(0, 10)}...`);

    const resp = await clobClient.createAndPostMarketOrder(
      { tokenID: tokenId, amount: parseFloat(amount), side: Side.SELL, orderType: OrderType.FOK },
      { tickSize: tickSize || '0.01', negRisk: negRisk || false },
      OrderType.FOK
    );

    console.log('[TRADE] Result:', JSON.stringify(resp));
    res.json(resp);
  } catch (e) {
    console.error('[TRADE] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/sell', async (req, res) => {
  try {
    if (!clobClient) return res.status(503).json({ error: 'Client not initialized' });
    const { tokenId, price, size, tickSize, negRisk } = req.body;
    if (!tokenId || !price || !size) return res.status(400).json({ error: 'Missing tokenId, price, size' });
    if ((parseFloat(price) * parseFloat(size)) < 0.01) {
      return res.json({ skipped: true, reason: 'dust position' });
    }

    console.log(`[TRADE] SELL ${size} shares @ $${price} token=${tokenId.slice(0, 10)}...`);

    const resp = await clobClient.createAndPostOrder(
      { tokenID: tokenId, price: parseFloat(price), side: Side.SELL, size: parseFloat(size) },
      { tickSize: tickSize || '0.01', negRisk: negRisk || false },
      OrderType.GTC
    );

    console.log('[TRADE] Result:', JSON.stringify(resp));
    res.json(resp);
  } catch (e) {
    console.error('[TRADE] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/cancel', async (req, res) => {
  try {
    if (!clobClient) return res.status(503).json({ error: 'Client not initialized' });
    const { orderId } = req.body;
    if (orderId) {
      const resp = await clobClient.cancelOrder({ id: orderId });
      res.json(resp);
    } else {
      const resp = await clobClient.cancelAll();
      res.json(resp);
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Redeem resolved positions ──
// NOTE: This only works when signer wallet controls the funded wallet.
app.post('/api/redeem', async (req, res) => {
  try {
    if (TRADING_ADDRESS.toLowerCase() !== wallet.address.toLowerCase()) {
      return res.status(400).json({
        error: 'Separate FUNDER_ADDRESS detected. This route only supports same-wallet redeem flow.',
        signer_wallet: wallet.address,
        trading_wallet: TRADING_ADDRESS,
      });
    }

    const { conditionId, negRisk } = req.body;
    if (!conditionId) return res.status(400).json({ error: 'conditionId required' });

    const provider = await getProvider();
    const signer = wallet.connect(provider);

    let tx;
    if (negRisk) {
      const adapter = new ethers.Contract(NEG_RISK_ADAPTER, NEG_RISK_ADAPTER_ABI, signer);
      console.log(`[REDEEM] Neg-risk redeem for ${conditionId}...`);
      tx = await adapter.redeemPositions(conditionId, [1, 2], GAS_OVERRIDES);
    } else {
      const ctf = new ethers.Contract(CTF_CONTRACT, CTF_ABI, signer);
      const parentCollectionId = ethers.constants.HashZero;
      console.log(`[REDEEM] Standard redeem for ${conditionId}...`);
      tx = await ctf.redeemPositions(USDC_BRIDGED, parentCollectionId, conditionId, [1, 2], GAS_OVERRIDES);
    }

    console.log(`[REDEEM] tx: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`[REDEEM] Confirmed! Gas used: ${receipt.gasUsed.toString()}`);

    providerCache = null;
    providerCacheTime = 0;
    balanceCacheTime = 0;

    res.json({ tx: tx.hash, status: 'confirmed', gasUsed: receipt.gasUsed.toString() });
  } catch (e) {
    providerCache = null;
    providerCacheTime = 0;
    console.error('[REDEEM] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Redeem all resolved positions at once ──
// NOTE: This only works when signer wallet controls the funded wallet.
app.post('/api/redeem-all', async (req, res) => {
  try {
    if (TRADING_ADDRESS.toLowerCase() !== wallet.address.toLowerCase()) {
      return res.status(400).json({
        error: 'Separate FUNDER_ADDRESS detected. This route only supports same-wallet redeem flow.',
        signer_wallet: wallet.address,
        trading_wallet: TRADING_ADDRESS,
      });
    }

    const { positions } = req.body;
    if (!positions || !positions.length) return res.status(400).json({ error: 'positions array required' });

    const provider = await getProvider();
    const signer = wallet.connect(provider);
    const ctf = new ethers.Contract(CTF_CONTRACT, CTF_ABI, signer);
    const adapter = new ethers.Contract(NEG_RISK_ADAPTER, NEG_RISK_ADAPTER_ABI, signer);

    const results = [];
    for (const pos of positions) {
      try {
        let tx;
        if (pos.negRisk) {
          console.log(`[REDEEM] Neg-risk: ${pos.name || pos.conditionId}...`);
          tx = await adapter.redeemPositions(pos.conditionId, [1, 2], GAS_OVERRIDES);
        } else {
          console.log(`[REDEEM] Standard: ${pos.name || pos.conditionId}...`);
          tx = await ctf.redeemPositions(USDC_BRIDGED, ethers.constants.HashZero, pos.conditionId, [1, 2], GAS_OVERRIDES);
        }
        console.log(`[REDEEM] tx: ${tx.hash}`);
        await tx.wait();
        console.log(`[REDEEM] ${pos.name || pos.conditionId} confirmed!`);
        results.push({ name: pos.name, conditionId: pos.conditionId, tx: tx.hash, status: 'confirmed' });
      } catch (e) {
        providerCache = null;
        providerCacheTime = 0;
        console.error(`[REDEEM] ${pos.name || pos.conditionId} failed:`, e.message);
        results.push({ name: pos.name, conditionId: pos.conditionId, error: e.message });
      }
    }

    providerCache = null;
    providerCacheTime = 0;
    balanceCacheTime = 0;

    res.json({ results });
  } catch (e) {
    console.error('[REDEEM-ALL] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Start ──
(async () => {
  await loadOrDerive();
  app.listen(4002, '0.0.0.0', () => {
    console.log('\n  PM Trading Test running on port 4002\n  http://localhost:4002\n');
  });
})();