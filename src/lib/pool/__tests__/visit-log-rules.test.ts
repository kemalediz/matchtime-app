/**
 * The /play visit log's pure rules (2026-11-13). The daily counters could
 * not say why visitors left on 12 November, and the beacon's detail lived
 * only in the server log for a day. Kemal approved keeping a visit's detail
 * for 90 days on three conditions: only what the funnel analysis needs (no
 * address, no raw user agent, no referral code, no id, no cookie, the time
 * only to the hour), deleted automatically after 90 days,
 * and said in the privacy notice. These pin the first two.
 */
import { describe, expect, it } from "vitest";
import {
  POOL_BROWSERS,
  POOL_DEVICES,
  POOL_IN_APPS,
  POOL_OPEN_TRIGGERS,
  POOL_VISIT_MAX_VISIBLE_MS,
  POOL_VISIT_RETENTION_DAYS,
  poolBrowserLabel,
  poolVisitEventRow,
  POOL_VISIT_LOG_CAP_PER_HOUR,
  poolVisitHour,
  poolVisitLogHasRoom,
  poolVisitPurgeBefore,
  readPoolVisitDetail,
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

describe("readPoolVisitDetail: what the beacon may add, checked and clamped", () => {
  it("opened: what first showed a person, and the visible time rounded to a tenth of a second", () => {
    expect(readPoolVisitDetail({ trigger: "scroll", visibleMs: 5234.6 }, "opened")).toEqual({ openedBy: "scroll", visibleMs: 5200 });
    for (const trigger of POOL_OPEN_TRIGGERS) {
      expect(readPoolVisitDetail({ trigger, visibleMs: 0 }, "opened").openedBy).toBe(trigger);
    }
  });

  it("the triggers are the gate's own, and only those", () => {
    expect([...POOL_OPEN_TRIGGERS]).toEqual(["pointer", "touch", "key", "wheel", "scroll", "visible-time", "before-start"]);
  });

  it("a trigger it does not know, or of the wrong type, is none", () => {
    for (const trigger of ["click", "SCROLL", "", 3, null, {}, ["key"]]) {
      expect(readPoolVisitDetail({ trigger, visibleMs: 100 }, "opened").openedBy).toBeNull();
    }
  });

  it("started never carries a trigger: only opened has one", () => {
    expect(readPoolVisitDetail({ trigger: "key", visibleMs: 12_000 }, "started")).toEqual({ openedBy: null, visibleMs: 12_000 });
  });

  it("visible time: a whole number from 0 to 24 hours; anything that is not a finite number is none", () => {
    expect(readPoolVisitDetail({ visibleMs: -5 }, "opened").visibleMs).toBe(0);
    expect(readPoolVisitDetail({ visibleMs: 1e12 }, "opened").visibleMs).toBe(POOL_VISIT_MAX_VISIBLE_MS);
    expect(POOL_VISIT_MAX_VISIBLE_MS).toBe(24 * 3600 * 1000);
    for (const visibleMs of ["5000", null, undefined, Number.NaN, Number.POSITIVE_INFINITY, true, {}]) {
      expect(readPoolVisitDetail({ visibleMs }, "opened").visibleMs).toBeNull();
    }
  });

  it("a page cached before the log existed sends neither: both none", () => {
    expect(readPoolVisitDetail({ src: "fb", step: "opened" }, "opened")).toEqual({ openedBy: null, visibleMs: null });
  });
});

describe("poolVisitEventRow: the row, and no address, user agent or friend's code", () => {
  const NOW = new Date("2026-11-13T12:34:56.789Z");

  it("holds exactly the hour, the bucket, the step, the detail, whether a friend's link was used and the coarse label", () => {
    const row = poolVisitEventRow({
      code: "_referral",
      step: "opened",
      now: NOW,
      detail: { openedBy: "touch", visibleMs: 900 },
      referralCode: "AB12cd",
      userAgent: FB_IPHONE,
    });
    expect(row).toEqual({
      at: new Date("2026-11-13T12:00:00.000Z"),
      code: "_referral",
      step: "opened",
      openedBy: "touch",
      visibleMs: 900,
      hasRef: true,
      browser: "safari",
      inApp: "facebook",
      device: "mobile",
      scanner: false,
    });
    const stored = JSON.stringify(row);
    expect(stored).not.toContain("AB12cd");
    expect(stored).not.toContain("iPhone");
    expect(stored).not.toContain("FBAN");
  });

  it("no friend's code: hasRef false", () => {
    expect(
      poolVisitEventRow({ code: "_direct", step: "started", now: NOW, detail: { openedBy: null, visibleMs: null }, referralCode: null, userAgent: null }),
    ).toMatchObject({ hasRef: false, scanner: true, openedBy: null, visibleMs: null });
  });
});

describe("retention: 90 days, then deleted", () => {
  it("is 90 days", () => {
    expect(POOL_VISIT_RETENTION_DAYS).toBe(90);
  });

  it("deletes every row from before 90 days ago", () => {
    expect(poolVisitPurgeBefore(new Date("2026-11-13T06:00:00Z"))).toEqual(new Date("2026-08-15T06:00:00Z"));
  });

  // Review of #600: a minute plus the code could be matched to a sign-up
  // made a minute later with the same code. An hour does not single one out so easily.
  it("keeps the time to the hour only", () => {
    expect(poolVisitHour(new Date("2026-11-13T12:34:56.789Z"))).toEqual(new Date("2026-11-13T12:00:00.000Z"));
    expect(poolVisitHour(new Date("2026-11-13T12:59:59.999Z"))).toEqual(new Date("2026-11-13T12:00:00.000Z"));
    expect(poolVisitHour(new Date("2026-11-13T13:00:00.000Z"))).toEqual(new Date("2026-11-13T13:00:00.000Z"));
  });
});

describe("the volume cap: at most 200 rows per code and hour", () => {
  it("is 200, generous for real traffic (the 24 opens of 4 November 2026 were a whole day)", () => {
    expect(POOL_VISIT_LOG_CAP_PER_HOUR).toBe(200);
  });

  it("has room until the bucket's hour holds 200 rows, then none", () => {
    expect(poolVisitLogHasRoom(0)).toBe(true);
    expect(poolVisitLogHasRoom(199)).toBe(true);
    expect(poolVisitLogHasRoom(200)).toBe(false);
    expect(poolVisitLogHasRoom(5_000)).toBe(false);
  });
});
