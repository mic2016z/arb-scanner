use std::time::Instant;

use tokio::time::{sleep, Duration};

use crate::config::Config;

#[derive(Clone, Debug)]
pub struct LaunchEvent {
    pub program: String,
    pub discriminator: String,
    pub detected_latency_ms: u64,
    pub pool_size_sol: f64,
    pub mint_authority_is_null: bool,
    pub freeze_authority_is_null: bool,
    pub lp_supply_ui_amount: f64,
    pub token_2022_has_transfer_hook: bool,
    pub token_has_fee_on_transfer: bool,
}

pub struct EventDetector {
    cfg: Config,
}

impl EventDetector {
    pub fn new(cfg: Config) -> Self {
        Self { cfg }
    }

    pub async fn next_event(&mut self) -> Option<LaunchEvent> {
        let start = Instant::now();

        // Placeholder stream: replace with Yellowstone Geyser subscription + shred ingestion.
        sleep(Duration::from_millis(25)).await;

        let elapsed = start.elapsed().as_millis() as u64;
        let program = self.cfg.watch_programs.first()?.clone();
        let discriminator = self.cfg.target_discriminators.first()?.clone();

        Some(LaunchEvent {
            program,
            discriminator,
            detected_latency_ms: elapsed,
            pool_size_sol: 120.0,
            mint_authority_is_null: true,
            freeze_authority_is_null: true,
            lp_supply_ui_amount: 0.0,
            token_2022_has_transfer_hook: false,
            token_has_fee_on_transfer: false,
        })
    }
}
