# Solana Live/Paper Memecoin Bot

## Safety first
- Start in paper mode (`DRY_RUN=true`) and verify logs.
- Use a dedicated bot wallet only.
- Keep small trade size.

## Env vars

Create `.env` (local machine, never commit):

```bash
SOLANA_PRIVATE_KEY=<base58-private-key>
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
DRY_RUN=true
BOT_LOOP_MS=20000
MIN_EDGE_BPS=120
SLIPPAGE_BPS=80
TRADE_SIZE_USDC=5
MAX_DAILY_LOSS_USDC=5
```

## Run

```bash
npm install
npm run bot:paper   # safe practice mode
npm run bot:live    # live mode (uses real funds)
```

## Logs
- `bot/logs/live-bot-log.jsonl`

## Notes
- Strategy looks for simple USDC -> memecoin -> USDC round-trip edge via Jupiter quotes.
- Live execution is two-leg (not atomic), so slippage and latency risk exist.
- Keep position size tiny.
