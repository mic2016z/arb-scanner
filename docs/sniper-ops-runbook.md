# Sniper Ops Runbook

## Scope split: infrastructure vs code
- Infrastructure-only: bare-metal provisioning, validator adjacency, BGP/carrier choices, node hardening.
- Code-enforced: event detection, risk gating, bundle construction, auto-exit logic, and circuit breakers.

## Phase 1 - Backbone
1. Provision dedicated bare-metal (EPYC class, 512GB RAM, NVMe) in a validator-dense region.
2. Run your own non-voting Solana RPC with SWQoS paths configured at your validator/provider edge.
3. Enable Jito ShredStream feed and verify sustained low-latency packet intake before live trading.

## Phase 2 - Radar
1. Use Tokio multi-thread runtime and isolate hot tasks on fixed worker pools.
2. Replace HTTP polling with Yellowstone gRPC subscription at `processed` commitment.
3. Filter to launch-relevant DEX programs and parse discriminators for `initialize_pool` and `add_liquidity`.

## Phase 3 - Brain
1. Reject tokens with non-null mint/freeze authority.
2. Reject pools where LP token supply is non-zero (not burned/locked as required by your policy).
3. Simulate sell-path to detect fee-on-transfer and token-2022 transfer-hook traps.
4. Enforce a minimum liquidity threshold (`MIN_POOL_SIZE_SOL`, default 90).

## Phase 4 - Trigger
1. Add compute unit limit/price instructions before swap instructions.
2. Submit via Jito bundle path for atomicity and frontrun resistance.
3. Dynamically tip in a bounded range (`MIN_TIP_SOL` to `MAX_TIP_SOL`) based on event score.

## Phase 5 - Parachute
1. Track entry price and enforce take-profit/stop-loss automation.
2. Keep per-trade capital risk capped by `MAX_TRADE_FRACTION`.
3. Use wallet sharding while maintaining per-wallet rate and balance guards.

## Phase 6 - Lifecycle
1. Emit detection and loop-cycle latency metrics.
2. Continuously monitor node lag (`num_slots_behind` style signal).
3. If slot lag exceeds `MAX_SLOTS_BEHIND`, enable circuit breaker and halt order flow.

## What is already scaffolded in this repo
- `sniper-core` Rust crate with modules matching phases:
  - `detector.rs`, `risk.rs`, `execution.rs`, `telemetry.rs`, `runtime.rs`, `config.rs`.
- `.env.example` containing operational knobs for all six phases.

## Immediate next implementation steps
1. Replace detector placeholder with actual Yellowstone subscription client.
2. Add real on-chain account fetches for mint authority, freeze authority, LP supply, and token-2022 extension checks.
3. Implement signed swap transaction + Jito bundle submit path.
4. Add Prometheus exporter endpoint and alerting rules.
