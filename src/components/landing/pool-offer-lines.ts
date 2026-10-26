/**
 * The home page's drawn pool offer (variant D round 2), built from the
 * REAL words the offer DM uses (i18n/pool-offer.en.ts: offer_head,
 * game_with_format, offer_when, distance, style_casual, club_weekly,
 * offer_cta, placed_in) in the order pool/offer-copy.ts poolOfferLines
 * puts them, with the example values in `POOL_SECTION.offer`. Drawn
 * without the bot's emoji; WhatsApp *bold* is kept as marked text. No fee
 * line and no map line: the site keeps prices on the pricing page.
 */
import { poolOfferEn as c } from "@/lib/i18n/pool-offer.en";
import { t } from "@/lib/i18n/t";
import { POOL_SECTION } from "./landing-content";
import { withoutEmoji } from "./dropout-bot-lines";

export function poolOfferMock(o = POOL_SECTION.offer): { offer: string[]; cta: string; placed: string } {
  const game = c.game_with_format({ format: t("en").sj_per_side_option({ perSide: o.format }), sport: o.sport });
  return {
    offer: [
      c.offer_head({ club: o.club, places: 1, game }),
      c.offer_when({ day: o.day, mins: o.mins }),
      `📍 *${o.venue}*. ${c.distance({ miles: o.miles, one: false })}`,
      `🤝 ${c.style_casual}. ${c.club_weekly({ members: o.members })}`,
    ].map(withoutEmoji),
    cta: withoutEmoji(c.offer_cta({ link: o.link })),
    placed: withoutEmoji(c.placed_in({ club: o.club, day: o.day, venue: o.venue })),
  };
}
