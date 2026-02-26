import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import bs58 from 'bs58';
import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';

// ── Config ──────────────────────────────────────────────────────────────
const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const PRIVATE_KEY = process.env.SOLANA_PRIVATE_KEY;
const DRY_RUN = (process.env.DRY_RUN || 'true').toLowerCase() === 'true';
const LOOP_MS = Number(process.env.BOT_LOOP_MS || 15000);
const TRADE_SIZE_USDC = Number(process.env.TRADE_SIZE_USDC || 5);
const MAX_DAILY_LOSS_USDC = Number(process.env.MAX_DAILY_LOSS_USDC || 3);
const MAX_OPEN_POSITIONS = Number(process.env.MAX_OPEN_POSITIONS || 2);
const SLIPPAGE_BPS = Number(process.env.SLIPPAGE_BPS || 100);

// Momentum entry thresholds (defaults, overridden per-token by calibration)
const MIN_PRICE_CHANGE_PCT = Number(process.env.MIN_PRICE_CHANGE_PCT || 1.5);
const LOOKBACK_SAMPLES = Number(process.env.LOOKBACK_SAMPLES || 12);
const VOLUME_SPIKE_MULT = Number(process.env.VOLUME_SPIKE_MULT || 1.5);

// Exit thresholds (defaults, overridden per-token by calibration)
const TRAILING_STOP_PCT = Number(process.env.TRAILING_STOP_PCT || 1.5);
const TAKE_PROFIT_PCT = Number(process.env.TAKE_PROFIT_PCT || 3.2);
const MAX_HOLD_MS = Number(process.env.MAX_HOLD_MS || 600_000);
const STOP_LOSS_PCT = Number(process.env.STOP_LOSS_PCT || 2.0);

// ── Load calibration from historical data ───────────────────────────────
const CALIBRATION_PATH = path.join(process.cwd(), 'bot', 'data', 'bot-calibration.json');
let calibration = {};
try {
  if (fs.existsSync(CALIBRATION_PATH)) {
    calibration = JSON.parse(fs.readFileSync(CALIBRATION_PATH, 'utf-8'));
    console.log(`Loaded calibration for ${Object.keys(calibration).length} tokens`);
  }
} catch { console.log('No calibration file found, using defaults'); }

function getTokenParam(symbol, param, fallback) {
  return calibration[symbol]?.[param] ?? fallback;
}
function getTokenBestHours(symbol) {
  return calibration[symbol]?.bestHoursUTC || null;
}
function isGoodHourForToken(symbol) {
  const hours = getTokenBestHours(symbol);
  if (!hours || hours.length === 0) return true; // no data = allow all
  const nowUTC = new Date().getUTCHours();
  return hours.includes(nowUTC);
}

// ── Tokens ──────────────────────────────────────────────────────────────
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const CANDIDATES = [
  { symbol: 'BONK', mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6fRdbs8xwYJmwjT' },
  { symbol: 'WIF',  mint: 'EKpQGSJtjMFqKZKQanSqYXRcF4fBopz4FY2M8mJv6S6X' },
  { symbol: 'POPCAT', mint: '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr' },
  { symbol: 'MEW',  mint: 'MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5' },
  { symbol: 'JUP',  mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN' },
  { symbol: 'RAY',  mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R' },
  { symbol: 'JTO',  mint: 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL' },
  { symbol: 'PYTH', mint: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3' },
  { symbol: 'RENDER', mint: 'rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof' },
  { symbol: 'TNSR', mint: 'TNSRxcUxoT9xBG3de7PiJyTDYu7kskLqcpddxnEJAS6' },
];

// ── Wallet ──────────────────────────────────────────────────────────────
if (!PRIVATE_KEY) { console.error('Missing SOLANA_PRIVATE_KEY'); process.exit(1); }
const wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
const connection = new Connection(RPC_URL, 'confirmed');

// ── State ───────────────────────────────────────────────────────────────
const priceHistory = {};  // symbol -> [{price, ts}]
const positions = [];     // [{symbol, mint, entryPrice, entryTs, tokenAmount, highWaterMark, sizeUSDC}]
const state = { trades: 0, wins: 0, losses: 0, pnlUSDC: 0, dailyLoss: 0, dayStart: Date.now() };

const LOG_DIR = path.join(process.cwd(), 'bot', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'momentum-bot-log.jsonl');
fs.mkdirSync(LOG_DIR, { recursive: true });

function log(event, data = {}) {
  const row = { ts: new Date().toISOString(), event, ...data };
  fs.appendFileSync(LOG_FILE, JSON.stringify(row) + '\n');
  console.log(`[${row.ts}] ${event}`, JSON.stringify(data));
}

// ── Jupiter helpers ─────────────────────────────────────────────────────
async function jupQuote(inputMint, outputMint, amountAtomic) {
  const u = new URL('https://lite-api.jup.ag/swap/v1/quote');
  u.searchParams.set('inputMint', inputMint);
  u.searchParams.set('outputMint', outputMint);
  u.searchParams.set('amount', String(amountAtomic));
  u.searchParams.set('slippageBps', String(SLIPPAGE_BPS));
  const r = await fetch(u);
  if (!r.ok) throw new Error(`quote ${r.status}`);
  return r.json();
}

async function jupSwapTx(quoteResponse) {
  const r = await fetch('https://lite-api.jup.ag/swap/v1/swap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse,
      userPublicKey: wallet.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto',
    }),
  });
  if (!r.ok) throw new Error(`swap tx ${r.status}`);
  return r.json();
}

async function sendSwap(base64Tx) {
  const tx = VersionedTransaction.deserialize(Buffer.from(base64Tx, 'base64'));
  tx.sign([wallet]);
  const sig = await connection.sendTransaction(tx, { maxRetries: 3, skipPreflight: false });
  await connection.confirmTransaction(sig, 'confirmed');
  return sig;
}

// ── Price sampling ──────────────────────────────────────────────────────
async function samplePrice(token) {
  try {
    // Get price in USDC terms: how much USDC for 1 unit worth of token
    // Use a small quote to get current rate
    const testAmountUSDC = 1_000_000; // $1
    const q = await jupQuote(USDC_MINT, token.mint, testAmountUSDC);
    if (!q?.outAmount) return null;
    const tokenPer1USDC = Number(q.outAmount);
    // Price = 1/tokenPer1USDC (in USDC per token-atomic-unit... we just track ratio changes)
    return { price: tokenPer1USDC, ts: Date.now() };
  } catch { return null; }
}

function getRecentPriceChangePct(symbol) {
  const hist = priceHistory[symbol];
  if (!hist || hist.length < 3) return 0;
  const oldest = hist[0].price;
  const newest = hist[hist.length - 1].price;
  // More tokens per USDC = token price dropping; fewer = rising
  // We want to detect token price RISING (fewer tokens per USDC = price up)
  // pctChange > 0 means token is getting MORE expensive (bullish)
  return ((oldest - newest) / oldest) * 100;
}

function isMomentumEntry(symbol) {
  // Time-of-day filter from historical data
  if (!isGoodHourForToken(symbol)) return false;

  const entryThreshold = getTokenParam(symbol, 'entryPct', MIN_PRICE_CHANGE_PCT);
  const changePct = getRecentPriceChangePct(symbol);
  if (changePct < entryThreshold) return false;

  // Check it's not just a spike: require at least 55% of recent samples trending same direction
  const hist = priceHistory[symbol];
  if (hist.length < 4) return false;
  let upCount = 0;
  for (let i = 1; i < hist.length; i++) {
    if (hist[i].price < hist[i - 1].price) upCount++; // fewer tokens = price up
  }
  const upRatio = upCount / (hist.length - 1);
  if (upRatio < 0.55) return false;

  // Minimum liquidity filter (skip illiquid tokens)
  const liq = calibration[symbol]?.liquidity || 0;
  if (liq > 0 && liq < 50_000) return false;

  return true;
}

// ── Position management ─────────────────────────────────────────────────
async function openPosition(token) {
  const sizeUSDC = TRADE_SIZE_USDC;
  const usdcAtomic = Math.floor(sizeUSDC * 1_000_000);

  const q = await jupQuote(USDC_MINT, token.mint, usdcAtomic);
  if (!q?.outAmount) return;
  const tokenAmount = Number(q.outAmount);
  const entryPrice = tokenAmount; // tokens per $sizeUSDC

  log('entry_signal', {
    symbol: token.symbol,
    changePct: Number(getRecentPriceChangePct(token.symbol).toFixed(2)),
    sizeUSDC,
    dryRun: DRY_RUN,
  });

  if (!DRY_RUN) {
    const swap = await jupSwapTx(q);
    const sig = await sendSwap(swap.swapTransaction);
    log('entry_executed', { symbol: token.symbol, sig, tokenAmount, sizeUSDC });
  }

  positions.push({
    symbol: token.symbol,
    mint: token.mint,
    entryPrice,
    entryTs: Date.now(),
    tokenAmount,
    highWaterMark: entryPrice,
    sizeUSDC,
  });

  log('position_opened', {
    symbol: token.symbol,
    tokenAmount,
    sizeUSDC,
    openPositions: positions.length,
  });
}

async function checkExits() {
  const toClose = [];

  for (let i = positions.length - 1; i >= 0; i--) {
    const pos = positions[i];
    try {
      // Current value: how much USDC we'd get back
      const q = await jupQuote(pos.mint, USDC_MINT, pos.tokenAmount);
      if (!q?.outAmount) continue;
      const currentUSDC = Number(q.outAmount) / 1_000_000;
      const pnlPct = ((currentUSDC - pos.sizeUSDC) / pos.sizeUSDC) * 100;
      const holdMs = Date.now() - pos.entryTs;

      // Update high water mark
      if (currentUSDC > (pos.highWaterMarkUSDC || pos.sizeUSDC)) {
        pos.highWaterMarkUSDC = currentUSDC;
      }
      const hwm = pos.highWaterMarkUSDC || pos.sizeUSDC;
      const drawdownFromPeakPct = ((hwm - currentUSDC) / hwm) * 100;

      // Per-token calibrated thresholds
      const tokenTP = getTokenParam(pos.symbol, 'takeProfitPct', TAKE_PROFIT_PCT);
      const tokenSL = getTokenParam(pos.symbol, 'stopLossPct', STOP_LOSS_PCT);
      const tokenTrail = getTokenParam(pos.symbol, 'trailingStopPct', TRAILING_STOP_PCT);

      let exitReason = null;

      // Take profit (calibrated per token)
      if (pnlPct >= tokenTP) exitReason = 'take_profit';
      // Stop loss (calibrated per token)
      else if (pnlPct <= -tokenSL) exitReason = 'stop_loss';
      // Trailing stop (calibrated per token)
      else if (hwm > pos.sizeUSDC && drawdownFromPeakPct >= tokenTrail) exitReason = 'trailing_stop';
      // Max hold time
      else if (holdMs >= MAX_HOLD_MS) exitReason = 'max_hold_timeout';

      if (exitReason) {
        toClose.push({ idx: i, pos, currentUSDC, pnlPct, exitReason, holdMs });
      } else {
        log('position_check', {
          symbol: pos.symbol,
          pnlPct: Number(pnlPct.toFixed(2)),
          currentUSDC: Number(currentUSDC.toFixed(4)),
          holdSec: Math.round(holdMs / 1000),
          drawdownFromPeakPct: Number(drawdownFromPeakPct.toFixed(2)),
        });
      }
    } catch (e) {
      log('exit_check_error', { symbol: pos.symbol, error: String(e.message || e) });
    }
  }

  for (const close of toClose) {
    await closePosition(close);
  }
}

async function closePosition({ idx, pos, currentUSDC, pnlPct, exitReason, holdMs }) {
  const pnlUSDC = currentUSDC - pos.sizeUSDC;

  log('exit_signal', {
    symbol: pos.symbol,
    exitReason,
    pnlPct: Number(pnlPct.toFixed(2)),
    pnlUSDC: Number(pnlUSDC.toFixed(4)),
    holdSec: Math.round(holdMs / 1000),
    dryRun: DRY_RUN,
  });

  if (!DRY_RUN) {
    try {
      const q = await jupQuote(pos.mint, USDC_MINT, pos.tokenAmount);
      const swap = await jupSwapTx(q);
      const sig = await sendSwap(swap.swapTransaction);
      log('exit_executed', { symbol: pos.symbol, sig, pnlUSDC: Number(pnlUSDC.toFixed(4)) });
    } catch (e) {
      log('exit_failed', { symbol: pos.symbol, error: String(e.message || e) });
      return; // don't remove position if exit failed
    }
  }

  state.trades++;
  state.pnlUSDC += pnlUSDC;
  if (pnlUSDC >= 0) state.wins++;
  else { state.losses++; state.dailyLoss += Math.abs(pnlUSDC); }

  positions.splice(idx, 1);

  log('position_closed', {
    symbol: pos.symbol,
    exitReason,
    pnlUSDC: Number(pnlUSDC.toFixed(4)),
    totalPnlUSDC: Number(state.pnlUSDC.toFixed(4)),
    winRate: state.trades > 0 ? Number(((state.wins / state.trades) * 100).toFixed(1)) : 0,
    openPositions: positions.length,
  });
}

// ── Cooldown tracker ────────────────────────────────────────────────────
const cooldowns = {}; // symbol -> timestamp of last exit

function isOnCooldown(symbol) {
  const cd = cooldowns[symbol];
  if (!cd) return false;
  return (Date.now() - cd) < 120_000; // 2 min cooldown after exit
}

// ── Main loop ───────────────────────────────────────────────────────────
async function loop() {
  log('momentum_bot_start', {
    wallet: wallet.publicKey.toBase58(),
    dryRun: DRY_RUN,
    loopMs: LOOP_MS,
    tradeSizeUSDC: TRADE_SIZE_USDC,
    maxDailyLossUSDC: MAX_DAILY_LOSS_USDC,
    minPriceChangePct: MIN_PRICE_CHANGE_PCT,
    trailingStopPct: TRAILING_STOP_PCT,
    takeProfitPct: TAKE_PROFIT_PCT,
    stopLossPct: STOP_LOSS_PCT,
    maxHoldMs: MAX_HOLD_MS,
    candidates: CANDIDATES.map(c => c.symbol),
  });

  while (true) {
    // Reset daily loss counter at midnight
    if (Date.now() - state.dayStart > 86_400_000) {
      state.dailyLoss = 0;
      state.dayStart = Date.now();
      log('daily_reset');
    }

    // Daily loss circuit breaker
    if (state.dailyLoss >= MAX_DAILY_LOSS_USDC) {
      log('daily_loss_breaker', { dailyLoss: state.dailyLoss, max: MAX_DAILY_LOSS_USDC });
      await new Promise(r => setTimeout(r, LOOP_MS * 4));
      continue;
    }

    try {
      // 1. Sample all prices
      for (const token of CANDIDATES) {
        const sample = await samplePrice(token);
        if (!sample) continue;
        if (!priceHistory[token.symbol]) priceHistory[token.symbol] = [];
        priceHistory[token.symbol].push(sample);
        // Keep only LOOKBACK_SAMPLES
        if (priceHistory[token.symbol].length > LOOKBACK_SAMPLES) {
          priceHistory[token.symbol] = priceHistory[token.symbol].slice(-LOOKBACK_SAMPLES);
        }
      }

      // 2. Check exits first (protect capital)
      if (positions.length > 0) {
        await checkExits();
      }

      // 3. Look for new entries
      if (positions.length < MAX_OPEN_POSITIONS) {
        const activeSymbols = new Set(positions.map(p => p.symbol));

        for (const token of CANDIDATES) {
          if (activeSymbols.has(token.symbol)) continue;
          if (isOnCooldown(token.symbol)) continue;
          if (positions.length >= MAX_OPEN_POSITIONS) break;

          if (isMomentumEntry(token.symbol)) {
            await openPosition(token);
            break; // one entry per cycle max
          }
        }
      }

      // 4. Status log every cycle
      const topMovers = CANDIDATES
        .map(t => ({ symbol: t.symbol, changePct: getRecentPriceChangePct(t.symbol) }))
        .sort((a, b) => b.changePct - a.changePct)
        .slice(0, 3);

      log('cycle', {
        openPositions: positions.length,
        totalPnlUSDC: Number(state.pnlUSDC.toFixed(4)),
        dailyLoss: Number(state.dailyLoss.toFixed(4)),
        trades: state.trades,
        winRate: state.trades > 0 ? Number(((state.wins / state.trades) * 100).toFixed(1)) : 0,
        topMovers: topMovers.map(m => `${m.symbol}:${m.changePct.toFixed(1)}%`),
      });

    } catch (e) {
      log('loop_error', { error: String(e.message || e) });
    }

    await new Promise(r => setTimeout(r, LOOP_MS));
  }
}

loop().catch(e => { console.error(e); process.exit(1); });
