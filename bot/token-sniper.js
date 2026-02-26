import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import bs58 from 'bs58';
import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';

// ── Config ──────────────────────────────────────────────────────────────
const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const PRIVATE_KEY = process.env.SOLANA_PRIVATE_KEY;
const DRY_RUN = (process.env.DRY_RUN || 'true').toLowerCase() === 'true';
const LOOP_MS = Number(process.env.SNIPER_LOOP_MS || 5000); // 5s — fast scanning for new tokens
const TRADE_SIZE_USDC = Number(process.env.SNIPER_TRADE_SIZE_USDC || 15); // moderate size — new tokens = risky
const MAX_DAILY_LOSS_USDC = Number(process.env.SNIPER_MAX_DAILY_LOSS || 10);
const SLIPPAGE_BPS = Number(process.env.SNIPER_SLIPPAGE_BPS || 150); // higher slippage for new tokens (low liq)

// Sniper-specific thresholds
const MIN_SPREAD_BPS = Number(process.env.SNIPER_MIN_SPREAD_BPS || 200); // 2% min round-trip spread
const MAX_SPREAD_BPS = Number(process.env.SNIPER_MAX_SPREAD_BPS || 5000); // 50% cap (avoid scam tokens)
const MIN_LIQUIDITY_USD = Number(process.env.SNIPER_MIN_LIQUIDITY || 10000); // $10k min liquidity
const MAX_TOKEN_AGE_HOURS = Number(process.env.SNIPER_MAX_AGE_HOURS || 24); // only tokens < 24h old
const MAX_OPEN_SNIPES = Number(process.env.SNIPER_MAX_OPEN || 3);
const TAKE_PROFIT_PCT = Number(process.env.SNIPER_TP_PCT || 8); // 8% TP — new tokens move fast
const STOP_LOSS_PCT = Number(process.env.SNIPER_SL_PCT || 4); // 4% SL
const MAX_HOLD_MS = Number(process.env.SNIPER_MAX_HOLD_MS || 300_000); // 5 min max hold

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

if (!PRIVATE_KEY) { console.error('Missing SOLANA_PRIVATE_KEY'); process.exit(1); }
const wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
const connection = new Connection(RPC_URL, 'confirmed');

// ── State ───────────────────────────────────────────────────────────────
const positions = []; // [{mint, symbol, entryUSDC, tokenAmount, entryTs, sizeUSDC}]
const seenTokens = new Set(); // track already-evaluated tokens to avoid re-sniping
const state = { trades: 0, wins: 0, losses: 0, pnlUSDC: 0, dailyLoss: 0, dayStart: Date.now() };

const LOG_DIR = path.join(process.cwd(), 'bot', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'sniper-log.jsonl');
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
  if (!r.ok) return null;
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
  if (!r.ok) return null;
  return r.json();
}

async function sendSwap(base64Tx) {
  const tx = VersionedTransaction.deserialize(Buffer.from(base64Tx, 'base64'));
  tx.sign([wallet]);
  const sig = await connection.sendTransaction(tx, { maxRetries: 3, skipPreflight: false });
  await connection.confirmTransaction(sig, 'confirmed');
  return sig;
}

// ── DexScreener: discover new tokens ────────────────────────────────────
async function fetchNewTokens() {
  try {
    // DexScreener latest token profiles — returns recently boosted/promoted tokens
    const r = await fetch('https://api.dexscreener.com/token-profiles/latest/v1');
    if (!r.ok) return [];
    const profiles = await r.json();

    // Filter for Solana tokens only
    const solanaTokens = profiles
      .filter(p => p.chainId === 'solana' && p.tokenAddress)
      .map(p => ({ mint: p.tokenAddress, url: p.url }));

    return solanaTokens.slice(0, 20); // cap to 20 to limit API calls
  } catch {
    return [];
  }
}

async function fetchTokenPairData(mint) {
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
    if (!r.ok) return null;
    const j = await r.json();
    const pairs = j?.pairs || [];
    const best = pairs
      .filter(p => p.chainId === 'solana')
      .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    return best || null;
  } catch {
    return null;
  }
}

// ── Evaluate a new token for sniping opportunity ────────────────────────
async function evaluateSnipe(mint) {
  // Get pair data from DexScreener
  const pair = await fetchTokenPairData(mint);
  if (!pair) return null;

  const liquidity = pair.liquidity?.usd || 0;
  const volume24h = pair.volume?.h24 || 0;
  const pairCreatedAt = pair.pairCreatedAt;
  const symbol = pair.baseToken?.symbol || 'UNKNOWN';
  const priceChange5m = pair.priceChange?.m5 || 0;
  const priceChange1h = pair.priceChange?.h1 || 0;

  // Age filter
  if (pairCreatedAt) {
    const ageHours = (Date.now() - pairCreatedAt) / 3_600_000;
    if (ageHours > MAX_TOKEN_AGE_HOURS) return null;
  }

  // Liquidity filter
  if (liquidity < MIN_LIQUIDITY_USD) return null;

  // Quick round-trip spread check via Jupiter
  const usdcAtomic = Math.floor(TRADE_SIZE_USDC * 1_000_000);
  const q1 = await jupQuote(USDC_MINT, mint, usdcAtomic);
  if (!q1?.outAmount) return null;

  const tokenOut = Number(q1.outAmount);
  const q2 = await jupQuote(mint, USDC_MINT, tokenOut);
  if (!q2?.outAmount) return null;

  const usdcBack = Number(q2.outAmount) / 1_000_000;
  const spreadBps = ((usdcBack - TRADE_SIZE_USDC) / TRADE_SIZE_USDC) * 10_000;

  // Spread filters
  if (spreadBps < MIN_SPREAD_BPS) return null;
  if (spreadBps > MAX_SPREAD_BPS) return null; // too wide = likely scam or zero liq

  return {
    mint,
    symbol,
    spreadBps,
    liquidity,
    volume24h,
    priceChange5m,
    priceChange1h,
    q1,
    q2,
    usdcBack,
    tokenOut,
  };
}

// ── Execute snipe (buy + schedule exit monitoring) ──────────────────────
async function executeSnipe(snipe) {
  log('snipe_signal', {
    symbol: snipe.symbol,
    mint: snipe.mint,
    spreadBps: Number(snipe.spreadBps.toFixed(1)),
    liquidity: Math.round(snipe.liquidity),
    priceChange5m: snipe.priceChange5m,
  });

  if (DRY_RUN) {
    // Paper trade: assume we capture the spread
    const pnl = snipe.usdcBack - TRADE_SIZE_USDC;
    state.trades++;
    state.pnlUSDC += pnl;
    if (pnl >= 0) state.wins++; else { state.losses++; state.dailyLoss += Math.abs(pnl); }

    positions.push({
      mint: snipe.mint,
      symbol: snipe.symbol,
      tokenAmount: snipe.tokenOut,
      entryTs: Date.now(),
      sizeUSDC: TRADE_SIZE_USDC,
    });

    log('snipe_paper_trade', {
      symbol: snipe.symbol,
      spreadBps: Number(snipe.spreadBps.toFixed(1)),
      pnlUSDC: Number(pnl.toFixed(4)),
      totalPnlUSDC: Number(state.pnlUSDC.toFixed(4)),
    });
    return;
  }

  // Live: execute buy
  const swap = await jupSwapTx(snipe.q1);
  if (!swap?.swapTransaction) {
    log('snipe_swap_failed', { symbol: snipe.symbol });
    return;
  }
  const sig = await sendSwap(swap.swapTransaction);
  log('snipe_bought', { symbol: snipe.symbol, sig, tokenAmount: snipe.tokenOut });

  positions.push({
    mint: snipe.mint,
    symbol: snipe.symbol,
    tokenAmount: snipe.tokenOut,
    entryTs: Date.now(),
    sizeUSDC: TRADE_SIZE_USDC,
  });
}

// ── Monitor & exit sniped positions ─────────────────────────────────────
async function checkSnipeExits() {
  const toClose = [];

  for (let i = positions.length - 1; i >= 0; i--) {
    const pos = positions[i];
    try {
      const q = await jupQuote(pos.mint, USDC_MINT, pos.tokenAmount);
      if (!q?.outAmount) continue;

      const currentUSDC = Number(q.outAmount) / 1_000_000;
      const pnlPct = ((currentUSDC - pos.sizeUSDC) / pos.sizeUSDC) * 100;
      const holdMs = Date.now() - pos.entryTs;

      let exitReason = null;
      if (pnlPct >= TAKE_PROFIT_PCT) exitReason = 'take_profit';
      else if (pnlPct <= -STOP_LOSS_PCT) exitReason = 'stop_loss';
      else if (holdMs >= MAX_HOLD_MS) exitReason = 'max_hold';

      if (exitReason) {
        toClose.push({ idx: i, pos, currentUSDC, pnlPct, exitReason, holdMs });
      } else {
        log('snipe_hold', {
          symbol: pos.symbol,
          pnlPct: Number(pnlPct.toFixed(2)),
          holdSec: Math.round(holdMs / 1000),
        });
      }
    } catch (e) {
      log('snipe_exit_check_error', { symbol: pos.symbol, error: String(e.message || e) });
    }
  }

  for (const close of toClose) {
    const { idx, pos, currentUSDC, pnlPct, exitReason, holdMs } = close;
    const pnlUSDC = currentUSDC - pos.sizeUSDC;

    log('snipe_exit_signal', {
      symbol: pos.symbol,
      exitReason,
      pnlPct: Number(pnlPct.toFixed(2)),
      pnlUSDC: Number(pnlUSDC.toFixed(4)),
      holdSec: Math.round(holdMs / 1000),
    });

    if (!DRY_RUN) {
      try {
        const q = await jupQuote(pos.mint, USDC_MINT, pos.tokenAmount);
        const swap = await jupSwapTx(q);
        if (swap?.swapTransaction) {
          const sig = await sendSwap(swap.swapTransaction);
          log('snipe_exit_executed', { symbol: pos.symbol, sig });
        }
      } catch (e) {
        log('snipe_exit_failed', { symbol: pos.symbol, error: String(e.message || e) });
        continue;
      }
    }

    state.trades++;
    state.pnlUSDC += pnlUSDC;
    if (pnlUSDC >= 0) state.wins++; else { state.losses++; state.dailyLoss += Math.abs(pnlUSDC); }
    positions.splice(idx, 1);

    log('snipe_closed', {
      symbol: pos.symbol,
      exitReason,
      pnlUSDC: Number(pnlUSDC.toFixed(4)),
      totalPnlUSDC: Number(state.pnlUSDC.toFixed(4)),
      winRate: state.trades > 0 ? Number(((state.wins / state.trades) * 100).toFixed(1)) : 0,
    });
  }
}

// ── Main loop ───────────────────────────────────────────────────────────
async function loop() {
  log('sniper_start', {
    wallet: wallet.publicKey.toBase58(),
    dryRun: DRY_RUN,
    loopMs: LOOP_MS,
    tradeSizeUSDC: TRADE_SIZE_USDC,
    minSpreadBps: MIN_SPREAD_BPS,
    maxTokenAgeHours: MAX_TOKEN_AGE_HOURS,
    minLiquidity: MIN_LIQUIDITY_USD,
  });

  while (true) {
    // Daily loss reset
    if (Date.now() - state.dayStart > 86_400_000) {
      state.dailyLoss = 0;
      state.dayStart = Date.now();
      log('daily_reset');
    }

    // Circuit breaker
    if (state.dailyLoss >= MAX_DAILY_LOSS_USDC) {
      log('sniper_daily_loss_breaker', { dailyLoss: state.dailyLoss });
      await new Promise(r => setTimeout(r, LOOP_MS * 6));
      continue;
    }

    try {
      // 1. Check exits on open positions first
      if (positions.length > 0) {
        await checkSnipeExits();
      }

      // 2. Discover new tokens
      if (positions.length < MAX_OPEN_SNIPES) {
        const newTokens = await fetchNewTokens();
        const unseenTokens = newTokens.filter(t => !seenTokens.has(t.mint));

        for (const token of unseenTokens) {
          seenTokens.add(token.mint);
          if (positions.length >= MAX_OPEN_SNIPES) break;

          // Don't snipe tokens we already hold
          if (positions.some(p => p.mint === token.mint)) continue;

          const snipe = await evaluateSnipe(token.mint);
          if (snipe) {
            await executeSnipe(snipe);
          }
        }

        // Evict old seen tokens to prevent memory growth (keep last 500)
        if (seenTokens.size > 500) {
          const arr = [...seenTokens];
          for (let i = 0; i < arr.length - 500; i++) seenTokens.delete(arr[i]);
        }
      }

      // 3. Status log
      log('sniper_cycle', {
        openSnipes: positions.length,
        totalPnlUSDC: Number(state.pnlUSDC.toFixed(4)),
        trades: state.trades,
        winRate: state.trades > 0 ? Number(((state.wins / state.trades) * 100).toFixed(1)) : 0,
        seenTokens: seenTokens.size,
      });

    } catch (e) {
      log('sniper_error', { error: String(e.message || e) });
    }

    await new Promise(r => setTimeout(r, LOOP_MS));
  }
}

loop().catch(e => { console.error(e); process.exit(1); });
