use anyhow::Result;

use crate::{config::Config, detector::LaunchEvent};

pub struct RiskEngine {
    cfg: Config,
}

impl RiskEngine {
    pub fn new(cfg: Config) -> Self {
        Self { cfg }
    }

    pub async fn accept(&self, event: &LaunchEvent) -> Result<bool> {
        if event.pool_size_sol < self.cfg.min_pool_size_sol {
            tracing::warn!(pool_size_sol = event.pool_size_sol, "blocked: pool below minimum");
            return Ok(false);
        }
        if self.cfg.require_null_mint_authority && !event.mint_authority_is_null {
            tracing::warn!("blocked: mint authority is not null");
            return Ok(false);
        }
        if self.cfg.require_null_freeze_authority && !event.freeze_authority_is_null {
            tracing::warn!("blocked: freeze authority is not null");
            return Ok(false);
        }
        if self.cfg.require_lp_burned && event.lp_supply_ui_amount != 0.0 {
            tracing::warn!(lp_supply_ui_amount = event.lp_supply_ui_amount, "blocked: LP supply not burned");
            return Ok(false);
        }
        if self.cfg.block_token_2022_transfer_hooks && event.token_2022_has_transfer_hook {
            tracing::warn!("blocked: token-2022 transfer hook detected");
            return Ok(false);
        }
        if self.cfg.block_fee_on_transfer && event.token_has_fee_on_transfer {
            tracing::warn!("blocked: fee-on-transfer detected");
            return Ok(false);
        }
        Ok(true)
    }
}
