/**
 * THE RETRY CLASSIFIER (WhatsApp Cloud API plan, PR C4, section 5.5).
 *
 * Meta documents no idempotency key, so a send is AT MOST ONCE: retried
 * only when Meta said it did not take the message, never after a timeout
 * with no answer (it may have landed). Pure: no clock, no network.
 */
import { describe, expect, it } from "vitest";
import { CLOUD_MAX_RETRIES, CLOUD_RETRY_BASE_MS, classifyCloudSend, type CloudSendResult } from "../errors";

const NOW = new Date("2026-11-07T12:00:00Z");
const ctx = (over: Partial<Parameters<typeof classifyCloudSend>[1]> = {}) => ({ retriesSoFar: 0, now: NOW, expiresAt: null, ...over });
const metaError = (code: number, httpStatus = 400, message = "x"): CloudSendResult => ({ kind: "error", httpStatus, error: { code, message } });

describe("accepted", () => {
  it("a wamid is sent", () => {
    expect(classifyCloudSend({ kind: "accepted", wamid: "wamid.A" }, ctx())).toEqual({ verdict: "sent", wamid: "wamid.A" });
  });

  it("accepted with no wamid is unconfirmed, never retried", () => {
    expect(classifyCloudSend({ kind: "accepted", wamid: null }, ctx()).verdict).toBe("unconfirmed");
  });
});

describe("retried only when Meta did not take the message", () => {
  for (const code of [130429, 131056, 80007]) {
    it(`${code}: retry with backoff`, () => {
      const v = classifyCloudSend(metaError(code, 429), ctx());
      expect(v).toMatchObject({ verdict: "retry", errorCode: code });
      if (v.verdict === "retry") expect(v.retryAt.getTime()).toBe(NOW.getTime() + CLOUD_RETRY_BASE_MS);
    });
  }

  it("HTTP 5xx with an error body: retry", () => {
    expect(classifyCloudSend(metaError(1, 500), ctx())).toMatchObject({ verdict: "retry", errorCode: 1 });
    expect(classifyCloudSend({ kind: "error", httpStatus: 503, error: { code: null, message: "down" } }, ctx()).verdict).toBe("retry");
  });

  it("HTTP 5xx with no error body: unconfirmed (it may have landed)", () => {
    expect(classifyCloudSend({ kind: "error", httpStatus: 502, error: null }, ctx()).verdict).toBe("unconfirmed");
  });

  it("the backoff grows: 1x, 4x, 16x the base", () => {
    const at = (n: number) => {
      const v = classifyCloudSend(metaError(130429, 429), ctx({ retriesSoFar: n }));
      return v.verdict === "retry" ? v.retryAt.getTime() - NOW.getTime() : null;
    };
    expect([at(0), at(1), at(2)]).toEqual([CLOUD_RETRY_BASE_MS, 4 * CLOUD_RETRY_BASE_MS, 16 * CLOUD_RETRY_BASE_MS]);
  });

  it(`at most ${CLOUD_MAX_RETRIES} retries, then failed`, () => {
    const v = classifyCloudSend(metaError(130429, 429), ctx({ retriesSoFar: CLOUD_MAX_RETRIES }));
    expect(v).toMatchObject({ verdict: "failed", errorCode: 130429 });
  });

  it("a connection that was never made (refused, no DNS) is retried: Meta never saw it", () => {
    expect(classifyCloudSend({ kind: "unreachable", reason: "ECONNREFUSED" }, ctx()).verdict).toBe("retry");
  });
});

describe("never retried after no answer", () => {
  it("a timeout is unconfirmed", () => {
    expect(classifyCloudSend({ kind: "timeout" }, ctx()).verdict).toBe("unconfirmed");
  });

  it("a connection lost mid request is unconfirmed", () => {
    expect(classifyCloudSend({ kind: "lost", reason: "ECONNRESET" }, ctx()).verdict).toBe("unconfirmed");
  });
});

describe("failed, with what follows", () => {
  it("131026 undeliverable and 131049 held for ecosystem health: failed", () => {
    expect(classifyCloudSend(metaError(131026), ctx())).toMatchObject({ verdict: "failed", errorCode: 131026 });
    expect(classifyCloudSend(metaError(131049), ctx())).toMatchObject({ verdict: "failed", errorCode: 131049 });
  });

  it("131050: failed, and marketing to him stops", () => {
    expect(classifyCloudSend(metaError(131050), ctx())).toMatchObject({ verdict: "failed", errorCode: 131050, stopMarketing: true });
  });

  it("132015 paused and 132016 disabled: failed, and the template is flagged", () => {
    expect(classifyCloudSend(metaError(132015), ctx())).toMatchObject({ verdict: "failed", flagTemplate: "PAUSED" });
    expect(classifyCloudSend(metaError(132016), ctx())).toMatchObject({ verdict: "failed", flagTemplate: "DISABLED" });
  });

  it("131047: the window is closed", () => {
    expect(classifyCloudSend(metaError(131047), ctx())).toMatchObject({ verdict: "window-closed", errorCode: 131047 });
  });

  it("any other 4xx: failed, not retried", () => {
    for (const code of [132001, 131048, 100, 190]) expect(classifyCloudSend(metaError(code), ctx()).verdict).toBe("failed");
    expect(classifyCloudSend({ kind: "error", httpStatus: 400, error: null }, ctx()).verdict).toBe("failed");
  });

  it("only failed carries the side signals", () => {
    const v = classifyCloudSend(metaError(131026), ctx());
    expect(v).not.toHaveProperty("stopMarketing");
    expect(v).not.toHaveProperty("flagTemplate");
  });
});

describe("a code older than its ten minutes is dropped", () => {
  it("a retry that would land after the code expires is failed instead", () => {
    const expiresAt = new Date(NOW.getTime() + CLOUD_RETRY_BASE_MS - 1);
    expect(classifyCloudSend(metaError(130429, 429), ctx({ expiresAt }))).toMatchObject({ verdict: "failed", errorCode: 130429 });
  });

  it("a retry inside the code's life goes ahead", () => {
    const expiresAt = new Date(NOW.getTime() + 5 * 60_000);
    expect(classifyCloudSend(metaError(130429, 429), ctx({ expiresAt })).verdict).toBe("retry");
  });
});

describe("the reason is safe to store and log", () => {
  it("carries the code, never more than 200 characters of Meta's message", () => {
    const v = classifyCloudSend(metaError(131026, 400, "m".repeat(1000)), ctx());
    expect(v.verdict === "failed" && v.reason.startsWith("Meta 131026")).toBe(true);
    if (v.verdict === "failed") expect(v.reason.length).toBeLessThan(260);
  });
});
