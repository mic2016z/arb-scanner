mod config;
mod detector;
mod execution;
mod risk;
mod runtime;
mod telemetry;

use anyhow::Result;
use detector::EventDetector;
use execution::Executor;
use risk::RiskEngine;
use telemetry::Telemetry;

#[tokio::main(flavor = "multi_thread")]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let cfg = config::Config::from_env();
    runtime::log_runtime_targets(&cfg);

    let mut detector = EventDetector::new(cfg.clone());
    let risk = RiskEngine::new(cfg.clone());
    let mut executor = Executor::new(cfg.clone());
    let mut telemetry = Telemetry::new(cfg);

    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {
                tracing::info!("shutdown requested");
                break;
            }
            maybe_event = detector.next_event() => {
                let event = match maybe_event {
                    Some(e) => e,
                    None => continue,
                };

                telemetry.observe_detection_latency(event.detected_latency_ms);
                if !risk.accept(&event).await? {
                    telemetry.inc_blocked();
                    continue;
                }

                executor.submit_bundle(&event).await?;
                telemetry.inc_executed();
            }
        }
    }

    Ok(())
}
