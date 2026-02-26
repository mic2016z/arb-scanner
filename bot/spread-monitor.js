// Standalone spread monitor — no wallet key needed
// Collects round-trip spread data on candidates to find if positive edge exists
import fs from 'node:fs';
import path from 'node:path';

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TRADE_SIZE_USDC = Number(process.env.TRADE_SIZE_USDC || 25); // match live bot size
const SLIPPAGE_BPS = Number(process.env.SLIPPAGE_BPS || 50); // match live bot slippage
const LOOP_MS = Number(process.env.MONITOR_LOOP_MS || 30000);
const MAX_CYCLES = Number(process.env.MAX_CYCLES || 200);

// Iter #5: Trimmed to only tokens showing positive/near-zero edge (SOL, JUP, RAY)
// Removed JTO (-40bps), PYTH (-9bps), BONK/WIF (no data) — wasting API calls
const CANDIDATES = [
  { symbol: 'SOL',  mint: 'So11111111111111111111111111111111111111112' },
  { symbol: 'JUP',  mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN' },
  { symbol: 'RAY',  mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R' },
];

const LOG_DIR = path.join(process.cwd(), 'bot', 'logs');
const CSV_FILE = path.join(LOG_DIR, 'spread-tracker.csv');
fs.mkdirSync(LOG_DIR, { recursive: true });

// Write CSV header if file is new
if (!fs.existsSync(CSV_FILE) || fs.statSync(CSV_FILE).size === 0) {
  fs.writeFileSync(CSV_FILE, 'timestamp,symbol,edgeBps,usdcBack\n');
}

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

async function measureSpread(token) {
  try {
    const usdcAtomic = Math.floor(TRADE_SIZE_USDC * 1_000_000);
    const q1 = await jupQuote(USDC_MINT, token.mint, usdcAtomic);
    if (!q1?.outAmount) return null;
    const q2 = await jupQuote(token.mint, USDC_MINT, Number(q1.outAmount));
    if (!q2?.outAmount) return null;
    const usdcBack = Number(q2.outAmount) / 1_000_000;
    const edgeBps = ((usdcBack - TRADE_SIZE_USDC) / TRADE_SIZE_USDC) * 10_000;
    return { symbol: token.symbol, edgeBps, usdcBack };
  } catch { return null; }
}

async function run() {
  console.log(`Spread monitor started — ${MAX_CYCLES} cycles, ${LOOP_MS}ms interval`);
  let bestEverEdge = -Infinity;
  let bestEverSymbol = '';

  for (let i = 0; i < MAX_CYCLES; i++) {
    const results = (await Promise.all(CANDIDATES.map(measureSpread))).filter(Boolean);
    const ts = new Date().toISOString();
    for (const r of results) {
      fs.appendFileSync(CSV_FILE, `${ts},${r.symbol},${r.edgeBps.toFixed(2)},${r.usdcBack.toFixed(4)}\n`);
      if (r.edgeBps > bestEverEdge) {
        bestEverEdge = r.edgeBps;
        bestEverSymbol = r.symbol;
      }
    }
    const best = results.sort((a, b) => b.edgeBps - a.edgeBps)[0];
    if (best) {
      console.log(`[${ts}] cycle=${i+1}/${MAX_CYCLES} best=${best.symbol} edge=${best.edgeBps.toFixed(2)}bps | allTimeBest=${bestEverSymbol} ${bestEverEdge.toFixed(2)}bps`);
    }
    if (i < MAX_CYCLES - 1) await new Promise(r => setTimeout(r, LOOP_MS));
  }
  console.log(`\nDone. Best edge seen: ${bestEverSymbol} ${bestEverEdge.toFixed(2)}bps`);
  console.log(`Data saved to ${CSV_FILE}`);
}

run().catch(e => { console.error(e); process.exit(1); });
