import { describe, expect, it } from "vitest";

import { CliArgError, parseArgs } from "../src/cli.js";

describe("parseArgs", () => {
  it("returns parsed values for known flags", () => {
    const result = parseArgs(["--port", "9000", "--bucket-key", "host", "--yes"]);
    if (typeof result === "string") throw new Error("expected CliArgs");
    expect(result.port).toBe("9000");
    expect(result.bucketKey).toBe("host");
    expect(result.yes).toBe(true);
  });

  it("returns the special tokens for --help / --version / --print-hosts / --print-config", () => {
    expect(parseArgs(["-h"])).toBe("help");
    expect(parseArgs(["--help"])).toBe("help");
    expect(parseArgs(["-v"])).toBe("version");
    expect(parseArgs(["--version"])).toBe("version");
    expect(parseArgs(["--print-hosts"])).toBe("print-hosts");
    expect(parseArgs(["--print-config"])).toBe("print-config");
  });

  it("rejects unknown flags rather than silently ignoring them", () => {
    expect(() => parseArgs(["--bukcet-key", "host"])).toThrow(CliArgError);
    expect(() => parseArgs(["foo"])).toThrow(/Unknown argument/);
  });

  it("rejects a value-flag with no value", () => {
    expect(() => parseArgs(["--port"])).toThrow(/expects a value/);
    // also when followed by another flag, not a value
    expect(() => parseArgs(["--port", "--rpm", "60"])).toThrow(/expects a value/);
  });

  it("rejects bucket-key values outside the supported set", () => {
    expect(() => parseArgs(["--bucket-key", "bogus"])).toThrow(/Invalid --bucket-key/);
  });

  it("rejects log-level values outside the supported set", () => {
    expect(() => parseArgs(["--log-level", "shouty"])).toThrow(/Invalid --log-level/);
  });
});
