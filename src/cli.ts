#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin, stderr, stdout, loadEnvFile } from "node:process";
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ZodError } from "zod";

import { DEFAULT_PROVIDER_TARGETS_FILE, loadConfig } from "./config.js";
import { createLiveMonitorHooks } from "./liveMonitor.js";
import { collectAllowedHosts, startServer, summarizeConfig } from "./server.js";
import { readPackageVersion } from "./version.js";

type CliArgs = {
  port?: string;
  host?: string;
  rpm?: string;
  upstreamUrl?: string;
  providerTargets?: string;
  providerTargetsFile?: string;
  bucketKey?: string;
  maxQueueDepth?: string;
  maxQueueWaitMs?: string;
  maxRetryAfterMs?: string;
  logLevel?: string;
  safetyFactor?: string;
  live: boolean;
  yes: boolean;
};

export class CliArgError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CliArgError";
  }
}

type ValueFlagSpec = { key: keyof CliArgs; env: string };
const VALUE_FLAGS: Record<string, ValueFlagSpec> = {
  "--port": { key: "port", env: "ORMUZ_PORT" },
  "--host": { key: "host", env: "ORMUZ_HOST" },
  "--rpm": { key: "rpm", env: "ORMUZ_RPM" },
  "--upstream-url": { key: "upstreamUrl", env: "ORMUZ_UPSTREAM_BASE_URL" },
  "--provider-targets": { key: "providerTargets", env: "ORMUZ_PROVIDER_TARGETS" },
  "--provider-targets-file": { key: "providerTargetsFile", env: "ORMUZ_PROVIDER_TARGETS_FILE" },
  "--bucket-key": { key: "bucketKey", env: "ORMUZ_BUCKET_KEY" },
  "--max-queue-depth": { key: "maxQueueDepth", env: "ORMUZ_MAX_QUEUE_DEPTH" },
  "--max-queue-wait-ms": { key: "maxQueueWaitMs", env: "ORMUZ_MAX_QUEUE_WAIT_MS" },
  "--max-retry-after-ms": { key: "maxRetryAfterMs", env: "ORMUZ_MAX_RETRY_AFTER_MS" },
  "--log-level": { key: "logLevel", env: "ORMUZ_LOG_LEVEL" },
  "--safety-factor": { key: "safetyFactor", env: "ORMUZ_SAFETY_FACTOR" }
};

const VALID_BUCKET_KEYS = ["auth", "global", "model", "host"] as const;
const VALID_LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace"] as const;

const HELP_TEXT = `Ormuz — client-side LLM forward proxy

Usage:
  ormuz [options]

Options:
  --port <n>                    HTTP port (default 8787)
  --host <addr>                 Bind address (default 127.0.0.1; use 0.0.0.0 to expose on the network)
  --rpm <n>                     Upstream requests-per-minute target
  --safety-factor <0..1>        Headroom multiplier on RPM (default 0.95)
  --upstream-url <url>          Fallback upstream when no provider matches
  --provider-targets <json>     Inline provider/route JSON
  --provider-targets-file <p>   Path to providers JSON/YAML (default: config/provider-targets.json if present)
  --bucket-key <auth|global|model|host>  Rate-limit bucketing strategy
  --max-queue-depth <n>         Per-bucket queue cap (default 200)
  --max-queue-wait-ms <ms>      Reject if projected wait exceeds this (default 60000)
  --max-retry-after-ms <ms>     Cap upstream Retry-After pauses
  --log-level <level>           fatal|error|warn|info|debug|trace (default info)
  --live                        Render a live monitor in stdout
  --yes                         Skip interactive prompts
  --print-hosts                 Print one allowed upstream host per line and exit
  --print-config                Print the resolved config as JSON and exit (no server start)
  -v, --version                 Print version and exit
  -h, --help                    Show this help

Environment variables (ORMUZ_*) override defaults; CLI flags override env.
Docs: https://github.com/grebmann1/ormuz-proxy`;

export function parseArgs(argv: string[]): CliArgs | "help" | "version" | "print-hosts" | "print-config" {
  const args: CliArgs = { yes: false, live: false };
  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    if (current === undefined) {
      continue;
    }
    if (current === "-h" || current === "--help") {
      return "help";
    }
    if (current === "-v" || current === "--version") {
      return "version";
    }
    if (current === "--print-hosts") {
      return "print-hosts";
    }
    if (current === "--print-config") {
      return "print-config";
    }
    if (current === "--yes") {
      args.yes = true;
      continue;
    }
    if (current === "--live") {
      args.live = true;
      continue;
    }
    const spec = VALUE_FLAGS[current];
    if (spec) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new CliArgError(`Flag ${current} expects a value but none was provided.`);
      }
      (args as Record<string, unknown>)[spec.key] = next;
      i += 1;
      continue;
    }
    throw new CliArgError(`Unknown argument: ${current}. Run --help to see supported flags.`);
  }

  if (args.bucketKey && !(VALID_BUCKET_KEYS as readonly string[]).includes(args.bucketKey)) {
    throw new CliArgError(
      `Invalid --bucket-key '${args.bucketKey}'. Expected one of: ${VALID_BUCKET_KEYS.join(", ")}.`
    );
  }
  if (args.logLevel && !(VALID_LOG_LEVELS as readonly string[]).includes(args.logLevel)) {
    throw new CliArgError(
      `Invalid --log-level '${args.logLevel}'. Expected one of: ${VALID_LOG_LEVELS.join(", ")}.`
    );
  }

  return args;
}

async function promptForMissing(args: CliArgs): Promise<CliArgs> {
  if (args.yes) {
    return args;
  }

  const hasDefaultProviderFile = existsSync(resolve(process.cwd(), DEFAULT_PROVIDER_TARGETS_FILE));
  const needsUpstreamPrompt =
    !args.upstreamUrl && !args.providerTargets && !args.providerTargetsFile && !hasDefaultProviderFile;
  if (!needsUpstreamPrompt) {
    return args;
  }

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    args.upstreamUrl = await rl.question("Fallback upstream URL (optional when provider targets set): ");
  } finally {
    rl.close();
  }

  return args;
}

function loadDotEnvIfPresent(): void {
  const envPath = resolve(process.cwd(), ".env");
  if (!existsSync(envPath)) {
    return;
  }
  try {
    loadEnvFile(envPath);
  } catch (error) {
    stderr.write(`warning: failed to load .env: ${(error as Error).message}\n`);
  }
}

export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  let parsed1: ReturnType<typeof parseArgs>;
  try {
    parsed1 = parseArgs(argv);
  } catch (error) {
    if (error instanceof CliArgError) {
      stderr.write(`Ormuz: ${error.message}\n`);
      process.exit(2);
    }
    throw error;
  }
  if (parsed1 === "help") {
    stdout.write(`${HELP_TEXT}\n`);
    return;
  }
  if (parsed1 === "version") {
    stdout.write(`${readPackageVersion()}\n`);
    return;
  }
  if (parsed1 === "print-hosts") {
    loadDotEnvIfPresent();
    try {
      const config = loadConfig();
      const hosts = [...collectAllowedHosts(config)].sort();
      stdout.write(`${hosts.join("\n")}\n`);
    } catch (error) {
      printConfigError(error);
      process.exit(1);
    }
    return;
  }
  if (parsed1 === "print-config") {
    loadDotEnvIfPresent();
    try {
      const config = loadConfig();
      stdout.write(`${JSON.stringify(summarizeConfig(config), null, 2)}\n`);
    } catch (error) {
      printConfigError(error);
      process.exit(1);
    }
    return;
  }
  const parsed = await promptForMissing(parsed1);

  loadDotEnvIfPresent();

  const envOverrides: NodeJS.ProcessEnv = {
    ...process.env
  };
  for (const spec of Object.values(VALUE_FLAGS)) {
    const value = parsed[spec.key];
    if (typeof value === "string" && value.length > 0) {
      envOverrides[spec.env] = value;
    }
  }

  let config;
  try {
    config = loadConfig(envOverrides);
  } catch (error) {
    printConfigError(error);
    process.exit(1);
  }
  const hooks = parsed.live ? createLiveMonitorHooks(config.port) : {};
  try {
    await startServer(config, hooks);
  } catch (error) {
    printStartupError(error, config.host, config.port);
    process.exit(1);
  }
}

function printStartupError(error: unknown, host: string, port: number): void {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "EADDRINUSE") {
    stderr.write(
      `Ormuz startup error: ${host}:${port} is already in use.\n` +
        `Pick another port with --port (or ORMUZ_PORT). To find what's holding it: 'lsof -nP -i :${port}'.\n`
    );
    return;
  }
  if (code === "EACCES") {
    stderr.write(
      `Ormuz startup error: permission denied binding ${host}:${port} (typically only privileged ports <1024).\n` +
        `Use a port >=1024 with --port (or ORMUZ_PORT).\n`
    );
    return;
  }
  stderr.write(`Ormuz startup error: ${(error as Error).message ?? String(error)}\n`);
}

function printConfigError(error: unknown): void {
  if (error instanceof ZodError) {
    stderr.write("Ormuz config error:\n");
    for (const issue of error.issues) {
      const where = issue.path.join(".") || "(root)";
      stderr.write(`  ${where}: ${issue.message}\n`);
    }
    stderr.write("\nRun with --help to see available flags, or check your ORMUZ_* env vars.\n");
    return;
  }
  stderr.write(`Ormuz config error: ${(error as Error).message ?? String(error)}\n`);
}

function isMainModule(): boolean {
  if (!process.argv[1]) {
    return false;
  }
  try {
    const moduleFile = fileURLToPath(import.meta.url);
    return realpathSync(moduleFile) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  void runCli();
}
