import type { AppConfig } from "../../src/config.js";

const defaults: AppConfig = {
  port: 0,
  host: "127.0.0.1",
  upstreamBaseUrl: undefined,
  providerTargets: {},
  routingRules: { pathPrefixes: {}, headers: [] },
  rpm: 60,
  effectiveRpm: 60,
  refillPerSec: 1,
  bucketKeyMode: "global",
  maxQueueDepth: 200,
  maxQueueWaitMs: 60_000,
  upstreamToken: undefined,
  safetyFactor: 1,
  logLevel: "error"
};

export function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return { ...defaults, ...overrides };
}
