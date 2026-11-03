// The process-wide AI Co-host orchestrator, built from server configuration.
import { config } from '../config.ts';
import { getDb } from '../db/index.ts';
import { configuredProviders } from './providers.ts';
import { createOrchestrator, dbRecorder, type Orchestrator } from './orchestrator.ts';

let instance: Orchestrator | null = null;

export async function ai(): Promise<Orchestrator> {
  if (instance) return instance;
  const cfg = config().ai;
  const db = await getDb();
  instance = createOrchestrator({
    providers: configuredProviders(cfg),
    timeoutMs: cfg.timeoutMs,
    deadlineMs: cfg.deadlineMs,
    maxConcurrency: cfg.maxConcurrency,
    breaker: { failures: cfg.breakerFailures, openMs: cfg.breakerOpenMs },
    record: dbRecorder(db),
  });
  return instance;
}

// Tests install an orchestrator with fake providers.
export function setAi(orchestrator: Orchestrator) {
  instance = orchestrator;
}

export function aiStatus() {
  const cfg = config().ai;
  const providers = configuredProviders(cfg);
  return {
    available: providers.length > 0,
    primary: providers[0] ? `${providers[0].name}:${providers[0].model}` : null,
    fallback: providers[1] ? `${providers[1].name}:${providers[1].model}` : null,
  };
}
