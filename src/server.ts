import { connect as netConnect, type Socket } from "node:net";
import type { IncomingMessage } from "node:http";

import Fastify, { type FastifyInstance } from "fastify";

import { loadConfig, type AppConfig } from "./config.js";
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

function parseConnectTarget(rawUrl: string): { host: string; port: number } | undefined {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return undefined;
  }
  const colonIdx = trimmed.lastIndexOf(":");
  if (colonIdx <= 0 || colonIdx === trimmed.length - 1) {
    return undefined;
  }
  const host = trimmed.slice(0, colonIdx).toLowerCase();
  const port = Number(trimmed.slice(colonIdx + 1));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return undefined;
  }
  return { host, port };
}

function writeAndDestroy(socket: Socket, response: string): void {
  try {
    socket.write(response, () => socket.destroy());
  } catch {
    socket.destroy();
  }
}

function tunnelSockets(client: Socket, upstream: Socket, head: Buffer | undefined): void {
  if (head && head.length > 0) {
    upstream.write(head);
  }
  let closed = false;
  const closeBoth = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    client.destroy();
    upstream.destroy();
  };
  client.on("error", closeBoth);
  client.on("close", closeBoth);
  upstream.on("error", closeBoth);
  upstream.on("close", closeBoth);
  client.pipe(upstream);
  upstream.pipe(client);
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
      originalPath: request.url,
      bucketKey
    });

    const providerOrRouteConfigured =
      Object.keys(config.providerTargets).length > 0 ||
      Object.keys(config.routingRules.pathPrefixes).length > 0 ||
      config.routingRules.headers.length > 0;

    if (!resolvedRoute && providerOrRouteConfigured) {
      return reply.code(400).send({
        error: "unmatched_route",
        message: "Unable to resolve route from headers/path.",
        supportedProviders: Object.keys(config.providerTargets).sort(),
        supportedPathPrefixes: Object.keys(config.routingRules.pathPrefixes).sort(),
        supportedHeaderRules: config.routingRules.headers.map((rule) => `${rule.header}=${rule.value}`)
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
        requestId,
        method: request.method,
        originalPath: request.url,
        bucketKey,
        provider: resolvedRoute.provider,
        upstreamBaseUrl: resolvedRoute.upstreamBaseUrl,
        upstreamPath: resolvedRoute.rewrittenPath,
        routeStrategy: resolvedRoute.routeStrategy
      });
    }

    const submitHooks: SubmitHooks = {
      onQueued: (depth) =>
        hookRegistry.emitQueued({
          requestId,
          method: request.method,
          originalPath: request.url,
          bucketKey,
          provider: resolvedRoute?.provider,
          queueDepth: depth
        }),
      onUpstream429: (retryAfterMs) =>
        hookRegistry.emitUpstream429({
          requestId,
          method: request.method,
          originalPath: request.url,
          bucketKey,
          provider: resolvedRoute?.provider,
          retryAfterMs
        })
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
                requestId,
                method: request.method,
                originalPath: request.url,
                bucketKey,
                provider: resolvedRoute?.provider,
                routeStrategy: resolvedRoute?.routeStrategy,
                upstreamBaseUrl,
                upstreamPath: pathOnly
              }),
            onUpstreamStatus: (code) => metrics.recordUpstreamStatus(code),
            onForwardResult: (statusCode) =>
              hookRegistry.emitForwardResult({
                requestId,
                method: request.method,
                originalPath: request.url,
                bucketKey,
                provider: resolvedRoute?.provider,
                routeStrategy: resolvedRoute?.routeStrategy,
                statusCode
              }),
            onForwarded: () => metrics.recordForwarded()
          }),
        submitHooks
      );
      hookRegistry.emitRequestCompleted({
        requestId,
        method: request.method,
        originalPath: request.url,
        bucketKey,
        provider: resolvedRoute?.provider,
        routeStrategy: resolvedRoute?.routeStrategy,
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
        requestId,
        method: request.method,
        originalPath: request.url,
        bucketKey,
        provider: resolvedRoute?.provider,
        routeStrategy: resolvedRoute?.routeStrategy,
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

  const allowedConnectHosts = collectAllowedHosts(config);

  const handleConnect = (req: IncomingMessage, clientSocket: Socket, head: Buffer): void => {
    const target = parseConnectTarget(req.url ?? "");
    if (!target) {
      writeAndDestroy(clientSocket, "HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    if (allowedConnectHosts.size === 0 || !allowedConnectHosts.has(target.host)) {
      writeAndDestroy(clientSocket, "HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const bucketKey = `host:${target.host}`;

    let pending: Promise<void>;
    try {
      pending = scheduler.submit(bucketKey, () => {
        return new Promise((resolveTask) => {
          const upstream = netConnect({ host: target.host, port: target.port });
          let settled = false;
          upstream.once("connect", () => {
            if (settled) {
              return;
            }
            settled = true;
            metrics.recordUpstreamStatus(200);
            metrics.recordForwarded();
            clientSocket.write("HTTP/1.1 200 Connection established\r\n\r\n", () => {
              tunnelSockets(clientSocket, upstream, head);
            });
            resolveTask({ kind: "ok", value: undefined });
          });
          upstream.once("error", () => {
            if (settled) {
              return;
            }
            settled = true;
            writeAndDestroy(clientSocket, "HTTP/1.1 502 Bad Gateway\r\n\r\n");
            resolveTask({ kind: "ok", value: undefined });
          });
        });
      });
    } catch (error) {
      if (error instanceof QueueRejectedError) {
        const retrySec = Math.ceil(error.retryAfterMs / 1000);
        writeAndDestroy(
          clientSocket,
          `HTTP/1.1 429 Too Many Requests\r\nRetry-After: ${retrySec}\r\n\r\n`
        );
        return;
      }
      writeAndDestroy(clientSocket, "HTTP/1.1 502 Bad Gateway\r\n\r\n");
      return;
    }
    pending.catch((error) => {
      if (error instanceof QueueRejectedError) {
        const retrySec = Math.ceil(error.retryAfterMs / 1000);
        writeAndDestroy(
          clientSocket,
          `HTTP/1.1 429 Too Many Requests\r\nRetry-After: ${retrySec}\r\n\r\n`
        );
        return;
      }
      writeAndDestroy(clientSocket, "HTTP/1.1 502 Bad Gateway\r\n\r\n");
    });
  };

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

  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  return app;
}

