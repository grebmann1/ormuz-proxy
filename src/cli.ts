import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { DEFAULT_PROVIDER_TARGETS_FILE, loadConfig } from "./config.js";
import type { OrmuzHooks } from "./hooks.js";
import { startServer } from "./server.js";

type CliArgs = {
  port?: string;
  rpm?: string;
  upstreamUrl?: string;
  providerTargets?: string;
  providerTargetsFile?: string;
  bucketKey?: string;
  maxQueueDepth?: string;
  maxQueueWaitMs?: string;
  logLevel?: string;
  safetyFactor?: string;
  live: boolean;
  yes: boolean;
};

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { yes: false, live: false };
  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    const next = argv[i + 1];
    switch (current) {
      case "--port":
        args.port = next;
        i += 1;
        break;
      case "--rpm":
        args.rpm = next;
        i += 1;
        break;
      case "--upstream-url":
        args.upstreamUrl = next;
        i += 1;
        break;
      case "--provider-targets":
        args.providerTargets = next;
        i += 1;
        break;
      case "--provider-targets-file":
        args.providerTargetsFile = next;
        i += 1;
        break;
      case "--bucket-key":
        args.bucketKey = next;
        i += 1;
        break;
      case "--max-queue-depth":
        args.maxQueueDepth = next;
        i += 1;
        break;
      case "--max-queue-wait-ms":
        args.maxQueueWaitMs = next;
        i += 1;
        break;
      case "--log-level":
        args.logLevel = next;
        i += 1;
        break;
      case "--safety-factor":
        args.safetyFactor = next;
        i += 1;
        break;
      case "--yes":
        args.yes = true;
        break;
      case "--live":
        args.live = true;
        break;
      default:
        break;
    }
  }
  return args;
}

async function promptForMissing(args: CliArgs): Promise<CliArgs> {
  if (args.yes) {
    return args;
  }

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const hasDefaultProviderFile = existsSync(resolve(process.cwd(), DEFAULT_PROVIDER_TARGETS_FILE));
    if (!args.rpm) {
      args.rpm = await rl.question("RPM limit (e.g. 120): ");
    }
    if (!args.upstreamUrl && !args.providerTargets && !args.providerTargetsFile && !hasDefaultProviderFile) {
      args.upstreamUrl = await rl.question("Fallback upstream URL (optional when provider targets set): ");
    }
  } finally {
    rl.close();
  }

  return args;
}

export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  const parsed = await promptForMissing(parseArgs(argv));

  const envOverrides: NodeJS.ProcessEnv = {
    ...process.env
  };
  if (parsed.port) envOverrides.ORMUZ_PORT = parsed.port;
  if (parsed.rpm) envOverrides.ORMUZ_RPM = parsed.rpm;
  if (parsed.upstreamUrl) envOverrides.ORMUZ_UPSTREAM_BASE_URL = parsed.upstreamUrl;
  if (parsed.providerTargets) envOverrides.ORMUZ_PROVIDER_TARGETS = parsed.providerTargets;
  if (parsed.providerTargetsFile) envOverrides.ORMUZ_PROVIDER_TARGETS_FILE = parsed.providerTargetsFile;
  if (parsed.bucketKey) envOverrides.ORMUZ_BUCKET_KEY = parsed.bucketKey;
  if (parsed.maxQueueDepth) envOverrides.ORMUZ_MAX_QUEUE_DEPTH = parsed.maxQueueDepth;
  if (parsed.maxQueueWaitMs) envOverrides.ORMUZ_MAX_QUEUE_WAIT_MS = parsed.maxQueueWaitMs;
  if (parsed.logLevel) envOverrides.ORMUZ_LOG_LEVEL = parsed.logLevel;
  if (parsed.safetyFactor) envOverrides.ORMUZ_SAFETY_FACTOR = parsed.safetyFactor;

  const config = loadConfig(envOverrides);
  const hooks = parsed.live ? createLiveMonitorHooks(config.port) : {};
  await startServer(config, hooks);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void runCli();
}

function createLiveMonitorHooks(port: number): OrmuzHooks {
  const startedAt = Date.now();
  let totalRequests = 0;
  let completedRequests = 0;
  let local429 = 0;
  let upstream429 = 0;
  let inFlight = 0;
  const statusCounts = new Map<number, number>();
  const providerCounts = new Map<string, number>();
  const endpointCounts = new Map<string, number>();
  const queueDepthByBucket = new Map<string, number>();

  const formatTop = (map: Map<string, number>, limit = 5): string => {
    const top = [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit);
    if (top.length === 0) {
      return "-";
    }
    return top.map(([key, value]) => `${key}:${value}`).join(" | ");
  };

  const formatStatuses = (): string => {
    const items = [...statusCounts.entries()].sort((a, b) => a[0] - b[0]);
    if (items.length === 0) {
      return "-";
    }
    return items.map(([code, count]) => `${code}:${count}`).join(" ");
  };

  const render = (): void => {
    const elapsedSec = Math.max(1, Math.floor((Date.now() - startedAt) / 1000));
    const rps = (completedRequests / elapsedSec).toFixed(2);
    const queueDepth = [...queueDepthByBucket.values()].reduce((sum, value) => sum + value, 0);
    const lines = [
      `Ormuz live monitor  http://127.0.0.1:${port}`,
      `uptime=${elapsedSec}s  completed=${completedRequests}  rps=${rps}  inFlight=${inFlight}  queueDepth=${queueDepth}`,
      `local429=${local429}  upstream429=${upstream429}  totalSeen=${totalRequests}`,
      `status: ${formatStatuses()}`,
      `providers: ${formatTop(providerCounts)}`,
      `endpoints: ${formatTop(endpointCounts)}`,
      "Press Ctrl+C to stop."
    ];
    stdout.write("\x1Bc");
    stdout.write(`${lines.join("\n")}\n`);
  };

  const timer = setInterval(render, 1000);
  timer.unref();
  render();

  process.once("SIGINT", () => clearInterval(timer));
  process.once("SIGTERM", () => clearInterval(timer));

  return {
    onRequestReceived: ({ originalPath }) => {
      totalRequests += 1;
      inFlight += 1;
      endpointCounts.set(originalPath, (endpointCounts.get(originalPath) ?? 0) + 1);
    },
    onProviderResolved: ({ provider }) => {
      if (!provider) {
        return;
      }
      providerCounts.set(provider, (providerCounts.get(provider) ?? 0) + 1);
    },
    onQueued: ({ bucketKey, queueDepth: depth }) => {
      if (!bucketKey || depth === undefined) {
        return;
      }
      queueDepthByBucket.set(bucketKey, depth);
    },
    onUpstream429: () => {
      upstream429 += 1;
    },
    onForwardResult: ({ statusCode }) => {
      if (statusCode === undefined) {
        return;
      }
      statusCounts.set(statusCode, (statusCounts.get(statusCode) ?? 0) + 1);
    },
    onRequestCompleted: ({ statusCode, bucketKey }) => {
      completedRequests += 1;
      inFlight = Math.max(0, inFlight - 1);
      if (statusCode === 429) {
        local429 += 1;
      }
      if (bucketKey) {
        queueDepthByBucket.delete(bucketKey);
      }
    }
  };
}
