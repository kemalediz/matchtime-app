/**
 * The /play visit breakdown's pure rules. 2026-11-13: one row per beacon,
 * kept 90 days. 2026-11-16 (Kemal): DAILY TOTALS ONLY. At our traffic an
 * hour-stamped row per visit could be matched to the one person who signed
 * up that hour, so nothing per visit is kept any more: per code, London day,
 * step and coarse category (what opened the page, browser type, in-app
 * browser, device, scanner), a count. No hour, no time on screen, no
 * friend's code, no address, no user agent. Deleted after 90 days.
 */
import { describe, expect, it } from "vitest";
import {
  POOL_BROWSERS,
  POOL_DEVICES,
  POOL_IN_APPS,
  POOL_OPEN_TRIGGERS,
  POOL_VISIT_RETENTION_DAYS,
  POOL_VISIT_TRIGGERS,
  poolBrowserLabel,
  poolVisitDailyKey,
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

describe("poolBrowserLabel: a coarse label, never the user agent", () => {
  it.each([
    ["Facebook's in-app browser on an iPhone", FB_IPHONE, { browser: "safari", inApp: "facebook", device: "mobile", scanner: false }],
    ["Facebook's in-app browser on Android", FB_ANDROID, { browser: "chrome", inApp: "facebook", device: "mobile", scanner: false }],
    ["Instagram's in-app browser on an iPhone", INSTAGRAM_IPHONE, { browser: "safari", inApp: "instagram", device: "mobile", scanner: false }],
    ["Nextdoor's app", NEXTDOOR_IPHONE, { browser: "safari", inApp: "nextdoor", device: "mobile", scanner: false }],
    ["Chrome on Android", CHROME_ANDROID, { browser: "chrome", inApp: "none", device: "mobile", scanner: false }],
    ["Safari on a Mac", SAFARI_MAC, { browser: "safari", inApp: "none", device: "desktop", scanner: false }],
    ["Safari on an iPhone", SAFARI_IPHONE, { browser: "safari", inApp: "none", device: "mobile", scanner: false }],
    ["Safari on an iPad", SAFARI_IPAD, { browser: "safari", inApp: "none", device: "tablet", scanner: false }],
    ["Chrome on an iPhone", CHROME_IPHONE, { browser: "chrome", inApp: "none", device: "mobile", scanner: false }],
    ["an Android tablet", ANDROID_TABLET, { browser: "chrome", inApp: "none", device: "tablet", scanner: false }],
    ["Samsung Internet", SAMSUNG, { browser: "samsung", inApp: "none", device: "mobile", scanner: false }],
    ["Edge on Windows", EDGE_WINDOWS, { browser: "edge", inApp: "none", device: "desktop", scanner: false }],
    ["Firefox on Windows", FIREFOX_WINDOWS, { browser: "firefox", inApp: "none", device: "desktop", scanner: false }],
    ["another app's web view on Android", ANDROID_WEBVIEW, { browser: "chrome", inApp: "other", device: "mobile", scanner: false }],
    ["another app's web view on an iPhone", IOS_WEBVIEW, { browser: "safari", inApp: "other", device: "mobile", scanner: false }],
  ])("%s", (_name, ua, label) => {
    expect(poolBrowserLabel(ua)).toEqual(label);
  });

  it("Facebook's link scanner is a scanner, not Facebook's in-app browser", () => {
    expect(poolBrowserLabel("facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)")).toEqual({
      browser: "other",
      inApp: "none",
      device: "other",
      scanner: true,
    });
  });

  it("WhatsApp's preview fetcher, a headless browser and no user agent at all are scanners", () => {
    expect(poolBrowserLabel("WhatsApp/2.23.20.0 A")).toEqual({ browser: "other", inApp: "whatsapp", device: "other", scanner: true });
    expect(poolBrowserLabel(HEADLESS)).toMatchObject({ device: "desktop", scanner: true });
    for (const none of [null, undefined, "", "   "]) {
      expect(poolBrowserLabel(none)).toEqual({ browser: "other", inApp: "none", device: "other", scanner: true });
    }
  });

  it("whatever it is given, every value comes from a short fixed list", () => {
    for (const ua of [FB_IPHONE, SAFARI_MAC, "x".repeat(5000), "Mozilla/5.0 (Kemal's phone; +44 7700 900123)", "Opera/9.80 OPR/100", null]) {
      const l = poolBrowserLabel(ua);
      expect(POOL_BROWSERS).toContain(l.browser);
      expect(POOL_IN_APPS).toContain(l.inApp);
      expect(POOL_DEVICES).toContain(l.device);
      expect(typeof l.scanner).toBe("boolean");
    }
  });
});

describe("readPoolPageBeacon: only a well-formed beacon counts (2026-11-16)", () => {
  it("the page sends opened only after a real tap, touch, key, wheel or scroll, or a start before them", () => {
    expect([...POOL_OPEN_TRIGGERS]).toEqual(["pointer", "touch", "key", "wheel", "scroll", "before-start"]);
    for (const trigger of POOL_OPEN_TRIGGERS) {
      expect(readPoolPageBeacon({ src: "fb", step: "opened", trigger })).toEqual({ step: "opened", trigger });
    }
  });

  // 15 November 2026: all 4 counted opens were scanners that waited exactly
  // 5000 ms. Time on screen no longer opens anything, so a beacon saying so
  // is not one the page sends.
  it("an opened beacon opened by time on screen, or with no trigger, counts nothing", () => {
    expect(readPoolPageBeacon({ src: "fb", step: "opened", trigger: "visible-time", visibleMs: 5000 })).toBeNull();
    expect(readPoolPageBeacon({ src: "fb", step: "opened" })).toBeNull();
    expect(readPoolPageBeacon({ src: "fb" })).toBeNull();
    expect(readPoolPageBeacon({})).toBeNull();
  });

  it("a trigger it does not know, or of the wrong type, counts nothing", () => {
    for (const trigger of ["click", "SCROLL", "", 3, null, {}, ["key"], "none"]) {
      expect(readPoolPageBeacon({ step: "opened", trigger })).toBeNull();
    }
  });

  it("no step is opened, as before: it still needs its trigger", () => {
    expect(readPoolPageBeacon({ src: "fb", trigger: "touch" })).toEqual({ step: "opened", trigger: "touch" });
  });

  it("started is unchanged: it counts whatever trigger it carries, stored as none", () => {
    for (const trigger of [undefined, null, "key", "visible-time", "<script>"]) {
      expect(readPoolPageBeacon({ step: "started", trigger })).toEqual({ step: "started", trigger: "none" });
    }
  });

  it("sent, confirmed and anything else are the server's or nobody's: nothing", () => {
    for (const step of ["sent", "confirmed", "paid", 3, null]) {
      expect(readPoolPageBeacon({ step, trigger: "touch" })).toBeNull();
    }
  });

  it("what is stored: the page's triggers, visible-time from the days before 16 November 2026, and none", () => {
    expect([...POOL_VISIT_TRIGGERS]).toEqual(["pointer", "touch", "key", "wheel", "scroll", "before-start", "visible-time", "none"]);
  });
});

describe("poolVisitDailyKey: the daily total a beacon adds one to, and nothing per visit", () => {
  const NOW = new Date("2026-11-13T12:34:56.789Z");

  it("holds exactly the bucket, the London day, the step, what opened the page and the coarse label", () => {
    const key = poolVisitDailyKey({ code: "_referral", step: "opened", trigger: "touch", now: NOW, userAgent: FB_IPHONE });
    expect(key).toEqual({
      code: "_referral",
      day: "2026-11-13",
      step: "opened",
      trigger: "touch",
      browser: "safari",
      inApp: "facebook",
      device: "mobile",
      scanner: false,
    });
    const stored = JSON.stringify(key);
    for (const secret of ["iPhone", "FBAN", "12:34", "12:00"]) expect(stored).not.toContain(secret);
  });

  it("the day is London's: 00:30 in summer time is the next day", () => {
    const key = poolVisitDailyKey({ code: "_direct", step: "started", trigger: "none", now: new Date("2026-07-01T23:30:00Z"), userAgent: SAFARI_IPHONE });
    expect(key.day).toBe("2026-07-02");
  });

  it("no user agent: a scanner", () => {
    expect(poolVisitDailyKey({ code: "_direct", step: "started", trigger: "none", now: NOW, userAgent: null })).toMatchObject({ scanner: true, device: "other" });
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
