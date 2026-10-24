/**
 * Referral badges in the club's badges post (growth slice G4): the same
 * post, the same header and sign-off, the referral lines after the club's
 * own badges.
 */
import { describe, expect, it } from "vitest";
import { buildBadgeAnnouncementPost } from "../badge-announcements";

describe("buildBadgeAnnouncementPost with referral badges", () => {
  it("nothing at all: no post (unchanged)", () => {
    expect(buildBadgeAnnouncementPost([], "en", [])).toBeNull();
  });

  it("English: a Recruiter alone makes a post", () => {
    expect(buildBadgeAnnouncementPost([], "en", [{ name: "Pete Parker", key: "recruiter" }])).toBe(
      "🏅 *New badges this week*\n\n" +
        "🤝 *Recruiter*: *Pete Parker* brought a new player to the game 🙌\n\n" +
        "Well played all! 👏\n📊 See your own stats and badges any time: tap the stats link in my rating DM after each match.",
    );
  });

  it("after the club's own badges, lowest first, names alphabetical", () => {
    const text = buildBadgeAnnouncementPost(
      [{ name: "Sam", keys: ["first-game"] }],
      "en",
      [
        { name: "Zed", key: "recruiter" },
        { name: "Amy", key: "talent-spotter" },
        { name: "Bob", key: "recruiter" },
        { name: "Cem", key: "scout" },
      ],
    )!;
    expect(text.split("\n").slice(2, 6)).toEqual([
      "👟 *On the board*: welcome *Sam*, first game for the club! 🎉",
      "🤝 *Recruiter*: *Bob* and *Zed* each brought a new player to the game 🙌",
      "🔭 *Scout*: *Cem* has now brought 3 players to the game 👏",
      "💎 *Talent Spotter*: *Amy* has now brought 10 players to the game, what a talent spotter! 🌟",
    ]);
  });

  it("Turkish: the club's language, the badge names stay English", () => {
    const text = buildBadgeAnnouncementPost([], "tr", [
      { name: "Pete", key: "recruiter" },
      { name: "Ayşe", key: "scout" },
    ])!;
    expect(text.split("\n")[0]).toBe("🏅 *Bu haftanın yeni rozetleri*");
    expect(text).toContain("🤝 *Recruiter*: *Pete* oyuna bir yeni oyuncu kazandırdı 🙌");
    expect(text).toContain("🔭 *Scout*: *Ayşe* oyuna artık 3 oyuncu kazandırdı 👏");
  });
});
