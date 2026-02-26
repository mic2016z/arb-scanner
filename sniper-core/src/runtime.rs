use crate::config::Config;

pub fn log_runtime_targets(cfg: &Config) {
    tracing::info!(
        watch_programs = ?cfg.watch_programs,
        commitment = cfg.commitment,
        target_loop_ms = cfg.loop_target_ms,
        detect_target_ms = cfg.event_detection_target_ms,
        "tokio runtime initialized for low-latency event loop"
    );
}
