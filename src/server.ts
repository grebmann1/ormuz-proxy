import Fastify, { type FastifyInstance } from "fastify";

import { loadConfig, type AppConfig } from "./config.js";
import { createConnectHandler } from "./connect.js";
import { HookRegistry, type OrmuzHooks } from "./hooks.js";
import { OrmuzMetrics } from "./metrics.js";
import { resolveConfiguredRoute, resolveProviderRoute } from "./providerRouter.js";
import { deriveBucketKey, forwardRequest } from "./proxy.js";
import { RequestScheduler, type SchedulerHooks, type SubmitHooks } from "./scheduler.js";
import { QueueRejectedError } from "./types.js";
import { readPackageVersion } from "./version.js";

function safeHostname(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function parseBodyForBucket(body: Buffer, contentType: string | undefined): unknown {
  if (!contentType?.includes("application/json") || body.length === 0) {
    return undefined;
  }

  try {
    return JSON.parse(body.toString("utf-8"));
  } catch {
    return undefined;
  }
}

export function summarizeConfig(config: AppConfig): Record<string, unknown> {
  return {
    port: config.port,
    host: config.host,
    rpm: config.rpm,
    safetyFactor: config.safetyFactor,
    effectiveRpm: config.effectiveRpm,
    bucketKeyMode: config.bucketKeyMode,
    maxQueueDepth: config.maxQueueDepth,
    maxQueueWaitMs: config.maxQueueWaitMs,
    maxRetryAfterMs: config.maxRetryAfterMs ?? null,
    logLevel: config.logLevel,
    upstreamBaseUrl: config.upstreamBaseUrl ?? null,
    upstreamTokenSet: Boolean(config.upstreamToken),
    providers: config.providerTargets,
    routes: {
      pathPrefixes: config.routingRules.pathPrefixes,
      headerRules: config.routingRules.headers.map((rule) => `${rule.header}=${rule.value}`)
    }
  };
}

export function collectAllowedHosts(config: AppConfig): Set<string> {
  const hosts = new Set<string>();
  const addUrl = (url: string | undefined): void => {
    if (!url) {
      return;
    }
    const host = safeHostname(url);
    if (host) {
      hosts.add(host);
    }
  };
  addUrl(config.upstreamBaseUrl);
  for (const target of Object.values(config.providerTargets)) {
    addUrl(target);
  }
  for (const target of Object.values(config.routingRules.pathPrefixes)) {
    addUrl(target);
  }
  for (const rule of config.routingRules.headers) {
    addUrl(rule.target);
  }
  return hosts;
}

export function buildApp(config: AppConfig, hooks: OrmuzHooks = {}): FastifyInstance {
  const app = Fastify({
    logger: {
      level: config.logLevel
    }
  });
  const metrics = new OrmuzMetrics();
  const hookRegistry = new HookRegistry(hooks);

  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_request, payload, done) => {
    done(null, payload);
  });

  const schedulerHooks: SchedulerHooks = metrics.schedulerHooks();

  const scheduler = new RequestScheduler<void>({
    bucketCapacity: config.effectiveRpm,
    refillPerSec: config.refillPerSec,
    maxQueueDepth: config.maxQueueDepth,
    maxQueueWaitMs: config.maxQueueWaitMs,
    maxRetryAfterMs: config.maxRetryAfterMs,
    hooks: schedulerHooks
  });

  const startedAtMs = Date.now();
  app.get("/health", async () => ({
    ok: true,
    version: readPackageVersion(),
    uptimeSec: Math.floor((Date.now() - startedAtMs) / 1000)
  }));

  app.get("/config", async () => summarizeConfig(config));

  app.get("/metrics", async (_request, reply) => {
    reply.header("Content-Type", metrics.contentType());
    return metrics.snapshot();
  });

  const providerOrRouteConfigured =
    Object.keys(config.providerTargets).length > 0 ||
    Object.keys(config.routingRules.pathPrefixes).length > 0 ||
    config.routingRules.headers.length > 0;
  const supportedProviders = Object.keys(config.providerTargets).sort();
  const supportedPathPrefixes = Object.keys(config.routingRules.pathPrefixes).sort();
  const supportedHeaderRules = config.routingRules.headers.map((rule) => `${rule.header}=${rule.value}`);

  app.all("/v1/*", async (request, reply) => {
    const startedAt = Date.now();
    const requestId = String(request.id);
    const rawBody = (request.body as Buffer | undefined) ?? Buffer.alloc(0);
    const bodyForKey =
      config.bucketKeyMode === "model"
        ? parseBodyForBucket(rawBody, request.headers["content-type"])
        : undefined;
    const [splitPath, queryString = ""] = request.url.split("?");
    const originalPath = splitPath ?? "/";
    const configuredRoute = resolveConfiguredRoute(originalPath, request.headers, config.routingRules);
    const providerRoute = resolveProviderRoute(originalPath, config.providerTargets);
    const resolvedRoute = configuredRoute ?? providerRoute;
    const upstreamBaseUrl = resolvedRoute?.upstreamBaseUrl ?? config.upstreamBaseUrl;
    const pathOnly = resolvedRoute?.rewrittenPath ?? originalPath;
    const upstreamHost = upstreamBaseUrl ? safeHostname(upstreamBaseUrl) : undefined;
    const bucketKey = deriveBucketKey(config.bucketKeyMode, request.headers, bodyForKey, upstreamHost);
    hookRegistry.emitRequestReceived({
      requestId,
      method: request.method,
      originalPath,
      bucketKey
    });
    const baseHookPayload = {
      requestId,
      method: request.method,
      originalPath,
      bucketKey,
      provider: resolvedRoute?.provider,
      routeStrategy: resolvedRoute?.routeStrategy
    };

    if (!resolvedRoute && providerOrRouteConfigured) {
      return reply.code(400).send({
        error: "unmatched_route",
        message: "Unable to resolve route from headers/path.",
        supportedProviders,
        supportedPathPrefixes,
        supportedHeaderRules
      });
    }

    if (!upstreamBaseUrl) {
      return reply.code(500).send({
        error: "misconfigured_upstream",
        message: "No upstream target configured. Set provider targets or fallback upstream URL."
      });
    }

    if (resolvedRoute) {
      hookRegistry.emitProviderResolved({
        ...baseHookPayload,
        upstreamBaseUrl: resolvedRoute.upstreamBaseUrl,
        upstreamPath: resolvedRoute.rewrittenPath
      });
    }

    const submitHooks: SubmitHooks = {
      onQueued: (depth) => hookRegistry.emitQueued({ ...baseHookPayload, queueDepth: depth }),
      onUpstream429: (retryAfterMs) => hookRegistry.emitUpstream429({ ...baseHookPayload, retryAfterMs })
    };

    try {
      await scheduler.submit(
        bucketKey,
        (attempt) =>
          forwardRequest({
            upstreamBaseUrl,
            method: request.method,
            path: pathOnly,
            queryString,
            headers: request.headers,
            body: rawBody,
            reply,
            attempt,
            onForwardStart: () =>
              hookRegistry.emitForwardStart({
                ...baseHookPayload,
                upstreamBaseUrl,
                upstreamPath: pathOnly
              }),
            onUpstreamStatus: (code) => metrics.recordUpstreamStatus(code),
            onForwardResult: (statusCode) =>
              hookRegistry.emitForwardResult({ ...baseHookPayload, statusCode }),
            onForwarded: () => metrics.recordForwarded()
          }),
        submitHooks
      );
      hookRegistry.emitRequestCompleted({
        ...baseHookPayload,
        durationMs: Date.now() - startedAt,
        statusCode: reply.statusCode
      });
    } catch (error) {
      if (error instanceof QueueRejectedError) {
        reply.header("Retry-After", Math.ceil(error.retryAfterMs / 1000));
        return reply.code(429).send({
          error: "rate_limited",
          message: "Request rejected by local queue policy",
          retryAfterMs: error.retryAfterMs
        });
      }

      request.log.error({ err: error }, "proxy request failed");
      hookRegistry.emitRequestCompleted({
        ...baseHookPayload,
        durationMs: Date.now() - startedAt,
        statusCode: 500,
        error
      });
      return reply.code(500).send({
        error: "proxy_failure",
        message: "Unexpected proxy failure"
      });
    }
  });

  const handleConnect = createConnectHandler(scheduler, metrics, collectAllowedHosts(config));
  app.addHook("onListen", async () => {
    app.server.on("connect", handleConnect);
  });

  return app;
}

export async function startServer(config = loadConfig(), hooks: OrmuzHooks = {}): Promise<FastifyInstance> {
  const app = buildApp(config, hooks);
  await app.listen({ port: config.port, host: config.host });

  const noRouting =
    !config.upstreamBaseUrl &&
    Object.keys(config.providerTargets).length === 0 &&
    Object.keys(config.routingRules.pathPrefixes).length === 0 &&
    config.routingRules.headers.length === 0;
  if (noRouting) {
    app.log.warn(
      "No provider targets, path-prefix routes, header rules, or fallback ORMUZ_UPSTREAM_BASE_URL configured. Every /v1/* request will return 500 until you set ORMUZ_PROVIDER_TARGETS, ORMUZ_PROVIDER_TARGETS_FILE, or create config/provider-targets.json."
    );
  }

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      app.log.warn(`${signal} received again — forcing exit.`);
      process.exit(1);
    }
    shuttingDown = true;
    app.log.info(`${signal} received — draining; press again to force exit.`);
    try {
      await app.close();
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, "error during graceful shutdown");
      process.exit(1);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  return app;
}

