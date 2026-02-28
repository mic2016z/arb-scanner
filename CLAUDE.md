# CLAUDE.md — arb-scanner

Developer guide for AI assistants working in this repository.

---

## Project overview

**arb-scanner** is a real-time crypto arbitrage scanning and trading system split across three layers:

1. **Frontend** (`index.html`) — single-page dashboard (vanilla JS, JetBrains Mono UI) polling the Vercel API and rendering live arbitrage opportunities plus a simulated paper-trading bot.
2. **Serverless API** (`api/`) — two Vercel serverless functions that aggregate CEX prices and expose live on-chain wallet balances.
3. **Node.js bots** (`bot/`) — three standalone scripts: a read-only spread monitor, a round-trip arbitrage bot, and a momentum trend-following bot, all targeting Solana via Jupiter.
4. **Rust sniper core** (`sniper-core/`) — scaffolded Tokio-based low-latency event detector, risk engine, and execution layer targeting new token launches on Raydium/PumpFun via Jito bundles.

---

## Repository layout

```
.
├── index.html                  # Frontend SPA dashboard
├── package.json                # Node.js project root (ESM, v1.1.0)
├── vercel.json                 # Vercel route rewrites for API functions
├── .gitignore
│
├── api/
│   ├── prices.js               # Serverless: fetch & aggregate prices from 5 CEXes
│   └── wallet.js               # Serverless: read SOL + USDC balance from on-chain wallet
│
├── bot/
│   ├── live-solana-bot.js      # Round-trip arb bot (USDC → token → USDC via Jupiter)
│   ├── momentum-bot.js         # Momentum trend-following bot with per-token calibration
│   ├── spread-monitor.js       # Read-only spread sampler — no wallet key needed
│   ├── historical-data.js      # Fetches 7-day history from CoinGecko + DexScreener
│   ├── README.md               # Bot safety and env-var reference
│   └── data/
│       ├── bot-calibration.json        # Generated per-token thresholds (do not edit manually)
│       ├── token-profiles.json         # Full stats snapshot from historical-data.js
│       └── *.csv                       # Raw 7-day hourly price data per token
│
├── sniper-core/                # Rust crate — low-latency new-token sniper scaffold
│   ├── Cargo.toml
│   ├── .env.example            # All env-var knobs with defaults (copy to .env, never commit)
│   └── src/
│       ├── main.rs             # Tokio multi-thread event loop (select! over detector + signals)
│       ├── config.rs           # Config::from_env() — all tuning vars loaded here
│       ├── detector.rs         # EventDetector — STUB; replace with Yellowstone gRPC
│       ├── risk.rs             # RiskEngine::accept() — pool/authority/LP/token-2022 gates
│       ├── execution.rs        # Executor::submit_bundle() — STUB; replace with Jito bundle path
│       ├── telemetry.rs        # Detection latency logging, blocked/executed counters
│       └── runtime.rs          # Startup log of runtime config targets
│
└── docs/
    └── sniper-ops-runbook.md   # Six-phase operational guide for running sniper-core in prod
```

---

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla JS/HTML/CSS — no build step |
| API | Node.js ESM, Vercel serverless functions |
| Bots | Node.js ESM, `@solana/web3.js`, `bs58`, `dotenv` |
| Sniper | Rust 2021, Tokio async, `tracing`, `serde`, `anyhow` |
| DEX routing | Jupiter Lite API (`lite-api.jup.ag/swap/v1`) |
| Data sources | DexScreener (free), CoinGecko (free tier) |
| Deployment | Vercel (frontend + API functions) |

---

## Development commands

### Node.js bots

```bash
# Install dependencies
npm install

# Run the round-trip arb bot in paper (safe) mode
npm run bot:paper                # DRY_RUN=true node bot/live-solana-bot.js

# Run in live mode — uses real funds, requires SOLANA_PRIVATE_KEY
npm run bot:live                 # node bot/live-solana-bot.js

# Collect/refresh historical calibration data (~2 min due to CoinGecko rate limits)
node bot/historical-data.js

# Run the read-only spread monitor (no wallet key needed)
node bot/spread-monitor.js
```

### Rust sniper-core

```bash
cd sniper-core

# Build debug
cargo build

# Build release
cargo build --release

# Run with logging (reads config from .env or environment)
RUST_LOG=info cargo run

# Run tests
cargo test
```

---

## Environment variables

### Bot `.env` (repo root — never commit)

| Variable | Default | Description |
|---|---|---|
| `SOLANA_PRIVATE_KEY` | **required** | Base58 private key for the bot wallet |
| `SOLANA_RPC_URL` | `https://api.mainnet-beta.solana.com` | Solana RPC endpoint |
| `DRY_RUN` | `false` (live bot), `true` (momentum bot) | Skip real transactions |
| `BOT_LOOP_MS` | `20000` / `15000` | Poll interval in milliseconds |
| `MIN_EDGE_BPS` | `120` | Minimum gross edge before considering a trade |
| `MIN_NET_EDGE_BPS` | `90` | Minimum net edge after estimated costs |
| `SLIPPAGE_BPS` | `80` / `100` | Slippage tolerance |
| `TRADE_SIZE_USDC` | `5` | Base trade size per round-trip |
| `MAX_DAILY_LOSS_USDC` | `5` / `3` | Daily loss circuit breaker |
| `MAX_PRICE_IMPACT_PCT` | `0.35` | Per-leg price impact limit |
| `JUPITER_FEE_BPS` | `12` | Round-trip Jupiter fee buffer |
| `EXTRA_SAFETY_BPS` | `25` | Latency/MEV buffer |
| `MIN_PRICE_CHANGE_PCT` | `1.5` | Momentum entry threshold (overridden by calibration) |
| `LOOKBACK_SAMPLES` | `12` | Price history window depth for momentum signal |
| `TRAILING_STOP_PCT` | `1.5` | Trailing stop from high-water mark |
| `TAKE_PROFIT_PCT` | `3.2` | Take-profit target |
| `STOP_LOSS_PCT` | `2.0` | Hard stop-loss floor |
| `MAX_HOLD_MS` | `600000` | Maximum position hold time (10 min) |

### Wallet API env vars (set in Vercel dashboard)

| Variable | Default | Description |
|---|---|---|
| `SOLANA_RPC_URL` | `https://api.mainnet-beta.solana.com` | RPC endpoint |
| `BOT_WALLET_PUBLIC` | hardcoded fallback | Public key displayed on the dashboard |

### Sniper-core env vars (see `sniper-core/.env.example` for the full list)

| Variable | Default | Description |
|---|---|---|
| `RUST_LOG` | `info` | Log verbosity |
| `WATCH_PROGRAMS` | `raydium,pumpfun` | Comma-separated DEX programs to monitor |
| `COMMITMENT` | `processed` | Solana commitment level |
| `EVENT_DETECTION_TARGET_MS` | `50` | Latency target for event detection |
| `MIN_POOL_SIZE_SOL` | `90` | Minimum pool liquidity gate |
| `REQUIRE_NULL_MINT_AUTHORITY` | `true` | Rug-pull guard |
| `REQUIRE_LP_BURNED` | `true` | Require LP supply burned/locked |
| `COMPUTE_UNIT_LIMIT` | `350000` | CU limit for swap transaction |
| `PRIORITY_FEE_MICRO_LAMPORTS` | `500000` | Priority fee for inclusion |
| `TAKE_PROFIT_MULTIPLIER` | `2.0` | Exit at 2× entry price |
| `STOP_LOSS_PCT` | `0.12` | Exit at 12% loss |
| `MAX_TRADE_FRACTION` | `0.02` | Max 2% of wallet per trade |
| `WALLET_SHARDS` | `5` | Number of wallet shards |
| `MAX_SLOTS_BEHIND` | `3` | Slots-behind threshold for circuit breaker |
| `ENABLE_CIRCUIT_BREAKER` | `true` | Halt order flow when lagging |

---

## Key architecture decisions

### API layer (`api/prices.js`)

- Fetches all 5 exchanges in parallel via `Promise.all`.
- Binance and Bybit each have a regional fallback URL attempted on failure.
- **Outlier guard**: discards any opportunity where `grossSpread > 5%` — this is intentional and must not be removed; real spot arb spreads are small and large values almost always indicate stale/bad data.
- Exchange fees are hardcoded constants: Binance/Bybit/KuCoin 0.1%, Kraken 0.26%, Coinbase 0.6%.
- Returns a `scan` object per exchange with `ok`, `ms`, `status`, and `matched` count — used by the dashboard to show exchange health indicators.
- Coinbase rates are inverse (USD per unit); the handler inverts them (`1 / rate`).
- Response is cached at the CDN edge for 5 seconds (`Cache-Control: s-maxage=5`).

### Round-trip arb bot (`bot/live-solana-bot.js`)

- **Active candidates**: SOL, JUP, RAY only (trimmed empirically after spread monitoring; other tokens showed consistent negative edge).
- **Trade gate order** (all must pass in sequence):
  1. Gross edge > 0 and net edge > 0
  2. Edge above `MIN_EDGE_BPS` and `MIN_NET_EDGE_BPS`
  3. Per-leg price impact below `MAX_PRICE_IMPACT_PCT`
  4. Daily loss below `MAX_DAILY_LOSS_USDC`
  5. **Re-quote** with dynamic size (mandatory before execution)
  6. Execute
- Re-quoting before execution is non-negotiable — edge can decay between evaluation and trade.
- Dynamic sizing: `netEdgeBps >= 450` → 2× size (cap 20 USDC), `>= 300` → 1.5× (cap 12 USDC), else base.
- Live mode executes **two sequential swaps** (not atomic). Slippage and latency risk exist between legs 1 and 2.
- Logs to `bot/logs/live-bot-log.jsonl` (JSONL) and appends to `bot/logs/spread-tracker.csv`.

### Momentum bot (`bot/momentum-bot.js`)

- **Candidates**: BONK, WIF, POPCAT, MEW, JUP, RAY, JTO, PYTH, RENDER, TNSR.
- Loads per-token calibration from `bot/data/bot-calibration.json` at startup. Falls back to env-var defaults if absent.
- **Entry signal** requires all of the following:
  - Current UTC hour is in the token's `bestHoursUTC` list (from calibration)
  - Price change over lookback window exceeds per-token `entryPct`
  - ≥55% of recent price samples trend in the same direction
  - Token liquidity exceeds 50,000 USD (from calibration)
- **Exits**: take-profit, stop-loss, trailing stop from HWM, max-hold timeout — all per-token calibrated.
- 2-minute cooldown per token after any exit.
- Maximum 2 open positions; one new entry per loop cycle.
- Daily loss circuit breaker: suspends for 4× loop interval when limit hit; resets at UTC midnight.
- Logs to `bot/logs/momentum-bot-log.jsonl`.

### Historical data & calibration (`bot/historical-data.js`)

- Fetches DexScreener for current liquidity/volume and CoinGecko for 7-day hourly OHLCV.
- CoinGecko free tier requires 6.5s between requests; the full run takes ~2 minutes for 10 tokens.
- Outputs to `bot/data/`:
  - `token-profiles.json` — full computed stats (volatility, drawdown, breakout hours, etc.)
  - `bot-calibration.json` — per-token bot parameters consumed by `momentum-bot.js`
  - `{SYMBOL}_7d_hourly.csv` — raw price + volume history
- **Run this before starting `momentum-bot.js`** to ensure calibration reflects current market conditions. The checked-in files are seed data only.

### Sniper-core (Rust scaffold)

- Architecture: `EventDetector` → `RiskEngine` → `Executor`, instrumented by `Telemetry`.
- `detector.rs` is a **stub** — `next_event()` returns a synthetic event after a 25ms sleep. Must be replaced with a real Yellowstone gRPC subscription + shred ingestion pipeline before any production use.
- `execution.rs` is a **stub** — `submit_bundle()` logs an intent message. Must be replaced with signed transaction assembly + Jito bundle submission.
- Config is entirely env-driven via `Config::from_env()`. No config files, no CLI flags.
- All risk gates are boolean AND-chained in `risk.rs`. Adding a new gate is additive and safe.
- See `docs/sniper-ops-runbook.md` for the six-phase production path.

---

## Data flow

```
CoinGecko / DexScreener
        │
        ▼
bot/historical-data.js ──► bot/data/bot-calibration.json
                                         │
                                         ▼ (loaded at startup)
                               bot/momentum-bot.js


Binance / Bybit / Coinbase / Kraken / KuCoin
        │
        ▼
api/prices.js (Vercel serverless, 5s CDN cache)
        │
        ▼
index.html (polls /api/prices every 5s, runs paper sim in browser)


Jupiter Lite API (quote → swap)
        │
        ▼
bot/live-solana-bot.js  OR  bot/momentum-bot.js
        │
        ▼
Solana mainnet (via RPC + @solana/web3.js)


Yellowstone gRPC [NOT YET IMPLEMENTED]
        │
        ▼
sniper-core (Rust) ──► Jito bundle [NOT YET IMPLEMENTED]
```

---

## Conventions

### Code style

- All JS uses **ESM** (`"type": "module"` in `package.json`). Use `import`/`export` — never `require`.
- No TypeScript, no transpilation, no bundler. Plain Node.js with the `--experimental-vm-modules` flag not needed.
- Structured logging pattern used by every bot: `log(eventName, dataObject)` → writes one JSONL row and `console.log`.
- All bots call `process.exit(1)` when `SOLANA_PRIVATE_KEY` is missing. Do not add a fallback.

### Safety rules — non-negotiable

- **Always start bots with `DRY_RUN=true`** and verify `bot/logs/` output before enabling live mode.
- `bot/logs/` is gitignored. Never commit log files.
- `.env` is gitignored. Never commit private keys or RPC credentials.
- The `grossSpread > 5%` outlier guard in `api/prices.js` must not be removed or loosened.
- `bot/data/bot-calibration.json` and CSVs are committed as seed data, but should be regenerated via `historical-data.js` before any live trading session.

### Adding new tokens

1. Add the token with its Solana mint address to the `CANDIDATES` array in the relevant bot file.
2. Add the CoinGecko ID and mint to `TOKENS` in `bot/historical-data.js`.
3. Run `node bot/historical-data.js` to populate calibration data.
4. Verify liquidity exceeds 50,000 USD in the generated `bot-calibration.json`.
5. Run `bot:paper` for at least one full session and review the log before going live.

### Extending sniper-core

- All new tuning knobs go in `config.rs` with an env-var + sensible default. Document in `.env.example`.
- The `risk.rs` accept chain is `&&` — all gates must pass. Adding a new gate is additive and safe.
- New modules should follow the existing pattern: clone `Config` at construction, expose one primary async method.
- Do not touch `detector.rs` or `execution.rs` stubs without replacing them with real implementations.

---

## Deployment (Vercel)

- `index.html` is the static entry point served at `/`.
- `api/prices.js` and `api/wallet.js` deploy as serverless functions via rewrites in `vercel.json`.
- Rewrites: `/api/prices` → `/api/prices.js`, `/api/wallet` → `/api/wallet.js`.
- The frontend uses relative `/api/prices` and `/api/wallet` paths — works on any Vercel deployment domain without configuration.
- No build step required. Deploy directly from the repo root.
- Set `BOT_WALLET_PUBLIC` and `SOLANA_RPC_URL` as Vercel environment variables for the production deployment.

---

## Known limitations and active TODOs

| Item | Status |
|---|---|
| `sniper-core/detector.rs` | Stub only — needs real Yellowstone gRPC client |
| `sniper-core/execution.rs` | Stub only — needs signed txn assembly + Jito bundle submit |
| Live bot swap legs | Not atomic — adverse price movement possible between leg 1 and leg 2 |
| Spread-monitor candidate list | Trimmed to SOL/JUP/RAY empirically; revisit if market conditions change |
| CoinGecko rate limits | Free tier makes `historical-data.js` slow (~2 min); upgrade to paid key if latency matters |
| `wallet.js` fallback key | Hardcoded fallback public key — set `BOT_WALLET_PUBLIC` in Vercel env vars for production |
| Prometheus metrics | Not implemented; `telemetry.rs` logs to stdout only |
