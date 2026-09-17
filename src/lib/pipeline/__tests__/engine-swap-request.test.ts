/**
 * A MESSAGE THAT ASKS TO SWAP TWO PLAYERS IS NEVER AN ATTENDANCE CHANGE
 * FOR EITHER OF THEM (2026-09-17, dry-run cases TR26 / TR27).
 *
 * The swap fast path in the analyze route applies what it can and hands
 * the rest on. When it cannot apply a swap (an unknown or ambiguous name,
 * teams not generated), or when the swap was not tagged, the message
 * reaches the attendance pipeline, and the extractor reads "swap David
 * and Sait" as David leaving. Measured live against the Sutton squad,
 * REPEAT=10, before this change:
 *
 *   "@Match Time swap David and Sait"          DROPPED David 10 of 10
 *   "@Match Time David ile Sait'i değiştir"    DROPPED David  9 of 10
 *
 * The claims are fed here in exactly the shape the live extractor
 * returned (`basis=decision polarity=out conf=0.7`), so these tests pin
 * the ENGINE's answer to the model's real reading, not to a reading we
 * would have preferred.
 */
import { describe, it, expect } from "vitest";
import { decide } from "../engine";
import { NOW, SUTTON, attendanceFacts, claim, msg, statusOf, world } from "./helpers";

const PLAYERS = [...SUTTON, "david"];
const CONFIRMED = ["kemal", "elvin", "sait", "mustafa", "abid", "david", "zeeshan", "najib"];

function run(body: string, claims: ReturnType<typeof claim>[], o: { tagged?: boolean; from?: string } = {}) {
  const state = world({ players: PLAYERS, confirmed: CONFIRMED });
  const r = decide({
    now: NOW,
    state,
    messages: [
      msg({
        from: o.from ?? "kemal",
        body,
        tagged: o.tagged ?? true,
        route: "other_att",
        facts: attendanceFacts(claims),
      }),
    ],
  });
  return r;
}

const davidOut = claim({ subject: "other", personRef: "David", personNamed: true, polarity: "out", confidence: 0.7 });

describe("a swap request writes no attendance for the two players it names", () => {
  it("TR27: '@Match Time swap David and Sait' does not drop David", () => {
    const r = run("@Match Time swap David and Sait", [davidOut]);
    expect(r.writes.filter((w) => w.kind === "attendance")).toEqual([]);
    expect(statusOf(r.nextState, "david")).toBe("CONFIRMED");
    expect(r.outcomes[0].reasons.join(" ")).toMatch(/swap/i);
  });

  it("TR26: the Turkish form does not drop David or add Sait", () => {
    const r = run("@Match Time David ile Sait'i değiştir", [
      davidOut,
      claim({ subject: "other", personRef: "Sait'i", personNamed: true, polarity: "in", confidence: 0.7 }),
    ]);
    expect(r.writes).toEqual([]);
    expect(statusOf(r.nextState, "david")).toBe("CONFIRMED");
  });

  it("an UNTAGGED swap from an admin does not drop David either (the admin OUT waiver is not a swap waiver)", () => {
    const r = run("swap David and Sait", [davidOut], { tagged: false });
    expect(r.writes).toEqual([]);
    expect(statusOf(r.nextState, "david")).toBe("CONFIRMED");
  });

  it("the sender's own OUT in the same message still lands", () => {
    const r = run("@Match Time swap David and Sait and I'm out", [
      davidOut,
      claim({ subject: "sender", polarity: "out" }),
    ]);
    expect(statusOf(r.nextState, "kemal")).toBe("DROPPED");
    expect(statusOf(r.nextState, "david")).toBe("CONFIRMED");
  });

  it("a third party the swap does NOT name still drops", () => {
    const r = run("@Match Time swap David and Sait. Zeeshan is out", [
      davidOut,
      claim({ subject: "other", personRef: "Zeeshan", personNamed: true, polarity: "out" }),
    ]);
    expect(statusOf(r.nextState, "zeeshan")).toBe("DROPPED");
    expect(statusOf(r.nextState, "david")).toBe("CONFIRMED");
  });

  it("'swap me with David' does not drop the sender", () => {
    const r = run("@Match Time swap me with David", [claim({ subject: "sender", polarity: "out", confidence: 0.7 })]);
    expect(r.writes).toEqual([]);
    expect(statusOf(r.nextState, "kemal")).toBe("CONFIRMED");
  });
});

describe("a refused swap claim supersedes nothing", () => {
  it("'in' then 'swap me with David' in one batch still registers the sender", () => {
    // S35 lets only an author's LATEST self message write. A self claim
    // the swap guard refuses must not count as that latest message, or
    // the real "in" before it is discarded as superseded.
    const state = world({ players: PLAYERS, confirmed: ["david"] });
    const r = decide({
      now: NOW,
      state,
      messages: [
        msg({ from: "zair", body: "in", route: "self_att", facts: attendanceFacts([claim({ polarity: "in" })]) }),
        msg({
          from: "zair",
          body: "@Match Time swap me with David",
          tagged: true,
          route: "self_att",
          facts: attendanceFacts([claim({ polarity: "out" })]),
        }),
      ],
    });
    expect(statusOf(r.nextState, "zair")).toBe("CONFIRMED");
  });
});

describe("genuine drops are untouched", () => {
  const cases: Array<[string, string, string, boolean]> = [
    ["Zeeshan OUT", "Zeeshan", "zeeshan", false],
    ["@Match Time Najib is out", "Najib", "najib", true],
    ["@Wasim can't make it", "@Wasim", "wasim", false],
  ];
  for (const [body, ref, key, tagged] of cases) {
    it(`"${body}" drops ${key}`, () => {
      const state = world({ players: PLAYERS, confirmed: [...CONFIRMED, "wasim"] });
      const r = decide({
        now: NOW,
        state,
        messages: [
          msg({
            from: "kemal",
            body,
            tagged,
            route: "other_att",
            facts: attendanceFacts([
              claim({ subject: "other", personRef: ref, personNamed: true, polarity: "out" }),
            ]),
          }),
        ],
      });
      expect(statusOf(r.nextState, key)).toBe("DROPPED");
    });
  }

  it("router rule 15's own example: 'switch it to 7 a side and put Amir in' still registers Amir", () => {
    // `parseSwapNames` reads this as a swap of "it" and "to". Neither is
    // a person, so no claim is a party and Amir's IN is untouched. A
    // message-level refusal would have lost it; that is why the guard is
    // asked per claim.
    const r = run("@Kemal can you switch it to 7 a side and put Amir in as the 14th", [
      claim({ subject: "other", personRef: "Amir", personNamed: true, polarity: "in" }),
    ]);
    expect(statusOf(r.nextState, "amir")).toBe("CONFIRMED");
  });
});
