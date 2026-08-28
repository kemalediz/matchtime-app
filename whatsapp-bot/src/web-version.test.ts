import { describe, it, expect, vi } from "vitest";
import {
  resolveWebVersionOptions,
  resolvedRemotePath,
  warnIfPinUnreachable,
  WA_VERSION_ARCHIVE_TEMPLATE,
} from "./web-version.js";

describe("resolveWebVersionOptions", () => {
  it("returns {} when nothing is set — library defaults, behaviour unchanged", () => {
    expect(resolveWebVersionOptions({})).toEqual({});
    // Empty / whitespace-only env vars count as unset (a blank line in .env).
    expect(
      resolveWebVersionOptions({
        WA_WEB_VERSION: "",
        WA_WEB_VERSION_REMOTE_PATH: "   ",
        WA_WEB_VERSION_CACHE_TYPE: "",
      }),
    ).toEqual({});
  });

  it("pins a version from WA_WEB_VERSION via the wa-version archive", () => {
    const opts = resolveWebVersionOptions({ WA_WEB_VERSION: "2.3000.1032157364" });
    expect(opts.webVersion).toBe("2.3000.1032157364");
    expect(opts.webVersionCache).toEqual({
      type: "remote",
      remotePath: WA_VERSION_ARCHIVE_TEMPLATE,
    });
    // The template must carry the {version} placeholder wweb.js substitutes.
    expect(WA_VERSION_ARCHIVE_TEMPLATE).toContain("{version}");
  });

  it("trims surrounding whitespace on the version", () => {
    expect(resolveWebVersionOptions({ WA_WEB_VERSION: "  2.3000.1017054665 " }).webVersion).toBe(
      "2.3000.1017054665",
    );
  });

  it("lets WA_WEB_VERSION_REMOTE_PATH override the archive URL entirely", () => {
    const opts = resolveWebVersionOptions({
      WA_WEB_VERSION: "2.3000.1032157364",
      WA_WEB_VERSION_REMOTE_PATH: "https://example.test/html/{version}.html",
    });
    expect(opts.webVersionCache).toEqual({
      type: "remote",
      remotePath: "https://example.test/html/{version}.html",
    });
    expect(opts.webVersion).toBe("2.3000.1032157364");
  });

  it("accepts a remote path with no version set (fully literal URL)", () => {
    const opts = resolveWebVersionOptions({
      WA_WEB_VERSION_REMOTE_PATH:
        "https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1032157364.html",
    });
    expect(opts.webVersionCache).toEqual({
      type: "remote",
      remotePath:
        "https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1032157364.html",
    });
    expect(opts.webVersion).toBeUndefined();
  });

  it("supports WA_WEB_VERSION_CACHE_TYPE=none to always take WhatsApp's live build", () => {
    expect(resolveWebVersionOptions({ WA_WEB_VERSION_CACHE_TYPE: "none" })).toEqual({
      webVersionCache: { type: "none" },
    });
    expect(resolveWebVersionOptions({ WA_WEB_VERSION_CACHE_TYPE: " NONE " })).toEqual({
      webVersionCache: { type: "none" },
    });
  });

  it("supports WA_WEB_VERSION_CACHE_TYPE=local", () => {
    expect(resolveWebVersionOptions({ WA_WEB_VERSION_CACHE_TYPE: "local" })).toEqual({
      webVersionCache: { type: "local" },
    });
  });

  it("ignores cache-type=remote with no remote path rather than crashing the client", () => {
    // RemoteWebCache throws in its constructor without a remotePath, which
    // would take the whole bot down at startup. Degrade to defaults instead.
    expect(resolveWebVersionOptions({ WA_WEB_VERSION_CACHE_TYPE: "remote" })).toEqual({});
  });

  it("ignores an unrecognised cache type", () => {
    expect(resolveWebVersionOptions({ WA_WEB_VERSION_CACHE_TYPE: "nonsense" })).toEqual({});
  });

  it("WA_WEB_VERSION wins over a bare cache-type of none", () => {
    const opts = resolveWebVersionOptions({
      WA_WEB_VERSION: "2.3000.1032157364",
      WA_WEB_VERSION_CACHE_TYPE: "none",
    });
    expect(opts.webVersionCache).toEqual({
      type: "remote",
      remotePath: WA_VERSION_ARCHIVE_TEMPLATE,
    });
  });
});

describe("resolvedRemotePath", () => {
  it("substitutes {version} the way RemoteWebCache does", () => {
    expect(
      resolvedRemotePath(resolveWebVersionOptions({ WA_WEB_VERSION: "2.3000.1046248368-alpha" })),
    ).toBe(
      "https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1046248368-alpha.html",
    );
  });

  it("returns undefined for unpinned / non-remote configurations", () => {
    expect(resolvedRemotePath(resolveWebVersionOptions({}))).toBeUndefined();
    expect(
      resolvedRemotePath(resolveWebVersionOptions({ WA_WEB_VERSION_CACHE_TYPE: "none" })),
    ).toBeUndefined();
  });
});

describe("warnIfPinUnreachable", () => {
  it("does nothing when unpinned", async () => {
    const log = vi.fn();
    await warnIfPinUnreachable(resolveWebVersionOptions({}), log);
    expect(log).not.toHaveBeenCalled();
  });

  it("shouts when the archive returns 404 — a silently-ignored pin", async () => {
    const log = vi.fn();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 404 }));
    await warnIfPinUnreachable(resolveWebVersionOptions({ WA_WEB_VERSION: "2.3000.999" }), log);
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0][0]).toContain("CRITICAL");
    expect(log.mock.calls[0][0]).toContain("404");
    fetchSpy.mockRestore();
  });

  it("stays quiet on a 200", async () => {
    const log = vi.fn();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));
    await warnIfPinUnreachable(resolveWebVersionOptions({ WA_WEB_VERSION: "2.3000.111" }), log);
    expect(log).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("never throws when the network is down", async () => {
    const log = vi.fn();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("ENOTFOUND"));
    await expect(
      warnIfPinUnreachable(resolveWebVersionOptions({ WA_WEB_VERSION: "2.3000.111" }), log),
    ).resolves.toBeUndefined();
    expect(log.mock.calls[0][0]).toContain("Could not verify");
    fetchSpy.mockRestore();
  });
});
