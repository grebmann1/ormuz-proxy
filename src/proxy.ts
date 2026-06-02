import { createHash } from "node:crypto";

import type { FastifyReply } from "fastify";
import { request } from "undici";

import type { ScheduledResult } from "./types.js";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);
const INTERNAL_ROUTING_HEADERS = new Set([
  "x-ormuz-target",
  "x-ormuz-provider",
  "x-ormuz-route"
]);

export type ProxyRequest = {
  upstreamBaseUrl: string;
  method: string;
  path: string;
  queryString: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  reply: FastifyReply;
  attempt: number;
  onForwardStart?: () => void;
  onUpstreamStatus?: (statusCode: number) => void;
  onForwardResult?: (statusCode: number) => void;
  onForwarded?: () => void;
};

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function ensureLeadingSlash(value: string): string {
  return value.startsWith("/") ? value : `/${value}`;
}

export function buildUpstreamUrl(upstreamBaseUrl: string, requestPath: string, queryString: string): string {
  const parsedBase = new URL(upstreamBaseUrl);
  const basePath = trimTrailingSlash(parsedBase.pathname || "");
  const normalizedRequestPath = ensureLeadingSlash(requestPath);

  // Avoid double-prefixing when base already includes the same path segment.
  const finalPath =
    basePath &&
    (normalizedRequestPath === basePath || normalizedRequestPath.startsWith(`${basePath}/`))
      ? normalizedRequestPath
      : `${basePath}${normalizedRequestPath}`;

  parsedBase.pathname = finalPath;
  parsedBase.search = queryString ? `?${queryString}` : "";
  return parsedBase.toString();
}

function parseRetryAfter(headerValue: string | undefined): number {
  if (!headerValue) {
    return 1_000;
  }

  const asSeconds = Number(headerValue);
  if (!Number.isNaN(asSeconds)) {
    return Math.max(1_000, Math.ceil(asSeconds * 1000));
  }

  const dateMs = Date.parse(headerValue);
  if (Number.isNaN(dateMs)) {
    return 1_000;
  }
  return Math.max(1_000, dateMs - Date.now());
}

function buildUpstreamHeaders(sourceHeaders: Record<string, string | string[] | undefined>): Record<string, string> {
  const cleanHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(sourceHeaders)) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || INTERNAL_ROUTING_HEADERS.has(lower) || lower === "host" || value === undefined) {
      continue;
    }
    cleanHeaders[key] = Array.isArray(value) ? value.join(",") : value;
  }
  return cleanHeaders;
}

function copyResponseHeaders(reply: FastifyReply, headers: Record<string, string | string[] | undefined>): void {
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      continue;
    }
    reply.header(key, value);
  }
}

export async function forwardRequest(params: ProxyRequest): Promise<ScheduledResult<void>> {
  const url = buildUpstreamUrl(params.upstreamBaseUrl, params.path, params.queryString);
  params.onForwardStart?.();
  const upstream = await request(url, {
    method: params.method,
    headers: buildUpstreamHeaders(params.headers),
    body: params.body.length > 0 ? params.body : undefined
  });
  params.onUpstreamStatus?.(upstream.statusCode);
  params.onForwardResult?.(upstream.statusCode);

  if (upstream.statusCode === 429 && params.attempt === 0) {
    const retryAfterHeader = upstream.headers["retry-after"];
    const retryAfter = Array.isArray(retryAfterHeader) ? retryAfterHeader[0] : retryAfterHeader;
    const retryAfterMs = parseRetryAfter(retryAfter);
    return { kind: "upstream_429", retryAfterMs };
  }

  params.reply.code(upstream.statusCode);
  copyResponseHeaders(params.reply, upstream.headers);
  if (!upstream.body) {
    params.reply.send();
    params.onForwarded?.();
    return { kind: "ok", value: undefined };
  }

  await params.reply.send(upstream.body);
  params.onForwarded?.();
  return { kind: "ok", value: undefined };
}

export function deriveBucketKey(
  mode: "auth" | "global" | "model" | "host",
  headers: Record<string, string | string[] | undefined>,
  body: unknown,
  upstreamHost?: string
): string {
  if (mode === "global") {
    return "global";
  }

  if (mode === "model") {
    if (typeof body === "object" && body !== null && "model" in body) {
      const model = (body as { model?: unknown }).model;
      if (typeof model === "string" && model.length > 0) {
        return `model:${model}`;
      }
    }
    return "model:unknown";
  }

  if (mode === "host") {
    return upstreamHost ? `host:${upstreamHost.toLowerCase()}` : "host:unknown";
  }

  const auth = headers.authorization ?? headers.Authorization;
  const authValue = Array.isArray(auth) ? auth[0] : auth;
  return authValue ? `auth:${hashAuth(authValue)}` : "auth:anonymous";
}

function hashAuth(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}
