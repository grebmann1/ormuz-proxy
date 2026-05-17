import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  const dirsToCleanup: string[] = [];

  afterEach(() => {
    for (const dir of dirsToCleanup) {
      rmSync(dir, { recursive: true, force: true });
    }
    dirsToCleanup.length = 0;
  });

  it("defaults to port 8787", () => {
    const config = loadConfig({
      ORMUZ_RPM: "60",
      ORMUZ_UPSTREAM_BASE_URL: "https://your-llm-gateway.example.com"
    });
    expect(config.port).toBe(8787);
  });

  it("merges provider targets from env and file with file precedence", () => {
    const dir = mkdtempSync(join(tmpdir(), "ormuz-config-test-"));
    dirsToCleanup.push(dir);
    const filePath = join(dir, "providers.json");
    writeFileSync(filePath, JSON.stringify({ openai: "https://file.openai.local", anthropic: "https://anthropic.local" }));

    const config = loadConfig({
      ORMUZ_RPM: "60",
      ORMUZ_PROVIDER_TARGETS: JSON.stringify({
        openai: "https://env.openai.local",
        gemini: "https://gemini.local"
      }),
      ORMUZ_PROVIDER_TARGETS_FILE: filePath
    });

    expect(config.providerTargets).toEqual({
      openai: "https://file.openai.local",
      anthropic: "https://anthropic.local",
      gemini: "https://gemini.local"
    });
    expect(config.routingRules.pathPrefixes).toEqual({
      "/v1/openai": "https://file.openai.local",
      "/v1/anthropic": "https://anthropic.local",
      "/v1/gemini": "https://gemini.local"
    });
  });

  it("auto-loads default provider target file when present", () => {
    const dir = mkdtempSync(join(tmpdir(), "ormuz-config-defaults-"));
    dirsToCleanup.push(dir);
    const prevCwd = process.cwd();
    process.chdir(dir);
    mkdirSync("config", { recursive: true });
    writeFileSync(
      "config/provider-targets.json",
      JSON.stringify({ openai: "https://api.openai.com", anthropic: "https://api.anthropic.com" })
    );

    try {
      const config = loadConfig({
        ORMUZ_RPM: "60"
      });
      expect(config.providerTargets).toEqual({
        openai: "https://api.openai.com",
        anthropic: "https://api.anthropic.com"
      });
      expect(config.routingRules.pathPrefixes).toEqual({
        "/v1/openai": "https://api.openai.com",
        "/v1/anthropic": "https://api.anthropic.com"
      });
    } finally {
      process.chdir(prevCwd);
    }
  });

  it("parses structured routing config with headers and path prefixes", () => {
    const config = loadConfig({
      ORMUZ_RPM: "60",
      ORMUZ_PROVIDER_TARGETS: JSON.stringify({
        providers: {
          openai: "https://api.openai.com"
        },
        routes: {
          pathPrefixes: {
            "/x/abc": "https://api.openai.com"
          },
          headers: [{ header: "X-Ormuz-Target", value: "openai", target: "https://api.openai.com" }]
        }
      })
    });

    expect(config.routingRules.pathPrefixes["/x/abc"]).toBe("https://api.openai.com");
    expect(config.routingRules.headers).toEqual([
      { header: "x-ormuz-target", value: "openai", target: "https://api.openai.com" }
    ]);
  });
});
