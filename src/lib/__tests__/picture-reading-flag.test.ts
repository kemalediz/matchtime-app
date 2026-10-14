import { describe, expect, it } from "vitest";
import {
  isPictureReadingEnabled,
  pictureReadingEnabledForApiRequest,
  PICTURE_READING_TEST_HEADER,
} from "../picture-reading-flag";

const req = (h: Record<string, string> = {}) => new Request("http://x/api", { headers: h });

describe("PICTURE_READING_ENABLED", () => {
  it("is OFF unless explicitly on", () => {
    expect(isPictureReadingEnabled({})).toBe(false);
    expect(isPictureReadingEnabled({ PICTURE_READING_ENABLED: "" })).toBe(false);
    expect(isPictureReadingEnabled({ PICTURE_READING_ENABLED: "0" })).toBe(false);
    expect(isPictureReadingEnabled({ PICTURE_READING_ENABLED: "false" })).toBe(false);
    for (const v of ["1", "true", "on", "yes", " TRUE "]) {
      expect(isPictureReadingEnabled({ PICTURE_READING_ENABLED: v })).toBe(true);
    }
  });

  it("the test header is honoured only under MT_TEST_MODE=1, in both directions", () => {
    expect(pictureReadingEnabledForApiRequest(req({ [PICTURE_READING_TEST_HEADER]: "1" }), {})).toBe(false);
    expect(
      pictureReadingEnabledForApiRequest(req({ [PICTURE_READING_TEST_HEADER]: "0" }), { PICTURE_READING_ENABLED: "1" }),
    ).toBe(true);
    expect(pictureReadingEnabledForApiRequest(req({ [PICTURE_READING_TEST_HEADER]: "1" }), { MT_TEST_MODE: "1" })).toBe(true);
    expect(
      pictureReadingEnabledForApiRequest(req({ [PICTURE_READING_TEST_HEADER]: "0" }), {
        MT_TEST_MODE: "1",
        PICTURE_READING_ENABLED: "1",
      }),
    ).toBe(false);
  });
});
