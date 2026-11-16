/**
 * The /play visit breakdown's pure rules. 2026-11-13: one row per beacon,
 * kept 90 days. 2026-11-16 (Kemal): DAILY TOTALS ONLY, and after review
 * (two reviewers, on production data) only what cannot single out the one
 * person who signed up that day: per code and London day, OPENS only,
 * counted by what opened the page, whether it was an app's in-app browser,
 * and whether it was a scanner. No browser family, no device class (on 13
 * November the only fb2 sign-up was the only fb2 start, and its row said
 * mobile Safari), no starts (the daily counters count them), no hour, no
 * time on screen, no friend's code, no address, no user agent. Deleted
 * after 90 days. The server log keeps the same categories, never the raw
 * user agent.
 */
import { describe, expect, it } from "vitest";
import {
  POOL_IN_APPS,
  POOL_OPEN_TRIGGERS,
  POOL_VISIT_RETENTION_DAYS,
  POOL_VISIT_TRIGGERS,
  poolBeaconLogLine,
  poolBeaconRejectedLogLine,
  poolVisitDailyKey,
  poolVisitLabel,
  poolVisitPurgeBeforeDay,
  readPoolPageBeacon,
} from "../visit-log-rules";


const FB_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/476.0.0.40.110;FBBV/628734212;FBDV/iPhone15,2;FBMD/iPhone;FBSN/iOS;FBSV/17.5;FBSS/3;FBID/phone;FBLC/en_GB;FBOP/5;FBRV/630011223]";
const FB_ANDROID =
  "Mozilla/5.0 (Linux; Android 14; SM-S918B Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.6478.122 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/470.0.0.46.85;]";
const INSTAGRAM_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 337.0.3.23.54 (iPhone15,2; iOS 17_5; en_GB; en-GB; scale=3.00; 1179x2556; 614117898)";
const NEXTDOOR_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Nextdoor/5.240.0";
const CHROME_ANDROID =
  "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
const SAFARI_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
const SAFARI_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const SAFARI_IPAD =
  "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const CHROME_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.90 Mobile/15E148 Safari/604.1";
const ANDROID_TABLET =
  "Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const SAMSUNG =
  "Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36";
const EDGE_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0";
const FIREFOX_WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0";
const ANDROID_WEBVIEW =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36";
const IOS_WEBVIEW = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const HEADLESS =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/130.0.0.0 Safari/537.36";


describe("poolVisitLabel: an app's in-app browser and the scanner flag, nothing finer", () => {
  it.each([
    ["Facebook's in-app browser on an iPhone", FB_IPHONE, { inApp: "facebook", scanner: false }],
    ["Facebook's in-app browser on Android", FB_ANDROID, { inApp: "facebook", scanner: false }],
    ["Instagram's in-app browser on an iPhone", INSTAGRAM_IPHONE, { inApp: "instagram", scanner: false }],
    ["Nextdoor's app", NEXTDOOR_IPHONE, { inApp: "nextdoor", scanner: false }],
    ["Chrome on Android", CHROME_ANDROID, { inApp: "none", scanner: false }],
    ["Safari on a Mac", SAFARI_MAC, { inApp: "none", scanner: false }],
    ["Safari on an iPhone", SAFARI_IPHONE, { inApp: "none", scanner: false }],
    ["Safari on an iPad", SAFARI_IPAD, { inApp: "none", scanner: false }],
    ["Chrome on an iPhone", CHROME_IPHONE, { inApp: "none", scanner: false }],
    ["an Android tablet", ANDROID_TABLET, { inApp: "none", scanner: false }],
    ["Samsung Internet", SAMSUNG, { inApp: "none", scanner: false }],
    ["Edge on Windows", EDGE_WINDOWS, { inApp: "none", scanner: false }],
    ["Firefox on Windows", FIREFOX_WINDOWS, { inApp: "none", scanner: false }],
    ["another app's web view on Android", ANDROID_WEBVIEW, { inApp: "other", scanner: false }],
    ["another app's web view on an iPhone", IOS_WEBVIEW, { inApp: "other", scanner: false }],
  ])("%s", (_name, ua, label) => {
    expect(poolVisitLabel(ua)).toEqual(label);
  });

  it("Facebook's link scanner is a scanner, not Facebook's in-app browser", () => {
    expect(poolVisitLabel("facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)")).toEqual({ inApp: "none", scanner: true });
  });

  it("WhatsApp's preview fetcher, a headless browser and no user agent at all are scanners", () => {
    expect(poolVisitLabel("WhatsApp/2.23.20.0 A")).toEqual({ inApp: "whatsapp", scanner: true });
    expect(poolVisitLabel(HEADLESS)).toEqual({ inApp: "none", scanner: true });
    for (const none of [null, undefined, "", "   "]) expect(poolVisitLabel(none)).toEqual({ inApp: "none", scanner: true });
  });

  it("whatever it is given, it is the two fields, each from a short fixed list", () => {
    for (const ua of [FB_IPHONE, SAFARI_MAC, "x".repeat(5000), "Mozilla/5.0 (Kemal's phone; +44 7700 900123)", "Opera/9.80 OPR/100", null]) {
      const l = poolVisitLabel(ua);
      expect(Object.keys(l).sort()).toEqual(["inApp", "scanner"]);
      expect(POOL_IN_APPS).toContain(l.inApp);
      expect(typeof l.scanner).toBe("boolean");
    }
  });
});

describe("readPoolPageBeacon: only a well-formed beacon counts (2026-11-16)", () => {
  it("the page sends opened only after a real tap, touch, key, wheel or scroll, or a start before them", () => {
    expect([...POOL_OPEN_TRIGGERS]).toEqual(["pointer", "touch", "key", "wheel", "scroll", "before-start"]);
    for (const trigger of POOL_OPEN_TRIGGERS) {
      expect(readPoolPageBeacon({ src: "fb", step: "opened", trigger })).toEqual({ ok: true, beacon: { step: "opened", trigger } });
    }
  });

  // 15 November 2026: all 4 counted opens were scanners that waited exactly
  // 5000 ms. Time on screen no longer opens anything, so a beacon saying so
  // is not one the page sends.
  it("an opened beacon opened by time on screen, or with no trigger, counts nothing, and says why", () => {
    expect(readPoolPageBeacon({ src: "fb", step: "opened", trigger: "visible-time", visibleMs: 5000 })).toEqual({ ok: false, step: "opened", reason: "time-on-screen" });
    expect(readPoolPageBeacon({ src: "fb", step: "opened" })).toEqual({ ok: false, step: "opened", reason: "no-trigger" });
    expect(readPoolPageBeacon({ src: "fb" })).toEqual({ ok: false, step: "opened", reason: "no-trigger" });
    expect(readPoolPageBeacon({})).toEqual({ ok: false, step: "opened", reason: "no-trigger" });
  });

  it("a trigger it does not know, or of the wrong type, counts nothing", () => {
    for (const trigger of ["click", "SCROLL", "", 3, {}, ["key"], "none"]) {
      expect(readPoolPageBeacon({ step: "opened", trigger })).toEqual({ ok: false, step: "opened", reason: "unknown-trigger" });
    }
    expect(readPoolPageBeacon({ step: "opened", trigger: null })).toEqual({ ok: false, step: "opened", reason: "no-trigger" });
  });

  it("no step is opened, as before: it still needs its trigger", () => {
    expect(readPoolPageBeacon({ src: "fb", trigger: "touch" })).toEqual({ ok: true, beacon: { step: "opened", trigger: "touch" } });
  });

  it("started is unchanged: it counts whatever trigger it carries, as none", () => {
    for (const trigger of [undefined, null, "key", "visible-time", "<script>"]) {
      expect(readPoolPageBeacon({ step: "started", trigger })).toEqual({ ok: true, beacon: { step: "started", trigger: "none" } });
    }
  });

  it("sent and confirmed are the server's; anything else is nobody's. The step is named only when it is one of ours", () => {
    expect(readPoolPageBeacon({ step: "sent", trigger: "touch" })).toEqual({ ok: false, step: "sent", reason: "server-step" });
    expect(readPoolPageBeacon({ step: "confirmed" })).toEqual({ ok: false, step: "confirmed", reason: "server-step" });
    for (const step of ["paid", 3, null, "<script>"]) {
      expect(readPoolPageBeacon({ step, trigger: "touch" })).toEqual({ ok: false, step: "other", reason: "unknown-step" });
    }
  });

  it("what is stored: the page's triggers, visible-time from the days before 16 November 2026, and none for an old open that did not say", () => {
    expect([...POOL_VISIT_TRIGGERS]).toEqual(["pointer", "touch", "key", "wheel", "scroll", "before-start", "visible-time", "none"]);
  });
});

describe("poolVisitDailyKey: the daily total an open adds one to, and nothing finer", () => {
  const NOW = new Date("2026-11-13T12:34:56.789Z");

  it("holds exactly the bucket, the London day, the step, what opened the page, the in-app browser and the scanner flag", () => {
    const key = poolVisitDailyKey({ code: "_referral", trigger: "touch", now: NOW, userAgent: FB_IPHONE });
    expect(key).toEqual({ code: "_referral", day: "2026-11-13", step: "opened", trigger: "touch", inApp: "facebook", scanner: false });
    const stored = JSON.stringify(key);
    for (const secret of ["iPhone", "FBAN", "safari", "mobile", "12:34", "12:00"]) expect(stored).not.toContain(secret);
  });

  it("two people on different phones and browsers add to the same total", () => {
    const a = poolVisitDailyKey({ code: "fb", trigger: "scroll", now: NOW, userAgent: SAFARI_IPHONE });
    const b = poolVisitDailyKey({ code: "fb", trigger: "scroll", now: NOW, userAgent: CHROME_ANDROID });
    const c = poolVisitDailyKey({ code: "fb", trigger: "scroll", now: NOW, userAgent: SAFARI_MAC });
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  it("the day is London's: 00:30 in summer time is the next day", () => {
    expect(poolVisitDailyKey({ code: "_direct", trigger: "key", now: new Date("2026-07-01T23:30:00Z"), userAgent: SAFARI_IPHONE }).day).toBe("2026-07-02");
  });

  it("no user agent: a scanner", () => {
    expect(poolVisitDailyKey({ code: "_direct", trigger: "key", now: NOW, userAgent: null })).toMatchObject({ scanner: true, inApp: "none" });
  });
});

describe("the server log line: the kept categories, never the user agent (2026-11-16)", () => {
  it("a counted open: the step, the bucket, the trigger, the in-app browser, the scanner flag and the result", () => {
    const line = poolBeaconLogLine({ step: "opened", bucket: "fb", trigger: "touch", label: poolVisitLabel(FB_IPHONE), result: "counted" });
    expect(line).toBe("[pool-funnel] beacon step=opened code=fb trigger=touch inApp=facebook scanner=no result=counted");
    for (const secret of ["Mozilla", "iPhone", "FBAN", "ua="]) expect(line).not.toContain(secret);
  });

  it("a fetcher and a failed lookup", () => {
    expect(poolBeaconLogLine({ step: "started", bucket: "_direct", trigger: "none", label: poolVisitLabel("facebookexternalhit/1.1"), result: "fetcher" })).toBe(
      "[pool-funnel] beacon step=started code=_direct trigger=none inApp=none scanner=yes result=fetcher",
    );
    expect(poolBeaconLogLine({ step: "opened", bucket: null, trigger: "key", label: poolVisitLabel(SAFARI_IPHONE), result: "failed" })).toBe(
      "[pool-funnel] beacon step=opened code=- trigger=key inApp=none scanner=no result=failed",
    );
  });

  it("a rejected beacon: its step, if it is one of ours, and why; nothing it sent", () => {
    expect(poolBeaconRejectedLogLine({ step: "opened", reason: "time-on-screen" })).toBe("[pool-funnel] beacon rejected step=opened reason=time-on-screen");
    expect(poolBeaconRejectedLogLine({ step: "other", reason: "not-json" })).toBe("[pool-funnel] beacon rejected step=other reason=not-json");
  });
});

describe("retention: 90 days, then deleted", () => {
  it("is 90 days", () => {
    expect(POOL_VISIT_RETENTION_DAYS).toBe(90);
  });

  it("deletes every day's totals from before 90 days ago, by London day", () => {
    expect(poolVisitPurgeBeforeDay(new Date("2026-11-13T06:00:00Z"))).toBe("2026-08-15");
    // 00:30 London on 1 July is still 30 June in UTC.
    expect(poolVisitPurgeBeforeDay(new Date("2026-06-30T23:30:00Z"))).toBe("2026-04-02");
  });
});
