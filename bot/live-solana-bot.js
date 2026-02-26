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
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const CANDIDATES = [
  // Tier 1: Highest liquidity (tightest spreads, most reliable)
  { symbol: 'SOL',  mint: WSOL_MINT, tier: 1, avgVolume: 5000000 },
  { symbol: 'JUP',  mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', tier: 1, avgVolume: 2000000 },
  { symbol: 'RAY',  mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', tier: 1, avgVolume: 1500000 },
  { symbol: 'JTO',  mint: 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL', tier: 1, avgVolume: 800000 },
  { symbol: 'PYTH', mint: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3', tier: 1, avgVolume: 600000 },
  // Tier 2: Good liquidity (reliable, varied spreads)
  { symbol: 'BONK', mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6fRdbs8xwYJmwjT', tier: 2, avgVolume: 1200000 },
  { symbol: 'WIF',  mint: 'EKpQGSJtjMFqKZKQanSqYXRcF4fBopz4FY2M8mJv6S6X', tier: 2, avgVolume: 900000 },
  { symbol: 'ORCA', mint: 'orcaEKTdK7LKz57chYcUBIj6Ks3nfu94kQe8fhHXhqE', tier: 2, avgVolume: 500000 },
  { symbol: 'COPE', mint: 'CopeMEMJ8NftXY6CyvPAu6eYJ5HLbJV78k2b6g2vT34f', tier: 2, avgVolume: 400000 },
  { symbol: 'DUST', mint: 'DUSTawucrTsGU8hcqytkap7gCYGkaS78ijehDrgCHogan', tier: 2, avgVolume: 350000 },
  // Tier 3: Emerging/volatile (higher spreads, requires caution)
  { symbol: 'STEP', mint: 'StepAscQoEioFxxWGnh2sLBDFp3KLtVGzta63rWSSDL', tier: 3, avgVolume: 250000 },
  { symbol: 'COPE2', mint: 'COPE2yjVJqsm5e1dygYLtpHxLmMXK4K73K2xM1LYfwBT', tier: 3, avgVolume: 200000 },
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

function pickTradeSizeByEdge(edgeBps, tier = 1, tokenVolume = 1000000) {
  // Dynamic sizing: high edge + high-tier token + good liquidity = scale up
  const volumeFactor = Math.min(tokenVolume / 500000, 2);
  const tierFactor = tier === 1 ? 1.2 : tier === 2 ? 1.0 : 0.7;

  let baseSize = TRADE_SIZE_USDC;
  if (edgeBps >= 500) baseSize = Math.min(TRADE_SIZE_USDC * 3 * volumeFactor * tierFactor, 30);
  else if (edgeBps >= 350) baseSize = Math.min(TRADE_SIZE_USDC * 2 * volumeFactor * tierFactor, 20);
  else if (edgeBps >= 200) baseSize = Math.min(TRADE_SIZE_USDC * 1.5 * volumeFactor * tierFactor, 15);
  else if (edgeBps >= 100) baseSize = Math.min(TRADE_SIZE_USDC * 1.2 * volumeFactor * tierFactor, 10);

  return baseSize;
}

async function jupQuote(inputMint, outputMint, amountAtomic, retries = 2) {
  const u = new URL('https://lite-api.jup.ag/swap/v1/quote');
  u.searchParams.set('inputMint', inputMint);
  u.searchParams.set('outputMint', outputMint);
  u.searchParams.set('amount', String(amountAtomic));
  u.searchParams.set('slippageBps', String(SLIPPAGE_BPS));

  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(u);
      if (!r.ok) {
        if (i < retries) await new Promise(resolve => setTimeout(resolve, 100 * (i + 1)));
        continue;
      }
      return r.json();
    } catch (e) {
      if (i === retries) throw e;
      await new Promise(resolve => setTimeout(resolve, 100 * (i + 1)));
    }
  }
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

async function evaluateRoundTrip(token, tradeSizeUSDC = TRADE_SIZE_USDC, viaSol = false) {
  try {
    // Direct path: USDC -> Token -> USDC
    if (!viaSol) {
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

      return {
        token, q1, q2, usdcBack, grossPnl, edgeBps, netEdgeBps, estimatedCostBps,
        impact1Pct, impact2Pct, tradeSizeUSDC, path: 'direct',
        tier: token.tier || 2, volume: token.avgVolume || 500000
      };
    }

    // Alternative path (for qualified tokens): USDC -> SOL -> Token -> SOL -> USDC
    // Only try this for non-SOL tokens to find additional edges
    if (token.mint === WSOL_MINT) return null;

    const usdcAtomic = Math.floor(tradeSizeUSDC * 1_000_000);
    const q1 = await jupQuote(USDC_MINT, WSOL_MINT, usdcAtomic);
    if (!q1?.outAmount) return null;

    const q2 = await jupQuote(WSOL_MINT, token.mint, Number(q1.outAmount));
    if (!q2?.outAmount) return null;

    const q3 = await jupQuote(token.mint, WSOL_MINT, Number(q2.outAmount));
    if (!q3?.outAmount) return null;

    const q4 = await jupQuote(WSOL_MINT, USDC_MINT, Number(q3.outAmount));
    if (!q4?.outAmount) return null;

    const usdcBack = Number(q4.outAmount) / 1_000_000;
    const grossPnl = usdcBack - tradeSizeUSDC;
    const edgeBps = (grossPnl / tradeSizeUSDC) * 10_000;

    const impacts = [q1, q2, q3, q4].map(q => Math.abs(Number(q.priceImpactPct || 0)));
    const impactBps = impacts.reduce((a, b) => a + b, 0) * 10_000;

    const estimatedCostBps = (SLIPPAGE_BPS * 2) + (JUPITER_FEE_BPS * 2) + EXTRA_SAFETY_BPS + impactBps;
    const netEdgeBps = edgeBps - estimatedCostBps;

    return {
      token, q1, q2, q3, q4, usdcBack, grossPnl, edgeBps, netEdgeBps, estimatedCostBps,
      tradeSizeUSDC, path: 'sol-routed',
      tier: token.tier || 2, volume: token.avgVolume || 500000
    };
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

  // Re-quote with dynamic size before execution (size scales with edge quality and liquidity)
  const dynamicSize = pickTradeSizeByEdge(op.netEdgeBps, op.tier, op.volume);
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
      path: refreshed.path,
      pnlUSDC: Number(refreshed.grossPnl.toFixed(4)),
      totalPnlUSDC: Number(state.pnlUSDC.toFixed(4)),
      tradeSizeUSDC: dynamicSize,
    });
    return true;
  }

  try {
    if (refreshed.path === 'direct') {
      // Direct 2-leg swap
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
        path: 'direct',
        pnlUSDC: Number(pnl.toFixed(4)),
        totalPnlUSDC: Number(state.pnlUSDC.toFixed(4)),
        tradeSizeUSDC: dynamicSize,
      });
    } else if (refreshed.path === 'sol-routed') {
      // SOL-routed 4-leg swap
      const sig1 = await sendSwap((await jupSwapTx(refreshed.q1)).swapTransaction);
      const sig2 = await sendSwap((await jupSwapTx(refreshed.q2)).swapTransaction);
      const sig3 = await sendSwap((await jupSwapTx(refreshed.q3)).swapTransaction);
      const sig4 = await sendSwap((await jupSwapTx(refreshed.q4)).swapTransaction);
      log('swap_legs_done', { symbol: refreshed.token.symbol, sigs: [sig1, sig2, sig3, sig4] });

      const finalBack = Number(refreshed.q4.outAmount) / 1_000_000;
      const pnl = finalBack - dynamicSize;
      state.trades += 1;
      state.wins += pnl >= 0 ? 1 : 0;
      state.losses += pnl < 0 ? 1 : 0;
      state.pnlUSDC += pnl;
      log('live_trade_done', {
        symbol: refreshed.token.symbol,
        path: 'sol-routed',
        pnlUSDC: Number(pnl.toFixed(4)),
        totalPnlUSDC: Number(state.pnlUSDC.toFixed(4)),
        tradeSizeUSDC: dynamicSize,
      });
    }
  } catch (e) {
    log('trade_execution_error', { symbol: refreshed.token.symbol, error: String(e) });
    throw e;
  }

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
    tokenCount: CANDIDATES.length,
  });

  let consecutiveErrors = 0;
  const MAX_CONSECUTIVE_ERRORS = 3;

  while (state.running) {
    try {
      // Check high-liquidity tier-1 tokens first for faster opportunity detection
      const tier1Tokens = CANDIDATES.filter(t => t.tier === 1);
      const otherTokens = CANDIDATES.filter(t => t.tier !== 1);

      // Evaluate direct paths for all tier-1
      const tier1DirectChecks = await Promise.all(
        tier1Tokens.map((t) => evaluateRoundTrip(t, TRADE_SIZE_USDC, false))
      );
      const tier1Ranked = tier1DirectChecks.filter(Boolean).sort((a, b) => b.netEdgeBps - a.netEdgeBps);

      // Only check other tiers if tier-1 opportunity is weak or missing
      const bestTier1 = tier1Ranked[0];
      let allRanked = tier1Ranked;

      if (!bestTier1 || bestTier1.netEdgeBps < MIN_NET_EDGE_BPS * 1.5) {
        // Check direct paths for other tiers
        const otherDirectChecks = await Promise.all(
          otherTokens.map((t) => evaluateRoundTrip(t, TRADE_SIZE_USDC, false))
        );
        const otherRanked = otherDirectChecks.filter(Boolean).sort((a, b) => b.netEdgeBps - a.netEdgeBps);
        allRanked = [...tier1Ranked, ...otherRanked];

        // If still no strong opportunity, check SOL-routed paths for tokens that might benefit
        if (!allRanked[0] || allRanked[0].netEdgeBps < MIN_NET_EDGE_BPS) {
          const solRoutedCandidates = CANDIDATES.filter(t => t.mint !== WSOL_MINT).slice(0, 5);
          const solRoutedChecks = await Promise.all(
            solRoutedCandidates.map((t) => evaluateRoundTrip(t, TRADE_SIZE_USDC, true))
          );
          const solRanked = solRoutedChecks.filter(Boolean).sort((a, b) => b.netEdgeBps - a.netEdgeBps);
          allRanked = [...allRanked, ...solRanked];
        }
      }

      allRanked = allRanked.sort((a, b) => b.netEdgeBps - a.netEdgeBps);
      const best = allRanked[0];

      if (best) {
        if (best.netEdgeBps > -10) {
          log('best_opportunity', {
            symbol: best.token.symbol,
            tier: best.tier,
            path: best.path,
            edgeBps: Number(best.edgeBps.toFixed(2)),
            netEdgeBps: Number(best.netEdgeBps.toFixed(2)),
            estimatedCostBps: Number(best.estimatedCostBps.toFixed(2)),
            expectedPnl: Number(best.grossPnl.toFixed(4)),
          });
        }
        const top3 = allRanked.slice(0, 3);
        const spreadRow = [new Date().toISOString(), ...top3.map(t => `${t.token.symbol}(${t.path}):${t.netEdgeBps.toFixed(2)}`)].join(',');
        fs.appendFileSync(path.join(LOG_DIR, 'spread-tracker.csv'), spreadRow + '\n');

        await maybeTrade(best);
      } else {
        log('no_opportunity', { checkedTokens: CANDIDATES.length });
      }

      consecutiveErrors = 0;
    } catch (e) {
      state.lastError = String(e.message || e);
      log('error', { error: state.lastError, consecutiveErrors });
      consecutiveErrors += 1;

      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        log('stopped_too_many_errors', { error: state.lastError });
        state.running = false;
        break;
      }
    }

    await new Promise(r => setTimeout(r, LOOP_MS));
  }
}

loop().catch(e => {
  console.error(e);
  process.exit(1);
});
