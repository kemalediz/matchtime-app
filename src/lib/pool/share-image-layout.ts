/**
 * Where a shared link's picture may put words (2026-11-10). PURE.
 *
 * The picture is 1200 x 630 (1.91:1, what Facebook, WhatsApp and X ask
 * for), but some Facebook mobile layouts centre-crop it to a square: only
 * the middle 630 x 630 (x 285 to 915) shows. Kemal's phone showed the
 * /play preview in a Facebook group as "...ered local football ga..." for
 * that reason. So every word and the logo go inside the centred safe area,
 * which keeps a 45px margin inside that square; the rest of the picture is
 * background and decoration only, so the wide version does not look empty.
 */
export const SHARE_IMAGE = { width: 1200, height: 630 } as const;

/** The middle square some Facebook mobile layouts crop the picture to. */
export const SHARE_IMAGE_SQUARE_CROP = {
  left: (SHARE_IMAGE.width - SHARE_IMAGE.height) / 2,
  right: (SHARE_IMAGE.width + SHARE_IMAGE.height) / 2,
} as const;

/** The only box words and the logo may be drawn in. */
export const SHARE_IMAGE_SAFE_AREA = { left: 330, right: 870, top: 48, bottom: 582 } as const;
