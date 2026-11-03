/**
 * Visits to /play per campaign code (2026-11-03): the pure half. A link
 * preview fetcher (Facebook, Nextdoor, WhatsApp, X) is never a visit; the
 * bucket a visit counts under mirrors how the sign-up would be counted
 * (`signup.ts` resolveSource), so visits and sign-ups compare like for like.
 */
import { describe, expect, it } from "vitest";
import {
  POOL_VISIT_DIRECT,
  POOL_VISIT_REFERRAL,
  isLinkPreviewFetcher,
  poolVisitBucket,
  poolVisitDay,
  poolVisitTotals,
} from "../visit-rules";

const FETCHERS = [
  "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
  "facebookexternalhit/1.1;line-poker",
  "Facebot",
  "meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)",
  "meta-externalfetcher/1.1",
  "WhatsApp/2.23.20.0 A",
  "WhatsApp/2.2348.50 i",
  "Twitterbot/1.0",
  "LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)",
  "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
  "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)",
  "TelegramBot (like TwitterBot)",
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_1) AppleWebKit/601.2.4 (KHTML, like Gecko) Version/9.0.1 Safari/601.2.4 facebookexternalhit/1.1 Facebot Twitterbot/1.0",
  "Mozilla/5.0 (compatible; NextdoorBot/1.0)",
  "Nextdoor-LinkPreview/1.0",
  "Pinterestbot/1.0",
  "Mozilla/5.0 (compatible; Embedly/0.2; +http://support.embed.ly/)",
  "Iframely/1.3.1 (+https://iframely.com/docs/about)",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0.0.0 Safari/537.36",
  "Snap URL Preview Service; bot; snapchat; https://developers.snap.com/robots",
  "curl/8.4.0",
  "python-requests/2.31.0",
  "Go-http-client/1.1",
  "node-fetch/1.0",
  "",
];

const PEOPLE = [
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
  // Facebook's and Instagram's own in-app browsers: a person who tapped the post.
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/21F79 [FBAN/FBIOS;FBAV/466.0.0.36.106;FBBV/601218429;FBDV/iPhone15,2;FBMD/iPhone;FBSN/iOS;FBSV/17.5;FBSS/3;FBCR/;FBID/phone;FBLC/en_GB;FBOP/5]",
  "Mozilla/5.0 (Linux; Android 14; SM-S918B Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/124.0.6367.82 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/462.0.0.47.86;]",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 330.0.3.25.90",
  // A Nextdoor app webview: the app's name in it does not make it a fetcher.
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Nextdoor/5.180.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:126.0) Gecko/20100101 Firefox/126.0",
];

describe("link preview fetchers are never visits", () => {
  for (const ua of FETCHERS) it(`fetcher: ${ua || "(no user agent)"}`, () => expect(isLinkPreviewFetcher(ua)).toBe(true));
  it("a missing header is a fetcher", () => expect(isLinkPreviewFetcher(null)).toBe(true));
  for (const ua of PEOPLE) it(`person: ${ua.slice(0, 70)}`, () => expect(isLinkPreviewFetcher(ua)).toBe(false));
});

describe("the bucket a visit counts under", () => {
  it("a live campaign's code", () => expect(poolVisitBucket({ campaignCode: "fb-sutton", referralCode: null }, { campaignLive: true })).toBe("fb-sutton"));
  it("/play with no code is direct", () => expect(poolVisitBucket({ campaignCode: null, referralCode: null }, { campaignLive: false })).toBe(POOL_VISIT_DIRECT));
  it("an unknown or switched-off code is direct, as its sign-up counts as the web", () =>
    expect(poolVisitBucket({ campaignCode: "nope", referralCode: null }, { campaignLive: false })).toBe(POOL_VISIT_DIRECT));
  it("a friend's link is a referral visit, first, as the sign-up's own order", () =>
    expect(poolVisitBucket({ campaignCode: "fb-sutton", referralCode: "AB12cd" }, { campaignLive: true })).toBe(POOL_VISIT_REFERRAL));
  it("the two reserved buckets can never be a campaign code (codes have no underscore)", () => {
    expect(POOL_VISIT_DIRECT).toMatch(/_/);
    expect(POOL_VISIT_REFERRAL).toMatch(/_/);
  });
});

describe("the day a visit counts on", () => {
  it("is the London day", () => {
    // 23:30 UTC on 31 Oct is still 31 Oct in London (GMT)...
    expect(poolVisitDay(new Date("2026-10-31T23:30:00Z"))).toBe("2026-10-31");
    // ...and 23:30 UTC on 30 Jun is already 1 Jul in London (BST).
    expect(poolVisitDay(new Date("2026-06-30T23:30:00Z"))).toBe("2026-07-01");
  });
});

describe("totals per bucket", () => {
  it("adds every day's count", () => {
    const t = poolVisitTotals([
      { code: "fb-sutton", count: 3 },
      { code: "fb-sutton", count: 4 },
      { code: POOL_VISIT_DIRECT, count: 10 },
    ]);
    expect(t.get("fb-sutton")).toBe(7);
    expect(t.get(POOL_VISIT_DIRECT)).toBe(10);
    expect(t.get("other")).toBeUndefined();
  });
});
