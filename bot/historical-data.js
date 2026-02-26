import fs from 'node:fs';
import path from 'node:path';

// ── Token list (same as momentum bot) ───────────────────────────────────
const TOKENS = [
  { symbol: 'BONK', cgId: 'bonk', mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6fRdbs8xwYJmwjT' },
  { symbol: 'WIF',  cgId: 'dogwifcoin', mint: 'EKpQGSJtjMFqKZKQanSqYXRcF4fBopz4FY2M8mJv6S6X' },
  { symbol: 'POPCAT', cgId: 'popcat', mint: '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr' },
  { symbol: 'MEW',  cgId: 'cat-in-a-dogs-world', mint: 'MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5' },
  { symbol: 'JUP',  cgId: 'jupiter-exchange-solana', mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN' },
  { symbol: 'RAY',  cgId: 'raydium', mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R' },
  { symbol: 'JTO',  cgId: 'jito-governance-token', mint: 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL' },
  { symbol: 'PYTH', cgId: 'pyth-network', mint: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3' },
  { symbol: 'RENDER', cgId: 'render-token', mint: 'rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof' },
  { symbol: 'TNSR', cgId: 'tensor', mint: 'TNSRxcUxoT9xBG3de7PiJyTDYu7kskLqcpddxnEJAS6' },
];

const DATA_DIR = path.join(process.cwd(), 'bot', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// ── Fetch from DexScreener (free, no key) ───────────────────────────────
async function fetchDexScreener(mint) {
  // DexScreener token page returns pair data with price history
  const url = `https://api.dexscreener.com/latest/dex/tokens/${mint}`;
  const r = await fetch(url);
  if (!r.ok) return null;
  const j = await r.json();
  const pairs = j?.pairs || [];
  // Pick highest liquidity USDC or SOL pair
  const best = pairs
    .filter(p => p.chainId === 'solana')
    .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
  return best || null;
}

// ── Fetch from CoinGecko (free tier, 7d hourly) ────────────────────────
async function fetchCoinGeckoHistory(cgId) {
  // Free API: /coins/{id}/market_chart?vs_currency=usd&days=7
  const url = `https://api.coingecko.com/api/v3/coins/${cgId}/market_chart?vs_currency=usd&days=7`;
  const r = await fetch(url, { headers: { accept: 'application/json' } });
  if (!r.ok) return null;
  const j = await r.json();
  return j; // { prices: [[ts,price],...], market_caps, total_volumes }
}

// ── Compute stats from candle data ──────────────────────────────────────
function computeStats(symbol, prices, volumes) {
  if (!prices || prices.length < 10) return null;

  const closes = prices.map(p => p[1]);
  const n = closes.length;

  // Hourly returns
  const returns = [];
  for (let i = 1; i < n; i++) {
    returns.push((closes[i] - closes[i - 1]) / closes[i - 1] * 100);
  }

  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
  const stdDev = Math.sqrt(variance);

  // Daily volatility (approx from hourly std * sqrt(24))
  const dailyVolPct = stdDev * Math.sqrt(24);

  // Max drawdown in period
  let peak = closes[0];
  let maxDD = 0;
  for (const c of closes) {
    if (c > peak) peak = c;
    const dd = (peak - c) / peak * 100;
    if (dd > maxDD) maxDD = dd;
  }

  // Best momentum windows: find all 3%+ moves within 3-hour windows
  const windowSize = 12; // 12 hourly candles = ~12 hours... use smaller for sub-hour
  const breakouts = [];
  for (let i = windowSize; i < n; i++) {
    const changePct = (closes[i] - closes[i - windowSize]) / closes[i - windowSize] * 100;
    if (Math.abs(changePct) >= 2.0) {
      const ts = prices[i][0];
      const hour = new Date(ts).getUTCHours();
      breakouts.push({ idx: i, changePct, hour, ts });
    }
  }

  // Hour-of-day distribution of breakouts
  const hourBuckets = {};
  for (const b of breakouts) {
    hourBuckets[b.hour] = (hourBuckets[b.hour] || 0) + 1;
  }

  // Best hours (top 6 by breakout count)
  const bestHours = Object.entries(hourBuckets)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([h]) => Number(h));

  // Volume stats
  let avgVolume = 0;
  if (volumes && volumes.length > 0) {
    avgVolume = volumes.reduce((a, b) => a + b[1], 0) / volumes.length;
  }

  // Suggested thresholds based on volatility
  const suggestedEntryPct = Math.max(1.5, dailyVolPct * 0.3);  // 30% of daily vol
  const suggestedStopPct = Math.max(2.0, dailyVolPct * 0.4);   // 40% of daily vol
  const suggestedTPPct = Math.max(3.0, dailyVolPct * 0.7);     // 70% of daily vol
  const suggestedTrailPct = Math.max(1.5, dailyVolPct * 0.25); // 25% of daily vol

  return {
    symbol,
    dataPoints: n,
    periodHours: Math.round((prices[n - 1][0] - prices[0][0]) / 3600000),
    currentPrice: closes[n - 1],
    priceRange: { low: Math.min(...closes), high: Math.max(...closes) },
    hourlyReturnMean: Number(mean.toFixed(4)),
    hourlyReturnStdDev: Number(stdDev.toFixed(4)),
    dailyVolatilityPct: Number(dailyVolPct.toFixed(2)),
    maxDrawdownPct: Number(maxDD.toFixed(2)),
    breakoutCount: breakouts.length,
    bestHoursUTC: bestHours,
    avgDailyVolumeUSD: Math.round(avgVolume),
    suggested: {
      entryPct: Number(suggestedEntryPct.toFixed(2)),
      stopLossPct: Number(suggestedStopPct.toFixed(2)),
      takeProfitPct: Number(suggestedTPPct.toFixed(2)),
      trailingStopPct: Number(suggestedTrailPct.toFixed(2)),
    },
  };
}

// ── Main collector ──────────────────────────────────────────────────────
async function collectAll() {
  console.log(`[${new Date().toISOString()}] Starting historical data collection...`);
  const allStats = {};
  const dexData = {};

  // 1. DexScreener current data (liquidity, volume, price changes)
  console.log('\n── DexScreener (current snapshot) ──');
  for (const token of TOKENS) {
    try {
      const pair = await fetchDexScreener(token.mint);
      if (pair) {
        dexData[token.symbol] = {
          pairAddress: pair.pairAddress,
          dexId: pair.dexId,
          priceUsd: pair.priceUsd,
          priceChange5m: pair.priceChange?.m5,
          priceChange1h: pair.priceChange?.h1,
          priceChange6h: pair.priceChange?.h6,
          priceChange24h: pair.priceChange?.h24,
          volume24h: pair.volume?.h24,
          liquidity: pair.liquidity?.usd,
          txns24h: pair.txns?.h24,
        };
        console.log(`  ${token.symbol}: $${pair.priceUsd} | 24h: ${pair.priceChange?.h24}% | vol: $${Math.round(pair.volume?.h24 || 0)} | liq: $${Math.round(pair.liquidity?.usd || 0)}`);
      } else {
        console.log(`  ${token.symbol}: no pair found`);
      }
      await sleep(300); // rate limit
    } catch (e) {
      console.log(`  ${token.symbol}: error - ${e.message}`);
    }
  }

  // 2. CoinGecko 7-day hourly (for stats + calibration)
  console.log('\n── CoinGecko (7-day hourly history) ──');
  for (const token of TOKENS) {
    try {
      const data = await fetchCoinGeckoHistory(token.cgId);
      if (data?.prices) {
        const stats = computeStats(token.symbol, data.prices, data.total_volumes);
        if (stats) {
          allStats[token.symbol] = stats;
          console.log(`  ${token.symbol}: ${stats.dataPoints} points | vol ${stats.dailyVolatilityPct}%/day | ${stats.breakoutCount} breakouts | best hours UTC: [${stats.bestHoursUTC.join(',')}]`);
          console.log(`    → suggested entry: ${stats.suggested.entryPct}% | SL: ${stats.suggested.stopLossPct}% | TP: ${stats.suggested.takeProfitPct}% | trail: ${stats.suggested.trailingStopPct}%`);
        }
        // Save raw prices to CSV
        const csv = 'timestamp,price_usd,volume_usd\n' +
          data.prices.map((p, i) => {
            const vol = data.total_volumes?.[i]?.[1] || 0;
            return `${p[0]},${p[1]},${vol}`;
          }).join('\n');
        fs.writeFileSync(path.join(DATA_DIR, `${token.symbol}_7d_hourly.csv`), csv);
      } else {
        console.log(`  ${token.symbol}: no data`);
      }
      await sleep(6500); // CoinGecko free tier: ~10 req/min
    } catch (e) {
      console.log(`  ${token.symbol}: error - ${e.message}`);
    }
  }

  // 3. Save combined stats + calibration profile
  const profile = {
    generatedAt: new Date().toISOString(),
    tokens: allStats,
    dexSnapshot: dexData,
  };
  fs.writeFileSync(path.join(DATA_DIR, 'token-profiles.json'), JSON.stringify(profile, null, 2));

  // 4. Generate per-token config for momentum bot
  const botConfig = {};
  for (const [sym, stats] of Object.entries(allStats)) {
    botConfig[sym] = {
      entryPct: stats.suggested.entryPct,
      stopLossPct: stats.suggested.stopLossPct,
      takeProfitPct: stats.suggested.takeProfitPct,
      trailingStopPct: stats.suggested.trailingStopPct,
      dailyVolPct: stats.dailyVolatilityPct,
      bestHoursUTC: stats.bestHoursUTC,
      liquidity: dexData[sym]?.liquidity || 0,
      volume24h: dexData[sym]?.volume24h || 0,
    };
  }
  fs.writeFileSync(path.join(DATA_DIR, 'bot-calibration.json'), JSON.stringify(botConfig, null, 2));

  console.log(`\n✅ Done. Files saved to ${DATA_DIR}/`);
  console.log('  - token-profiles.json (full stats)');
  console.log('  - bot-calibration.json (per-token bot params)');
  console.log('  - [SYMBOL]_7d_hourly.csv (raw price history per token)');

  return profile;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

collectAll().catch(e => { console.error(e); process.exit(1); });
