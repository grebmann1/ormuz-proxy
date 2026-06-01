#!/usr/bin/env node
// One-shot dev setup: copy .env.example -> .env if missing, print next steps.
// Idempotent — safe to re-run.

import { existsSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const envPath = resolve(repoRoot, ".env");
const examplePath = resolve(repoRoot, ".env.example");
const providersPath = resolve(repoRoot, "config/provider-targets.json");

if (existsSync(envPath)) {
  console.log("✓ .env already exists — leaving it alone");
} else if (existsSync(examplePath)) {
  copyFileSync(examplePath, envPath);
  console.log("✓ created .env from .env.example");
} else {
  console.log("! .env.example missing; skipping .env bootstrap");
}

if (existsSync(providersPath)) {
  console.log("✓ config/provider-targets.json present (auto-loaded at start)");
} else {
  console.log("! config/provider-targets.json missing — set ORMUZ_PROVIDER_TARGETS or create the file");
}

console.log("");
console.log("Next:");
console.log("  npm run dev           # start Ormuz on http://localhost:8787");
console.log("  npm test              # run unit + integration tests");
console.log("  npm run install:autostart   # macOS: launchd + zshrc env vars");
