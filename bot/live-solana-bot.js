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
const MIN_NET_EDGE_BPS = Number(process.env.MIN_NET_EDGE_BPS || 90); // require >=0.9% after costs
const JUPITER_FEE_BPS = Number(process.env.JUPITER_FEE_BPS || 12); // round-trip approx buffer
const EXTRA_SAFETY_BPS = Number(process.env.EXTRA_SAFETY_BPS || 25); // latency/MEV buffer
const MAX_PRICE_IMPACT_PCT = Number(process.env.MAX_PRICE_IMPACT_PCT || 0.35); // per leg

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const CANDIDATES = [
  // High-liquidity tokens (tighter spreads, realistic arb edge)
  { symbol: 'SOL',  mint: 'So11111111111111111111111111111111111111112' },
  { symbol: 'JUP',  mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN' },
  { symbol: 'RAY',  mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R' },
  { symbol: 'JTO',  mint: 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL' },
  { symbol: 'PYTH', mint: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3' },
  // Meme coins (wider spreads but potential vol spikes)
  { symbol: 'BONK', mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6fRdbs8xwYJmwjT' },
  { symbol: 'WIF',  mint: 'EKpQGSJtjMFqKZKQanSqYXRcF4fBopz4FY2M8mJv6S6X' },
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

function pickTradeSizeByEdge(edgeBps) {
  // copy proven pattern from profitable bots: size scales only when signal quality is strong
  if (edgeBps >= 450) return Math.min(TRADE_SIZE_USDC * 2, 20);
  if (edgeBps >= 300) return Math.min(TRADE_SIZE_USDC * 1.5, 12);
  return TRADE_SIZE_USDC;
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

async function evaluateRoundTrip(token, tradeSizeUSDC = TRADE_SIZE_USDC) {
  try {
    const usdcAtomic = Math.floor(tradeSizeUSDC * 1_000_000);
    const q1 = await jupQuote(USDC_MINT, token.mint, usdcAtomic);
    if (!q1?.outAmount) return null;
    const tokenOut = Number(q1.outAmount);

    const q2 = await jupQuote(token.mint, USDC_MINT, tokenOut);
    if (!q2?.outAmount) return null;
    const usdcBack = Number(q2.outAmount) / 1_000_000;

    const grossPnl = usdcBack - tradeSizeUSDC;
    const edgeBps = (grossPnl / tradeSizeUSDC) * 10_000;

    const impact1Pct = Math.abs(Number(q1.priceImpactPct || 0));
    const impact2Pct = Math.abs(Number(q2.priceImpactPct || 0));
    const impactBps = (impact1Pct + impact2Pct) * 10_000;

    const estimatedCostBps = (SLIPPAGE_BPS * 1.2) + JUPITER_FEE_BPS + EXTRA_SAFETY_BPS + impactBps;
    const netEdgeBps = edgeBps - estimatedCostBps;

    return { token, q1, q2, usdcBack, grossPnl, edgeBps, netEdgeBps, estimatedCostBps, impact1Pct, impact2Pct, tradeSizeUSDC };
  } catch {
    return null;
  }
}

async function maybeTrade(op) {
  if (!op) return false;

  // HARD GUARDS: only trade if both gross and net edge are solid
  if (op.edgeBps <= 0 || op.netEdgeBps <= 0) {
    log('blocked_negative_edge', {
      symbol: op.token.symbol,
      edgeBps: Number(op.edgeBps.toFixed(2)),
      netEdgeBps: Number(op.netEdgeBps.toFixed(2)),
    });
    return false;
  }
  if (op.edgeBps < MIN_EDGE_BPS || op.netEdgeBps < MIN_NET_EDGE_BPS) {
    log('blocked_below_threshold', {
      symbol: op.token.symbol,
      edgeBps: Number(op.edgeBps.toFixed(2)),
      netEdgeBps: Number(op.netEdgeBps.toFixed(2)),
      minEdgeBps: MIN_EDGE_BPS,
      minNetEdgeBps: MIN_NET_EDGE_BPS,
    });
    return false;
  }
  if (op.impact1Pct > MAX_PRICE_IMPACT_PCT || op.impact2Pct > MAX_PRICE_IMPACT_PCT) {
    log('blocked_price_impact', {
      symbol: op.token.symbol,
      impact1Pct: op.impact1Pct,
      impact2Pct: op.impact2Pct,
      maxPriceImpactPct: MAX_PRICE_IMPACT_PCT,
    });
    return false;
  }

  if (state.pnlUSDC <= -MAX_DAILY_LOSS_USDC) {
    state.running = false;
    log('stopped_daily_loss', { pnlUSDC: state.pnlUSDC });
    return false;
  }

  // Re-quote with dynamic size before execution
  const dynamicSize = pickTradeSizeByEdge(op.netEdgeBps);
  const refreshed = await evaluateRoundTrip(op.token, dynamicSize);
  if (!refreshed || refreshed.netEdgeBps < MIN_NET_EDGE_BPS) {
    log('blocked_requote_decay', {
      symbol: op.token.symbol,
      beforeNetEdgeBps: Number(op.netEdgeBps.toFixed(2)),
      afterNetEdgeBps: refreshed ? Number(refreshed.netEdgeBps.toFixed(2)) : null,
      tradeSizeUSDC: dynamicSize,
    });
    return false;
  }

  log('signal', {
    symbol: refreshed.token.symbol,
    edgeBps: Number(refreshed.edgeBps.toFixed(2)),
    netEdgeBps: Number(refreshed.netEdgeBps.toFixed(2)),
    estimatedCostBps: Number(refreshed.estimatedCostBps.toFixed(2)),
    expectedPnl: Number(refreshed.grossPnl.toFixed(4)),
    tradeSizeUSDC: dynamicSize,
    dryRun: DRY_RUN,
  });

  if (DRY_RUN) {
    state.trades += 1;
    state.wins += refreshed.grossPnl >= 0 ? 1 : 0;
    state.losses += refreshed.grossPnl < 0 ? 1 : 0;
    state.pnlUSDC += refreshed.grossPnl;
    log('paper_trade', {
      symbol: refreshed.token.symbol,
      pnlUSDC: Number(refreshed.grossPnl.toFixed(4)),
      totalPnlUSDC: Number(state.pnlUSDC.toFixed(4)),
      tradeSizeUSDC: dynamicSize,
    });
    return true;
  }

  const swap1 = await jupSwapTx(refreshed.q1);
  const sig1 = await sendSwap(swap1.swapTransaction);
  log('swap_leg_1_done', { symbol: refreshed.token.symbol, sig: sig1, tradeSizeUSDC: dynamicSize });

  const refreshBack = await jupQuote(refreshed.token.mint, USDC_MINT, Number(refreshed.q1.outAmount));
  const swap2 = await jupSwapTx(refreshBack);
  const sig2 = await sendSwap(swap2.swapTransaction);
  log('swap_leg_2_done', { symbol: refreshed.token.symbol, sig: sig2 });

  const finalBack = Number(refreshBack.outAmount) / 1_000_000;
  const pnl = finalBack - dynamicSize;
  state.trades += 1;
  state.wins += pnl >= 0 ? 1 : 0;
  state.losses += pnl < 0 ? 1 : 0;
  state.pnlUSDC += pnl;
  log('live_trade_done', {
    symbol: refreshed.token.symbol,
    pnlUSDC: Number(pnl.toFixed(4)),
    totalPnlUSDC: Number(state.pnlUSDC.toFixed(4)),
    tradeSizeUSDC: dynamicSize,
  });

  return true;
}

async function loop() {
  log('bot_start', {
    wallet: wallet.publicKey.toBase58(),
    dryRun: DRY_RUN,
    loopMs: LOOP_MS,
    minEdgeBps: MIN_EDGE_BPS,
    minNetEdgeBps: MIN_NET_EDGE_BPS,
    maxPriceImpactPct: MAX_PRICE_IMPACT_PCT,
    tradeSizeUSDC: TRADE_SIZE_USDC,
  });

  while (state.running) {
    try {
      const checks = await Promise.all(CANDIDATES.map((t) => evaluateRoundTrip(t, TRADE_SIZE_USDC)));
      const ranked = checks.filter(Boolean).sort((a, b) => b.netEdgeBps - a.netEdgeBps);
      const best = ranked[0];

      if (best) {
        if (best.netEdgeBps > -10) {
          log('best_opportunity', {
            symbol: best.token.symbol,
            edgeBps: Number(best.edgeBps.toFixed(2)),
            netEdgeBps: Number(best.netEdgeBps.toFixed(2)),
            estimatedCostBps: Number(best.estimatedCostBps.toFixed(2)),
            expectedPnl: Number(best.grossPnl.toFixed(4)),
          });
        }
        const top3 = ranked.slice(0, 3);
        const spreadRow = [new Date().toISOString(), ...top3.map(t => `${t.token.symbol}:${t.netEdgeBps.toFixed(2)}`)].join(',');
        fs.appendFileSync(path.join(LOG_DIR, 'spread-tracker.csv'), spreadRow + '\n');

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
