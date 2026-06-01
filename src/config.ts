import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";

const bucketKeySchema = z.enum(["auth", "global", "model", "host"]);
const providerTargetsSchema = z.record(z.string().min(1), z.string().url());
const headerRouteRuleSchema = z.object({
  header: z.string().min(1),
  value: z.string(),
  target: z.string().url()
});
const routingRulesSchema = z.object({
  pathPrefixes: z.record(z.string().min(1), z.string().url()).default({}),
  headers: z.array(headerRouteRuleSchema).default([])
});
const providerRoutingConfigSchema = z.object({
  routes: routingRulesSchema.default({ pathPrefixes: {}, headers: [] }),
  providers: providerTargetsSchema.default({})
}).strict();
export const DEFAULT_PROVIDER_TARGETS_FILE = "config/provider-targets.json";

const schema = z.object({
  ORMUZ_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  ORMUZ_UPSTREAM_BASE_URL: z.string().url().optional(),
  ORMUZ_UPSTREAM_TOKEN: z.string().optional(),
  ORMUZ_PROVIDER_TARGETS: z.string().optional(),
  ORMUZ_PROVIDER_TARGETS_FILE: z.string().optional(),
  ORMUZ_RPM: z.coerce.number().positive().default(60),
  ORMUZ_SAFETY_FACTOR: z.coerce.number().positive().max(1).default(0.95),
  ORMUZ_BUCKET_KEY: bucketKeySchema.default("auth"),
  ORMUZ_MAX_QUEUE_DEPTH: z.coerce.number().int().positive().default(200),
  ORMUZ_MAX_QUEUE_WAIT_MS: z.coerce.number().int().positive().default(60_000),
  ORMUZ_MAX_RETRY_AFTER_MS: z.coerce.number().int().positive().optional(),
  ORMUZ_LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info")
});

export type BucketKeyMode = z.infer<typeof bucketKeySchema>;
export type AppConfig = {
  port: number;
  upstreamBaseUrl?: string;
  upstreamToken?: string;
  providerTargets: Record<string, string>;
  routingRules: RoutingRules;
  rpm: number;
  safetyFactor: number;
  effectiveRpm: number;
  refillPerSec: number;
  bucketKeyMode: BucketKeyMode;
  maxQueueDepth: number;
  maxQueueWaitMs: number;
  maxRetryAfterMs?: number;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace";
};
export type HeaderRouteRule = {
  header: string;
  value: string;
  target: string;
};
export type RoutingRules = {
  pathPrefixes: Record<string, string>;
  headers: HeaderRouteRule[];
};

function parseYamlLikeObject(input: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = input.split("\n");
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const separatorIndex = line.indexOf(":");
    if (separatorIndex <= 0) {
      continue;
    }
    const key = line.slice(0, separatorIndex).trim();
    const rawValue = line.slice(separatorIndex + 1).trim();
    const value = rawValue.replace(/^['"]|['"]$/g, "");
    if (key && value) {
      result[key] = value;
    }
  }
  return result;
}

function parseProviderTargetsValue(raw: string, source: string): { providerTargets: Record<string, string>; routingRules: RoutingRules } {
  try {
    const parsed = JSON.parse(raw) as unknown;
    const hasStructuredKeys =
      typeof parsed === "object" && parsed !== null && ("providers" in parsed || "routes" in parsed);
    if (hasStructuredKeys) {
      const parsedWithRoutes = providerRoutingConfigSchema.parse(parsed);
      return {
        providerTargets: parsedWithRoutes.providers,
        routingRules: normalizeRoutingRules(parsedWithRoutes.routes)
      };
    }

    const legacyTargets = providerTargetsSchema.parse(parsed);
    return {
      providerTargets: legacyTargets,
      routingRules: normalizeRoutingRules({
        pathPrefixes: Object.fromEntries(
          Object.entries(legacyTargets).map(([provider, target]) => [`/v1/${provider.toLowerCase()}`, target])
        ),
        headers: []
      })
    };
  } catch {
    const ext = extname(source).toLowerCase();
    if (ext === ".yaml" || ext === ".yml") {
      const yamlObject = parseYamlLikeObject(raw);
      const legacyTargets = providerTargetsSchema.parse(yamlObject);
      return {
        providerTargets: legacyTargets,
        routingRules: normalizeRoutingRules({
          pathPrefixes: Object.fromEntries(
            Object.entries(legacyTargets).map(([provider, target]) => [`/v1/${provider.toLowerCase()}`, target])
          ),
          headers: []
        })
      };
    }
    throw new Error(`Unable to parse provider targets from ${source}. Expected JSON, YAML, or YML.`);
  }
}

function normalizeRoutingRules(rules: RoutingRules): RoutingRules {
  return {
    pathPrefixes: Object.fromEntries(
      Object.entries(rules.pathPrefixes).map(([prefix, target]) => [prefix.startsWith("/") ? prefix : `/${prefix}`, target])
    ),
    headers: rules.headers.map((rule) => ({
      header: rule.header.toLowerCase(),
      value: rule.value,
      target: rule.target
    }))
  };
}

function loadProviderTargets(env: NodeJS.ProcessEnv): { providerTargets: Record<string, string>; routingRules: RoutingRules } {
  const envProviderTargets = env.ORMUZ_PROVIDER_TARGETS?.trim();
  const fromEnv = envProviderTargets
    ? parseProviderTargetsValue(envProviderTargets, "ORMUZ_PROVIDER_TARGETS")
    : { providerTargets: {}, routingRules: normalizeRoutingRules({ pathPrefixes: {}, headers: [] }) };
  const explicitFile = env.ORMUZ_PROVIDER_TARGETS_FILE?.trim() || undefined;
  const defaultFilePath = resolve(process.cwd(), DEFAULT_PROVIDER_TARGETS_FILE);
  const useDefaultFile = !explicitFile && !envProviderTargets;
  const effectiveFile = explicitFile ?? (useDefaultFile && existsSync(defaultFilePath) ? defaultFilePath : undefined);

  const fromFile = effectiveFile
    ? parseProviderTargetsValue(readFileSync(effectiveFile, "utf-8"), effectiveFile)
    : { providerTargets: {}, routingRules: normalizeRoutingRules({ pathPrefixes: {}, headers: [] }) };
  return {
    providerTargets: { ...fromEnv.providerTargets, ...fromFile.providerTargets },
    routingRules: normalizeRoutingRules({
      pathPrefixes: { ...fromEnv.routingRules.pathPrefixes, ...fromFile.routingRules.pathPrefixes },
      headers: [...fromEnv.routingRules.headers, ...fromFile.routingRules.headers]
    })
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.parse(env);
  const effectiveRpm = Math.max(1, Math.floor(parsed.ORMUZ_RPM * parsed.ORMUZ_SAFETY_FACTOR));
  const upstreamToken = parsed.ORMUZ_UPSTREAM_TOKEN?.trim();
  const providerConfig = loadProviderTargets(env);

  return {
    port: parsed.ORMUZ_PORT,
    upstreamBaseUrl: parsed.ORMUZ_UPSTREAM_BASE_URL?.replace(/\/+$/, ""),
    upstreamToken: upstreamToken && upstreamToken.length > 0 ? upstreamToken : undefined,
    providerTargets: providerConfig.providerTargets,
    routingRules: providerConfig.routingRules,
    rpm: parsed.ORMUZ_RPM,
    safetyFactor: parsed.ORMUZ_SAFETY_FACTOR,
    effectiveRpm,
    refillPerSec: effectiveRpm / 60,
    bucketKeyMode: parsed.ORMUZ_BUCKET_KEY,
    maxQueueDepth: parsed.ORMUZ_MAX_QUEUE_DEPTH,
    maxQueueWaitMs: parsed.ORMUZ_MAX_QUEUE_WAIT_MS,
    maxRetryAfterMs: parsed.ORMUZ_MAX_RETRY_AFTER_MS,
    logLevel: parsed.ORMUZ_LOG_LEVEL
  };
}
