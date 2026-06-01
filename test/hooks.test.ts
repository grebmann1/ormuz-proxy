import { describe, expect, it, vi } from "vitest";

import { HookRegistry } from "../src/hooks.js";

describe("HookRegistry", () => {
  const payload = { requestId: "r1", method: "GET", originalPath: "/v1/x" };

  it("forwards each emit* call to the matching hook", () => {
    const onRequestReceived = vi.fn();
    const onForwardStart = vi.fn();
    const registry = new HookRegistry({ onRequestReceived, onForwardStart });

    registry.emitRequestReceived(payload);
    registry.emitForwardStart(payload);

    expect(onRequestReceived).toHaveBeenCalledWith(payload);
    expect(onForwardStart).toHaveBeenCalledWith(payload);
  });

  it("is a no-op when no hook is registered", () => {
    const registry = new HookRegistry({});
    expect(() => {
      registry.emitRequestReceived(payload);
      registry.emitProviderResolved(payload);
      registry.emitQueued(payload);
      registry.emitForwardStart(payload);
      registry.emitForwardResult(payload);
      registry.emitUpstream429(payload);
      registry.emitRequestCompleted(payload);
    }).not.toThrow();
  });

  it("swallows hook errors so the proxy path stays stable", () => {
    const onRequestReceived = vi.fn(() => {
      throw new Error("hook is buggy");
    });
    const onForwardResult = vi.fn();
    const registry = new HookRegistry({ onRequestReceived, onForwardResult });

    expect(() => registry.emitRequestReceived(payload)).not.toThrow();
    // Subsequent hooks still fire normally.
    registry.emitForwardResult({ ...payload, statusCode: 200 });
    expect(onForwardResult).toHaveBeenCalledTimes(1);
  });
});
