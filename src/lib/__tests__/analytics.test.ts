import { describe, expect, it } from "vitest";
import { analyticsBeforeSend, redactAnalyticsUrl } from "../analytics";

describe("redactAnalyticsUrl: no link secret or personal detail reaches Vercel Web Analytics", () => {
  it("keeps an ordinary page as it is", () => {
    expect(redactAnalyticsUrl("https://matchtime.ai/play")).toBe("https://matchtime.ai/play");
    expect(redactAnalyticsUrl("https://matchtime.ai/pricing")).toBe("https://matchtime.ai/pricing");
  });

  it("drops the whole query string (signed login links, referral codes, callbacks)", () => {
    expect(redactAnalyticsUrl("https://matchtime.ai/login?link=SECRET&callbackUrl=%2Fplay")).toBe("https://matchtime.ai/login");
    expect(redactAnalyticsUrl("https://matchtime.ai/play?c=spring&ref=ABC123")).toBe("https://matchtime.ai/play");
    expect(redactAnalyticsUrl("https://matchtime.ai/play#top")).toBe("https://matchtime.ai/play");
  });

  it("replaces the token in personal links with a placeholder", () => {
    expect(redactAnalyticsUrl("https://matchtime.ai/r/abc.def")).toBe("https://matchtime.ai/r/[token]");
    expect(redactAnalyticsUrl("https://matchtime.ai/play/offer/tok123")).toBe("https://matchtime.ai/play/offer/[token]");
    expect(redactAnalyticsUrl("https://matchtime.ai/play/f/link.sig")).toBe("https://matchtime.ai/play/f/[token]");
    expect(redactAnalyticsUrl("https://matchtime.ai/join/XYZ")).toBe("https://matchtime.ai/join/[code]");
    expect(redactAnalyticsUrl("https://matchtime.ai/finish-setup/cs_123")).toBe("https://matchtime.ai/finish-setup/[sessionId]");
  });

  it("returns something safe for a URL it cannot read", () => {
    expect(redactAnalyticsUrl("not a url?x=1")).toBe("not a url");
  });

  it("beforeSend applies the redaction to page views and events", () => {
    expect(analyticsBeforeSend({ type: "pageview", url: "https://matchtime.ai/r/abc?x=1" })).toEqual({ type: "pageview", url: "https://matchtime.ai/r/[token]" });
    expect(analyticsBeforeSend({ type: "event", url: "https://matchtime.ai/play?ref=A" })).toEqual({ type: "event", url: "https://matchtime.ai/play" });
  });
});
