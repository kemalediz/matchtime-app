/**
 * Link preview fetchers, crawlers and scripts (2026-11-03). PURE.
 *
 * A fetcher is never counted as a visit to /play (`pool/visit-rules.ts`).
 * It is the SECOND guard: the visit is a beacon the page's script sends,
 * and a preview fetcher runs no script. This catches the ones that do
 * (Googlebot, headless browsers) and anything that calls the endpoint.
 *
 * Next's own list of HTML-limited bots (facebookexternalhit, Twitterbot,
 * WhatsApp, LinkedInBot, Slackbot, Discordbot, Googlebot and the rest, the
 * list Next uses to decide who gets blocking metadata), then specific
 * tokens and generic words a person's browser never sends. NOT an app's
 * name on its own: Facebook's, Instagram's and Nextdoor's in-app browsers
 * are people tapping a post. Nextdoor's own fetcher's user agent is not
 * confirmed; "bot" and "preview" catch the usual forms. "Cubot" is a phone.
 */
import { HTML_LIMITED_BOT_UA_RE } from "next/dist/shared/lib/router/utils/html-bots";

const MORE_FETCHERS_RE =
  /(?<!cu)bot\b|bot\/|crawl|spider|slurp|preview|externalhit|externalagent|externalfetcher|facebot|embedly|iframely|headless|lighthouse|curl\/|wget|python|httpclient|http-client|okhttp|axios|node-fetch|undici|java\/|libwww|scrapy/i;

export const LINK_PREVIEW_FETCHER_RE = new RegExp(`${HTML_LIMITED_BOT_UA_RE.source}|${MORE_FETCHERS_RE.source}`, "i");

/** Is this request a fetcher, not a person? No user agent at all is one. */
export function isLinkPreviewFetcher(userAgent: string | null | undefined): boolean {
  const ua = (userAgent ?? "").trim();
  return !ua || LINK_PREVIEW_FETCHER_RE.test(ua);
}
