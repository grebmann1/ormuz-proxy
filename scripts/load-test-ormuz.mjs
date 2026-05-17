#!/usr/bin/env node

import { writeFile } from "node:fs/promises";

function parseArgs(argv) {
  const args = {};
  const headers = [];

  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith("--")) {
      continue;
    }

    if (raw.includes("=")) {
      const body = raw.slice(2);
      const eq = body.indexOf("=");
      const k = body.slice(0, eq);
      const v = body.slice(eq + 1);
      if (k === "header") {
        headers.push(v);
      } else {
        args[k] = v;
      }
      continue;
    }

    const key = raw.slice(2);
    const next = argv[i + 1];
    if (key === "header") {
      if (next && !next.startsWith("--")) {
        headers.push(next);
        i += 1;
      }
      continue;
    }

    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }

    args[key] = next;
    i += 1;
  }

  return { ...args, headers };
}

function parseRamp(raw) {
  if (!raw) {
    return [
      { concurrency: 5, durationSec: 20 },
      { concurrency: 15, durationSec: 30 },
      { concurrency: 30, durationSec: 45 }
    ];
  }
  return String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((stage) => {
      const [c, d] = stage.split("x");
      const concurrency = Number(c);
      const durationSec = Number(d);
      if (!Number.isFinite(concurrency) || !Number.isFinite(durationSec) || concurrency <= 0 || durationSec <= 0) {
        throw new Error(`Invalid --ramp stage "${stage}". Use format like 20x60.`);
      }
      return { concurrency: Math.floor(concurrency), durationSec: Math.floor(durationSec) };
    });
}

function makeLargePrompt(chars) {
  const seed =
    "You are testing request queueing and throttling behavior. Return a concise JSON summary only. " +
    "Repeat this context to inflate payload size for stress testing. ";
  let prompt = "";
  while (prompt.length < chars) {
    prompt += seed;
  }
  return prompt.slice(0, chars);
}

function percentile(sorted, p) {
  if (sorted.length === 0) {
    return null;
  }
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[idx];
}

function parseHeaderPairs(headerArgs) {
  const headers = {};
  for (const pair of headerArgs) {
    const idx = pair.indexOf("=");
    if (idx <= 0) {
      throw new Error(`Invalid --header value "${pair}". Expected key=value.`);
    }
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    headers[key] = value;
  }
  return headers;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveProviderMode(args, route, extraHeaders) {
  const explicit = typeof args.provider === "string" ? args.provider.trim().toLowerCase() : "";
  if (explicit) {
    return explicit;
  }
  const headerTarget = extraHeaders["x-ormuz-target"] ?? extraHeaders["X-Ormuz-Target"];
  if (typeof headerTarget === "string" && headerTarget.length > 0) {
    return headerTarget.toLowerCase();
  }
  const r = route.toLowerCase();
  if (r.includes("anthropic") || r.includes("/bedrock/")) {
    return "anthropic";
  }
  if (r.includes("gemini") || r.includes("generatecontent")) {
    return "gemini";
  }
  return "openai";
}

function buildRequestBody(providerMode, model, prompt, maxTokens) {
  if (providerMode === "gemini") {
    return {
      systemInstruction: { parts: [{ text: "You are a concise assistant for load testing." }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: maxTokens,
        thinkingConfig: { thinkingBudget: 0 }
      }
    };
  }

  if (providerMode === "anthropic") {
    return {
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: maxTokens,
      system: "You are a concise assistant for load testing.",
      messages: [{ role: "user", content: prompt }]
    };
  }

  // openai-compatible shape (matches monaco benchmark adapter).
  return {
    model,
    max_completion_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }]
  };
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = String(args["base-url"] ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
  const route = String(args.route ?? "/v1/openai/chat/completions");
  const authToken = typeof args["auth-token"] === "string" ? args["auth-token"] : "";
  const promptChars = Number(args["prompt-chars"] ?? 12000);
  const maxTokens = Number(args["max-tokens"] ?? 512);
  const timeoutMs = Number(args["timeout-ms"] ?? 60000);
  const model = String(args.model ?? "gpt-4o-mini");
  const outputPath = typeof args.output === "string" ? args.output : "";
  const stages = parseRamp(args.ramp);
  const extraHeaders = parseHeaderPairs(args.headers ?? []);
  const url = `${baseUrl}${route.startsWith("/") ? route : `/${route}`}`;
  const providerMode = resolveProviderMode(args, route, extraHeaders);

  if (!Number.isFinite(promptChars) || promptChars <= 0) {
    throw new Error("--prompt-chars must be > 0");
  }
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
    throw new Error("--max-tokens must be > 0");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("--timeout-ms must be > 0");
  }

  const prompt = makeLargePrompt(promptChars);

  const state = {
    startedAt: Date.now(),
    inFlight: 0,
    sent: 0,
    completed: 0,
    success2xx: 0,
    statusCounts: new Map(),
    errors: 0,
    local429: 0,
    upstream429: 0,
    latencies: [],
    stageIndex: 0,
    stageStartedAt: Date.now(),
    stageFinished: false
  };

  const printTicker = setInterval(() => {
    const elapsedSec = Math.max(1, Math.floor((Date.now() - state.startedAt) / 1000));
    const rps = (state.completed / elapsedSec).toFixed(2);
    const sorted = [...state.latencies].sort((a, b) => a - b);
    const p50 = percentile(sorted, 50);
    const p95 = percentile(sorted, 95);
    const statuses = [...state.statusCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([code, count]) => `${code}:${count}`)
      .join(" ");
    const stage = stages[Math.min(state.stageIndex, stages.length - 1)];
    process.stdout.write("\x1Bc");
    process.stdout.write(
      [
        "Ormuz Load Test",
        `target=${url}`,
        `providerMode=${providerMode}`,
        `stage=${Math.min(state.stageIndex + 1, stages.length)}/${stages.length} concurrency=${stage.concurrency} duration=${stage.durationSec}s`,
        `sent=${state.sent} completed=${state.completed} inFlight=${state.inFlight} rps=${rps}`,
        `2xx=${state.success2xx} errors=${state.errors} local429=${state.local429} upstream429=${state.upstream429}`,
        `latency(ms): p50=${p50 ?? "-"} p95=${p95 ?? "-"} min=${sorted[0] ?? "-"} max=${sorted[sorted.length - 1] ?? "-"}`,
        `status: ${statuses || "-"}`,
        "Press Ctrl+C to stop."
      ].join("\n") + "\n"
    );
  }, 1000);
  printTicker.unref();

  let stop = false;
  process.once("SIGINT", () => {
    stop = true;
    process.stdout.write("\nStopping load test...\n");
  });

  const stageEndsAt = stages.map((s) => s.durationSec).reduce((acc, sec) => {
    const prev = acc.length === 0 ? 0 : acc[acc.length - 1];
    acc.push(prev + sec * 1000);
    return acc;
  }, []);

  const requestOne = async () => {
    state.sent += 1;
    state.inFlight += 1;
    const started = Date.now();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
    try {
      const headers = {
        "content-type": "application/json",
        ...extraHeaders
      };
      if (authToken) {
        headers.authorization = `Bearer ${authToken}`;
      }
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(buildRequestBody(providerMode, model, prompt, maxTokens)),
        signal: controller.signal
      });

      const latency = Date.now() - started;
      state.latencies.push(latency);
      state.completed += 1;
      const code = String(res.status);
      state.statusCounts.set(code, (state.statusCounts.get(code) ?? 0) + 1);
      if (res.status >= 200 && res.status < 300) {
        state.success2xx += 1;
      }
      if (res.status === 429) {
        const body = await res.text().catch(() => "");
        if (body.includes("rate_limited")) {
          state.local429 += 1;
        } else {
          state.upstream429 += 1;
        }
      }
    } catch {
      state.completed += 1;
      state.errors += 1;
      state.statusCounts.set("ERR", (state.statusCounts.get("ERR") ?? 0) + 1);
      await sleep(50);
    } finally {
      clearTimeout(timeout);
      state.inFlight -= 1;
    }
  };

  const workers = [];
  const worker = async () => {
    while (!stop) {
      const elapsed = Date.now() - state.startedAt;
      const stageIdx = stageEndsAt.findIndex((endMs) => elapsed < endMs);
      if (stageIdx < 0) {
        stop = true;
        break;
      }
      state.stageIndex = stageIdx;

      const targetConcurrency = stages[stageIdx].concurrency;
      if (state.inFlight >= targetConcurrency) {
        await sleep(20);
        continue;
      }
      await requestOne();
    }
  };

  const maxConcurrency = Math.max(...stages.map((s) => s.concurrency));
  for (let i = 0; i < maxConcurrency; i += 1) {
    workers.push(worker());
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await Promise.allSettled(workers);
  clearInterval(printTicker);

  const elapsedSec = Math.max(1, Math.floor((Date.now() - state.startedAt) / 1000));
  const sorted = [...state.latencies].sort((a, b) => a - b);
  const summary = {
    target: url,
    providerMode,
    model,
    promptChars,
    maxTokens,
    elapsedSec,
    sent: state.sent,
    completed: state.completed,
    success2xx: state.success2xx,
    errors: state.errors,
    local429: state.local429,
    upstream429: state.upstream429,
    avgRps: Number((state.completed / elapsedSec).toFixed(2)),
    latencyMs: {
      min: sorted[0] ?? null,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      max: sorted[sorted.length - 1] ?? null
    },
    statusCounts: Object.fromEntries(state.statusCounts.entries()),
    stages
  };

  process.stdout.write("\nLoad test summary\n");
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");

  if (outputPath) {
    await writeFile(outputPath, JSON.stringify(summary, null, 2) + "\n", "utf-8");
    process.stdout.write(`Summary written to ${outputPath}\n`);
  }
}

run().catch((error) => {
  console.error("[load-test] fatal", error);
  process.exit(1);
});
