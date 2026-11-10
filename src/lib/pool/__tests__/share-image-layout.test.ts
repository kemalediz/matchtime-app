/**
 * The safe area of a shared /play link's picture (2026-11-10). Kemal's phone
 * showed the Facebook group preview of matchtime.ai/play?src=fb cropped to
 * the middle square ("...ered local football ga...", "...tsApp"): some
 * Facebook mobile layouts centre-crop the 1200 x 630 picture to 630 x 630.
 * Everything that must be read sits in a centred box that keeps a margin
 * inside that square.
 */
import { describe, expect, it } from "vitest";
import { SHARE_IMAGE, SHARE_IMAGE_SAFE_AREA, SHARE_IMAGE_SQUARE_CROP } from "../share-image-layout";

describe("the share picture's safe area", () => {
  it("the picture is 1200 x 630 and its square crop is the middle 630 x 630", () => {
    expect(SHARE_IMAGE).toEqual({ width: 1200, height: 630 });
    expect(SHARE_IMAGE_SQUARE_CROP).toEqual({ left: 285, right: 915 });
  });

  it("the safe area is x 330 to 870, centred", () => {
    expect(SHARE_IMAGE_SAFE_AREA.left).toBe(330);
    expect(SHARE_IMAGE_SAFE_AREA.right).toBe(870);
    expect(SHARE_IMAGE_SAFE_AREA.left + SHARE_IMAGE_SAFE_AREA.right).toBe(SHARE_IMAGE.width);
  });

  it("keeps at least 40px inside the square crop on both sides, and generous margins top and bottom", () => {
    expect(SHARE_IMAGE_SAFE_AREA.left - SHARE_IMAGE_SQUARE_CROP.left).toBeGreaterThanOrEqual(40);
    expect(SHARE_IMAGE_SQUARE_CROP.right - SHARE_IMAGE_SAFE_AREA.right).toBeGreaterThanOrEqual(40);
    expect(SHARE_IMAGE_SAFE_AREA.top).toBeGreaterThanOrEqual(40);
    expect(SHARE_IMAGE.height - SHARE_IMAGE_SAFE_AREA.bottom).toBeGreaterThanOrEqual(40);
  });
});
