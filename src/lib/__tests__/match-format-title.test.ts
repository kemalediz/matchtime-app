/**
 * The name a post gives a game (`matchFormatTitle`, 2026-11-16).
 *
 * The Vets, 16 Nov 2026: after "@Match Time switch to 8side" the match had
 * 16 places, but the new list was headed "📋 *Football 7-a-side, Mon 16
 * Nov at 20:15*": the title was the Activity's name, which self-join wrote
 * from the club's usual size. A title that names a format names the
 * format being PLAYED (Match.maxPlayers / 2 a side); a name the club chose
 * that names no format ("Monday night vets") is kept as it is.
 */
import { describe, expect, it } from "vitest";
import { matchFormatTitle } from "@/lib/match-format-title";

describe("matchFormatTitle", () => {
  it("a 7-a-side game switched to 8 a side is called 8-a-side (the Vets list)", () => {
    expect(matchFormatTitle("Football 7-a-side", 16)).toBe("Football 8-a-side");
  });

  it("the same in Turkish: self-join's \"7'ye 7 futbol\" becomes \"8'e 8 futbol\"", () => {
    expect(matchFormatTitle("7'ye 7 futbol", 16)).toBe("8'e 8 futbol");
    expect(matchFormatTitle("7'ye 7 futbol", 12)).toBe("6'ya 6 futbol");
  });

  it("Turkish: only the dative size form is a size; \"7'de 7\" and a time are not", () => {
    expect(matchFormatTitle("Saat 7'de 7 kişi", 16)).toBe("Saat 7'de 7 kişi");
    expect(matchFormatTitle("Pazartesi 20'de 20 kişi", 16)).toBe("Pazartesi 20'de 20 kişi");
    expect(matchFormatTitle("5'e 5 halı saha", 12)).toBe("6'ya 6 halı saha");
  });

  it("a match with no override keeps the activity's name exactly", () => {
    expect(matchFormatTitle("Football 7-a-side", 14)).toBe("Football 7-a-side");
    expect(matchFormatTitle("7'ye 7 futbol", 14)).toBe("7'ye 7 futbol");
  });

  it("a club-named activity that names no format is kept, whatever the size", () => {
    expect(matchFormatTitle("Monday night vets", 16)).toBe("Monday night vets");
    expect(matchFormatTitle("Thursday Footie", 10)).toBe("Thursday Footie");
  });

  it("a club's own name with a format in it keeps its words and changes only the size", () => {
    expect(matchFormatTitle("Monday 7-a-side", 12)).toBe("Monday 6-a-side");
    expect(matchFormatTitle("Tuesday 5 a side", 14)).toBe("Tuesday 7 a side");
    expect(matchFormatTitle("Sunday 7-A-Side League", 16)).toBe("Sunday 8-A-Side League");
  });

  it("a number that is not the format is left alone", () => {
    expect(matchFormatTitle("Club 1871", 16)).toBe("Club 1871");
    expect(matchFormatTitle("Football 17-a-side", 16)).toBe("Football 8-a-side");
  });

  it("a size that is no whole number a side changes nothing", () => {
    expect(matchFormatTitle("Football 7-a-side", 15)).toBe("Football 7-a-side");
    expect(matchFormatTitle("Football 7-a-side", 0)).toBe("Football 7-a-side");
    expect(matchFormatTitle("Football 7-a-side", null)).toBe("Football 7-a-side");
    expect(matchFormatTitle("Football 7-a-side", undefined)).toBe("Football 7-a-side");
  });
});
