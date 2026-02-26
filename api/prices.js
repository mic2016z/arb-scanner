// Vercel Serverless Function — fetches prices from 5 exchanges
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=5');

  const TOKENS = ['BTC','ETH','SOL','XRP','DOGE','ADA','AVAX','DOT','LINK','MATIC','UNI','AAVE','ARB','OP','SUI'];
  
  const FEES = {
    Binance: 0.1, Bybit: 0.1, Coinbase: 0.6, Kraken: 0.26, KuCoin: 0.1
  };

  const KRAKEN_MAP = {
    BTC: 'XXBTZUSD', ETH: 'XETHZUSD', SOL: 'SOLUSD', XRP: 'XXRPZUSD',
    DOGE: 'XDGUSD', ADA: 'ADAUSD', AVAX: 'AVAXUSD', DOT: 'DOTUSD',
    LINK: 'LINKUSD', MATIC: 'MATICUSD', UNI: 'UNIUSD', AAVE: 'AAVEUSD',
    ARB: 'ARBUSD', OP: 'OPUSD', SUI: 'SUIUSD'
  };

  async function fetchJSON(url, timeout = 8000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    const started = Date.now();
    try {
      const r = await fetch(url, { signal: controller.signal });
      const ms = Date.now() - started;
      clearTimeout(id);
      if (!r.ok) return { ok: false, data: null, ms, status: r.status };
      return { ok: true, data: await r.json(), ms, status: r.status };
    } catch {
      clearTimeout(id);
      return { ok: false, data: null, ms: Date.now() - started, status: 0 };
    }
  }

  // Fetch all exchanges in parallel
  let [binanceR, bybitR, coinbaseR, krakenR, kucoinR] = await Promise.all([
    fetchJSON('https://api.binance.com/api/v3/ticker/price'),
    fetchJSON('https://api.bybit.com/v5/market/tickers?category=spot'),
    fetchJSON('https://api.coinbase.com/v2/exchange-rates?currency=USD'),
    fetchJSON('https://api.kraken.com/0/public/Ticker?pair=' + Object.values(KRAKEN_MAP).join(',')),
    fetchJSON('https://api.kucoin.com/api/v1/market/allTickers'),
  ]);

  // Regional/provider fallbacks
  if (!binanceR.ok || !binanceR.data?.length) {
    const fallback = await fetchJSON('https://api.binance.us/api/v3/ticker/price');
    if (fallback.ok) binanceR = fallback;
  }
  if (!bybitR.ok || !bybitR.data?.result?.list?.length) {
    const fallback = await fetchJSON('https://api.bytick.com/v5/market/tickers?category=spot');
    if (fallback.ok) bybitR = fallback;
  }

  const binance = binanceR.data;
  const bybit = bybitR.data;
  const coinbase = coinbaseR.data;
  const kraken = krakenR.data;
  const kucoin = kucoinR.data;

  const prices = {};
  const sourceMatchCount = { Binance: 0, Bybit: 0, Coinbase: 0, Kraken: 0, KuCoin: 0 };

  // Binance
  if (binance) {
    for (const t of TOKENS) {
      const sym = t + 'USDT';
      const item = binance.find(x => x.symbol === sym);
      if (item) {
        prices[t] = prices[t] || {};
        prices[t].Binance = parseFloat(item.price);
        sourceMatchCount.Binance += 1;
      }
    }
  }

  // Bybit
  if (bybit?.result?.list) {
    for (const t of TOKENS) {
      const sym = t + 'USDT';
      const item = bybit.result.list.find(x => x.symbol === sym);
      if (item) {
        prices[t] = prices[t] || {};
        prices[t].Bybit = parseFloat(item.lastPrice);
        sourceMatchCount.Bybit += 1;
      }
    }
  }

  // Coinbase (rates are inverse: USD per 1 unit of currency)
  if (coinbase?.data?.rates) {
    for (const t of TOKENS) {
      const rate = coinbase.data.rates[t];
      if (rate) {
        prices[t] = prices[t] || {};
        prices[t].Coinbase = 1 / parseFloat(rate);
        sourceMatchCount.Coinbase += 1;
      }
    }
  }

  // Kraken
  if (kraken?.result) {
    for (const t of TOKENS) {
      const pair = KRAKEN_MAP[t];
      // Kraken keys can vary, try direct and alt
      const data = kraken.result[pair] || Object.values(kraken.result).find((v, i) => Object.keys(kraken.result)[i].includes(t));
      if (data?.c?.[0]) {
        prices[t] = prices[t] || {};
        prices[t].Kraken = parseFloat(data.c[0]);
        sourceMatchCount.Kraken += 1;
      }
    }
  }

  // KuCoin
  if (kucoin?.data?.ticker) {
    for (const t of TOKENS) {
      const sym = t + '-USDT';
      const item = kucoin.data.ticker.find(x => x.symbol === sym);
      if (item?.last) {
        prices[t] = prices[t] || {};
        prices[t].KuCoin = parseFloat(item.last);
        sourceMatchCount.KuCoin += 1;
      }
    }
  }

  // Calculate arbitrage opportunities
  const opportunities = [];
  for (const token of TOKENS) {
    const tp = prices[token];
    if (!tp) continue;
    const exchanges = Object.entries(tp);
    for (let i = 0; i < exchanges.length; i++) {
      for (let j = i + 1; j < exchanges.length; j++) {
        const [exA, priceA] = exchanges[i];
        const [exB, priceB] = exchanges[j];
        if (!priceA || !priceB) continue;
        const low = Math.min(priceA, priceB);
        const high = Math.max(priceA, priceB);
        const buyEx = priceA < priceB ? exA : exB;
        const sellEx = priceA < priceB ? exB : exA;
        const grossSpread = ((high - low) / low) * 100;
        const totalFees = FEES[buyEx] + FEES[sellEx];
        const netSpread = grossSpread - totalFees;
        opportunities.push({
          token, buyEx, sellEx,
          buyPrice: low, sellPrice: high,
          grossSpread: +grossSpread.toFixed(4),
          fees: totalFees,
          netSpread: +netSpread.toFixed(4),
          profitPer1000: +((netSpread / 100) * 1000).toFixed(2),
          timestamp: Date.now()
        });
      }
    }
  }

  opportunities.sort((a, b) => b.netSpread - a.netSpread);

  const scan = {
    Binance: { ok: binanceR.ok, ms: binanceR.ms, status: binanceR.status, matched: sourceMatchCount.Binance },
    Bybit: { ok: bybitR.ok, ms: bybitR.ms, status: bybitR.status, matched: sourceMatchCount.Bybit },
    Coinbase: { ok: coinbaseR.ok, ms: coinbaseR.ms, status: coinbaseR.status, matched: sourceMatchCount.Coinbase },
    Kraken: { ok: krakenR.ok, ms: krakenR.ms, status: krakenR.status, matched: sourceMatchCount.Kraken },
    KuCoin: { ok: kucoinR.ok, ms: kucoinR.ms, status: kucoinR.status, matched: sourceMatchCount.KuCoin },
  };

  res.status(200).json({
    timestamp: Date.now(),
    tokenCount: TOKENS.length,
    exchangeCount: 5,
    opportunities,
    prices,
    fees: FEES,
    scan,
    topSignal: opportunities[0] || null
  });
}
