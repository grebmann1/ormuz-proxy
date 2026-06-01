import { stdout } from "node:process";

import type { OrmuzHooks } from "./hooks.js";

export function createLiveMonitorHooks(port: number): OrmuzHooks {
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
    stdout.write("\x1B[2J\x1B[H");
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
