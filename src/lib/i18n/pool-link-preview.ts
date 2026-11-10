/**
 * The link preview a shared /play link shows (2026-11-03): the words
 * Facebook, Nextdoor, WhatsApp and X put under a posted link, and the
 * picture (`src/app/play/opengraph-image.tsx`) draws. CLIENT-SAFE.
 *
 * For a player who has never heard of MatchTime: what he gets, in plain
 * words. No prices and nothing for organisers (the homepage's card, which
 * /play used to inherit, is for organisers). Not on the /play page itself,
 * so the page's own copy rules (`pool-play.ts`) do not bind it.
 *
 * One object per language, typed by `PoolLinkPreviewCopy`, so a missing
 * line is a `tsc` error. House rules (unit tested in
 * `__tests__/pool-link-preview-copy.test.ts`): no em or en dashes, no slash
 * as a separator, "bench" never "waiting list", Turkish never equal to
 * English.
 */
import { normaliseLang, type Lang } from "./lang";
import { POOL_LINK_PREVIEW_EN } from "./pool-link-preview.en";
import { POOL_LINK_PREVIEW_TR } from "./pool-link-preview.tr";

export interface PoolLinkPreviewCopy {
  title: string;
  /** One plain sentence. */
  description: string;
  imageAlt: string;
  /** The picture's one short line under the headline, in a green pill. */
  imageBadge: string;
}

const BY_LANG: Record<Lang, PoolLinkPreviewCopy> = { en: POOL_LINK_PREVIEW_EN, tr: POOL_LINK_PREVIEW_TR };

export function poolLinkPreviewCopy(lang: Lang | string | null | undefined): PoolLinkPreviewCopy {
  return BY_LANG[normaliseLang(lang)];
}
