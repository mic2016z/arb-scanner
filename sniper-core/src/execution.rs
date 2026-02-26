use anyhow::Result;

use crate::{config::Config, detector::LaunchEvent};

pub struct Executor {
    cfg: Config,
}

impl Executor {
    pub fn new(cfg: Config) -> Self {
        Self { cfg }
    }

    pub async fn submit_bundle(&mut self, event: &LaunchEvent) -> Result<()> {
        // Replace with real transaction assembly:
        // 1) ComputeBudgetProgram.setComputeUnitLimit
        // 2) ComputeBudgetProgram.setComputeUnitPrice
        // 3) Swap instruction
        // 4) Optional Jito tip transfer instruction
        tracing::info!(
            program = event.program,
            discriminator = event.discriminator,
            cu_limit = self.cfg.compute_unit_limit,
            cu_price = self.cfg.priority_fee_micro_lamports,
            min_tip_sol = self.cfg.min_tip_sol,
            max_tip_sol = self.cfg.max_tip_sol,
            "execution intent created"
        );
        Ok(())
    }
}
