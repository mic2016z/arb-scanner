import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import bs58 from 'bs58';
import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';

const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const PRIVATE_KEY = process.env.SOLANA_PRIVATE_KEY;
const DRY_RUN = (process.env.DRY_RUN || 'false').toLowerCase() === 'true';
const LOOP_MS = Number(process.env.BOT_LOOP_MS || 20000);
const MIN_EDGE_BPS = Number(process.env.MIN_EDGE_BPS || 120); // 1.2%
const SLIPPAGE_BPS = Number(process.env.SLIPPAGE_BPS || 80); // 0.8%
const TRADE_SIZE_USDC = Number(process.env.TRADE_SIZE_USDC || 5);
const MAX_DAILY_LOSS_USDC = Number(process.env.MAX_DAILY_LOSS_USDC || 5);

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const CANDIDATES = [
  { symbol: 'BONK', mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6fRdbs8xwYJmwjT' },
  { symbol: 'WIF', mint: 'EKpQGSJtjMFqKZKQanSqYXRcF4fBopz4FY2M8mJv6S6X' },
  { symbol: 'BOME', mint: 'ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82' },
  { symbol: 'POPCAT', mint: '7GCihQ2C57cYFQnD6V9eN2QvPsvBLmvBxG29BAsoAhhW' },
  { symbol: 'MEW', mint: 'MEW1gQW9h1VGnJow66YwW6fQ6E7eg8A4N5dPvJEa3TB' }
];

if (!PRIVATE_KEY) {
  console.error('Missing SOLANA_PRIVATE_KEY in environment');
  process.exit(1);
}

const secret = bs58.decode(PRIVATE_KEY);
const wallet = Keypair.fromSecretKey(secret);
const connection = new Connection(RPC_URL, 'confirmed');

const state = {
  startedAt: Date.now(),
  wins: 0,
  losses: 0,
  trades: 0,
  pnlUSDC: 0,
  lastError: null,
  running: true,
};

const LOG_DIR = path.join(process.cwd(), 'bot', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'live-bot-log.jsonl');
fs.mkdirSync(LOG_DIR, { recursive: true });

function log(event, data = {}) {
  const row = { ts: new Date().toISOString(), event, ...data };
  fs.appendFileSync(LOG_FILE, JSON.stringify(row) + '\n');
  console.log(`[${row.ts}] ${event}`, data);
}

async function jupQuote(inputMint, outputMint, amountAtomic) {
  const u = new URL('https://lite-api.jup.ag/swap/v1/quote');
  u.searchParams.set('inputMint', inputMint);
  u.searchParams.set('outputMint', outputMint);
  u.searchParams.set('amount', String(amountAtomic));
  u.searchParams.set('slippageBps', String(SLIPPAGE_BPS));
  const r = await fetch(u);
  if (!r.ok) throw new Error(`quote failed ${r.status}`);
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
  if (!r.ok) throw new Error(`swap tx failed ${r.status}`);
  return r.json();
}

async function sendSwap(base64Tx) {
  const tx = VersionedTransaction.deserialize(Buffer.from(base64Tx, 'base64'));
  tx.sign([wallet]);
  const sig = await connection.sendTransaction(tx, { maxRetries: 3, skipPreflight: false });
  await connection.confirmTransaction(sig, 'confirmed');
  return sig;
}

async function evaluateRoundTrip(token) {
  try {
    const usdcAtomic = Math.floor(TRADE_SIZE_USDC * 1_000_000);
    const q1 = await jupQuote(USDC_MINT, token.mint, usdcAtomic);
    if (!q1?.outAmount) return null;
    const tokenOut = Number(q1.outAmount);

    const q2 = await jupQuote(token.mint, USDC_MINT, tokenOut);
    if (!q2?.outAmount) return null;
    const usdcBack = Number(q2.outAmount) / 1_000_000;

    const grossPnl = usdcBack - TRADE_SIZE_USDC;
    const edgeBps = (grossPnl / TRADE_SIZE_USDC) * 10_000;

    return { token, q1, q2, usdcBack, grossPnl, edgeBps };
  } catch {
    return null;
  }
}

async function maybeTrade(op) {
  if (!op || op.edgeBps < MIN_EDGE_BPS) return false;

  if (state.pnlUSDC <= -MAX_DAILY_LOSS_USDC) {
    state.running = false;
    log('stopped_daily_loss', { pnlUSDC: state.pnlUSDC });
    return false;
  }

  log('signal', {
    symbol: op.token.symbol,
    edgeBps: Number(op.edgeBps.toFixed(2)),
    expectedPnl: Number(op.grossPnl.toFixed(4)),
    dryRun: DRY_RUN,
  });

  if (DRY_RUN) {
    state.trades += 1;
    state.wins += op.grossPnl >= 0 ? 1 : 0;
    state.losses += op.grossPnl < 0 ? 1 : 0;
    state.pnlUSDC += op.grossPnl;
    log('paper_trade', {
      symbol: op.token.symbol,
      pnlUSDC: Number(op.grossPnl.toFixed(4)),
      totalPnlUSDC: Number(state.pnlUSDC.toFixed(4)),
    });
    return true;
  }

  // live two-leg execution (non-atomic): safest tiny size only
  const swap1 = await jupSwapTx(op.q1);
  const sig1 = await sendSwap(swap1.swapTransaction);
  log('swap_leg_1_done', { symbol: op.token.symbol, sig: sig1 });

  const refreshBack = await jupQuote(op.token.mint, USDC_MINT, Number(op.q1.outAmount));
  const swap2 = await jupSwapTx(refreshBack);
  const sig2 = await sendSwap(swap2.swapTransaction);
  log('swap_leg_2_done', { symbol: op.token.symbol, sig: sig2 });

  const finalBack = Number(refreshBack.outAmount) / 1_000_000;
  const pnl = finalBack - TRADE_SIZE_USDC;
  state.trades += 1;
  state.wins += pnl >= 0 ? 1 : 0;
  state.losses += pnl < 0 ? 1 : 0;
  state.pnlUSDC += pnl;
  log('live_trade_done', {
    symbol: op.token.symbol,
    pnlUSDC: Number(pnl.toFixed(4)),
    totalPnlUSDC: Number(state.pnlUSDC.toFixed(4)),
  });

  return true;
}

async function loop() {
  log('bot_start', {
    wallet: wallet.publicKey.toBase58(),
    dryRun: DRY_RUN,
    loopMs: LOOP_MS,
    minEdgeBps: MIN_EDGE_BPS,
    tradeSizeUSDC: TRADE_SIZE_USDC,
  });

  while (state.running) {
    try {
      const checks = await Promise.all(CANDIDATES.map(evaluateRoundTrip));
      const best = checks.filter(Boolean).sort((a, b) => b.edgeBps - a.edgeBps)[0];

      if (best) {
        log('best_opportunity', {
          symbol: best.token.symbol,
          edgeBps: Number(best.edgeBps.toFixed(2)),
          expectedPnl: Number(best.grossPnl.toFixed(4)),
        });
        await maybeTrade(best);
      } else {
        log('no_opportunity');
      }
    } catch (e) {
      state.lastError = String(e.message || e);
      log('error', { error: state.lastError });
    }

    await new Promise(r => setTimeout(r, LOOP_MS));
  }
}

loop().catch(e => {
  console.error(e);
  process.exit(1);
});
