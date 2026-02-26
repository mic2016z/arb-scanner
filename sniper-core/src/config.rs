use std::env;

#[derive(Clone, Debug)]
pub struct Config {
    pub watch_programs: Vec<String>,
    pub commitment: String,
    pub target_discriminators: Vec<String>,
    pub event_detection_target_ms: u64,
    pub loop_target_ms: u64,

    pub min_pool_size_sol: f64,
    pub require_null_mint_authority: bool,
    pub require_null_freeze_authority: bool,
    pub require_lp_burned: bool,
    pub block_token_2022_transfer_hooks: bool,
    pub block_fee_on_transfer: bool,

    pub compute_unit_limit: u32,
    pub priority_fee_micro_lamports: u64,
    pub min_tip_sol: f64,
    pub max_tip_sol: f64,

    pub take_profit_multiplier: f64,
    pub stop_loss_pct: f64,
    pub max_trade_fraction: f64,
    pub wallet_shards: u8,

    pub max_slots_behind: u64,
    pub enable_circuit_breaker: bool,
}

impl Config {
    pub fn from_env() -> Self {
        Self {
            watch_programs: split_list(var("WATCH_PROGRAMS", "raydium,pumpfun")),
            commitment: var("COMMITMENT", "processed"),
            target_discriminators: split_list(var("TARGET_EVENT_DISCRIMINATORS", "initialize_pool,add_liquidity")),
            event_detection_target_ms: parse("EVENT_DETECTION_TARGET_MS", 50u64),
            loop_target_ms: parse("LOOP_TARGET_MS", 200u64),

            min_pool_size_sol: parse("MIN_POOL_SIZE_SOL", 90f64),
            require_null_mint_authority: parse("REQUIRE_NULL_MINT_AUTHORITY", true),
            require_null_freeze_authority: parse("REQUIRE_NULL_FREEZE_AUTHORITY", true),
            require_lp_burned: parse("REQUIRE_LP_BURNED", true),
            block_token_2022_transfer_hooks: parse("BLOCK_TOKEN_2022_TRANSFER_HOOKS", true),
            block_fee_on_transfer: parse("BLOCK_FEE_ON_TRANSFER", true),

            compute_unit_limit: parse("COMPUTE_UNIT_LIMIT", 350_000u32),
            priority_fee_micro_lamports: parse("PRIORITY_FEE_MICRO_LAMPORTS", 500_000u64),
            min_tip_sol: parse("MIN_TIP_SOL", 0.01f64),
            max_tip_sol: parse("MAX_TIP_SOL", 0.10f64),

            take_profit_multiplier: parse("TAKE_PROFIT_MULTIPLIER", 2.0f64),
            stop_loss_pct: parse("STOP_LOSS_PCT", 0.12f64),
            max_trade_fraction: parse("MAX_TRADE_FRACTION", 0.02f64),
            wallet_shards: parse("WALLET_SHARDS", 5u8),

            max_slots_behind: parse("MAX_SLOTS_BEHIND", 3u64),
            enable_circuit_breaker: parse("ENABLE_CIRCUIT_BREAKER", true),
        }
    }
}

fn var(key: &str, default_value: &str) -> String {
    env::var(key).unwrap_or_else(|_| default_value.to_string())
}

fn parse<T>(key: &str, default_value: T) -> T
where
    T: std::str::FromStr,
{
    env::var(key)
        .ok()
        .and_then(|v| v.parse::<T>().ok())
        .unwrap_or(default_value)
}

fn split_list(raw: String) -> Vec<String> {
    raw.split(',')
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty())
        .collect()
}
