/**
 * REVIEW OF #574, PINNED IN THE SOURCE: where names are NOT matched in code
 * any more, and where the model is NOT asked.
 *
 *  - The monthly list's line lookup (`entryResolver`) reads only the
 *    reader's member ref: an exact member name with no ref is nobody.
 *  - Mentions: the free phone pass runs before the dedupe; the model pass
 *    (who-is-who) only after the dedupe and the no-features return.
 *  - Participant sync attaches no phone by a match of names.
 *  - Provisioning never looks a name up again.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { entryResolver } from "../month-signup-rules";

const ROOT = path.resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");

describe("the monthly list: the reader's refs are the only authority (finding 5)", () => {
  const roster = [{ userId: "u-will", name: "Will Smith", aliases: ["willy"] }];
  const resolve = entryResolver(roster, new Set(["u-will"]));
  const e = (name: string, memberId?: string) => ({
    slot: 1,
    raw: name,
    name,
    marks: { paid: false, paidAmountPence: null, tier: null, payg: false, paygDates: [] },
    ...(memberId !== undefined ? { facts: { memberId, guest: false, hostUserId: null, games: null, newbie: false } } : {}),
  });
  it("RED on main: a member's exact name, an alias or a leading name with no reader ref is nobody", () => {
    expect(resolve(e("Will Smith"))).toEqual({ kind: "none" });
    expect(resolve(e("willy"))).toEqual({ kind: "none" });
    expect(resolve(e("Will"))).toEqual({ kind: "none" });
  });
  it("the reader's ref is that member", () => {
    expect(resolve(e("W", "u-will"))).toEqual({ kind: "one", userId: "u-will" });
  });
});

describe("the analyze route: mentions are named by the model only after the dedupe (minor)", () => {
  const route = read("src/app/api/whatsapp/analyze/route.ts");
  it("the first pass asks no model; the model pass comes after the dedupe and the no-features return", () => {
    const free = route.indexOf("nameMentionsFromRoster(org.id, body.messages, { askModel: false })");
    const noFeatures = route.indexOf('ignored: "no-message-driven-features"');
    const dedupe = route.indexOf("const fresh: InboundMessage[] = [];");
    const model = route.indexOf("nameMentionsFromRoster(org.id, fresh, { askModel: true })");
    expect(free).toBeGreaterThan(0);
    expect(noFeatures).toBeGreaterThan(free);
    expect(dedupe).toBeGreaterThan(noFeatures);
    expect(model).toBeGreaterThan(dedupe);
  });
  // Round 3: the squad-from-list archive is the squad extraction's only
  // text, so its mentions are named (model pass included) BEFORE it is
  // stored, and the later pass then asks nothing again.
  it("the squad-from-list archive stores names, not raw @digits, and the batch asks once", () => {
    const branch = route.indexOf("if (f.squadFromList) {");
    const asked = route.indexOf("body.messages = await nameMentionsFromRoster(org.id, body.messages, { askModel: true });", branch);
    const store = route.indexOf("await storeMessagesForSquadFromList(org.id, body.groupId, body.messages);", branch);
    expect(branch).toBeGreaterThan(0);
    expect(asked).toBeGreaterThan(branch);
    expect(store).toBeGreaterThan(asked);
    expect(route).toContain("if (!mentionsAsked) fresh.splice(");
  });

  it("phoneless senders go to who-is-who in one batch call (finding 4)", () => {
    expect(route).toContain("resolveSenders(");
    expect(route).not.toMatch(/await resolveSender\(org\.id, m\)/);
  });
});

describe("no name lookups left on these paths", () => {
  it("participant sync attaches no phone by a match of names (finding 7)", () => {
    const src = read("src/lib/participant-sync.ts");
    expect(src).not.toContain("findExistingOrgMember");
    expect(src).not.toContain("adoptPhoneIfUnset(");
  });
  it("provisioning reads no membership and asks no model (finding 1)", () => {
    const src = read("src/lib/resolve-or-provision-name.ts");
    expect(src).not.toMatch(/membership\.findMany|personPickerFor|startsWith/);
  });
  it("the swap matches no names by spelling (finding 6)", () => {
    const src = read("src/lib/team-slot-swap.ts");
    expect(src).not.toMatch(/function nameMatches|isExactly|first\.startsWith/);
  });
  it("the sender resolver matches no names by spelling (finding 4)", () => {
    const src = read("src/lib/resolve-sender.ts");
    expect(src).not.toMatch(/firstNameMatches|equalsMatches|dbFirst\.startsWith/);
  });
});
