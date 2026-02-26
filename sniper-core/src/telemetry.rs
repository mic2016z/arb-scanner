use crate::config::Config;

pub struct Telemetry {
    cfg: Config,
    blocked: u64,
    executed: u64,
}

impl Telemetry {
    pub fn new(cfg: Config) -> Self {
        Self {
            cfg,
            blocked: 0,
            executed: 0,
        }
    }

    pub fn observe_detection_latency(&self, latency_ms: u64) {
        if latency_ms > self.cfg.event_detection_target_ms {
            tracing::warn!(latency_ms, target_ms = self.cfg.event_detection_target_ms, "detection latency above target");
        } else {
            tracing::debug!(latency_ms, "detection latency within target");
        }
    }

    pub fn inc_blocked(&mut self) {
        self.blocked += 1;
        tracing::info!(blocked = self.blocked, executed = self.executed, "risk blocked event");
    }

    pub fn inc_executed(&mut self) {
        self.executed += 1;
        tracing::info!(blocked = self.blocked, executed = self.executed, "execution sent");
    }
}
