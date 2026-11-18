/**
 * BRINGING A GUEST IN ONE STEP (Kemal, 2026-11-17). An organiser shares a
 * guest's WhatsApp contact card and says "add him for tonight", in HQ, in
 * the players' group or by DM: the guest is added to that game as a GUEST
 * (not a group member), the organiser gets one reply, and the guest gets
 * one welcome DM with the time, the venue with its map link and the fee,
 * and no group link. Then the guest asks MatchTime about the game by DM.
 *
 * Real routes and a real database; the guest reader (kind "guest_card"),
 * the router and the extractor are stubbed ($0). Made-up people and
 * 07700 900xxx numbers.
 */
import { readFileSync, rmSync } from "node:fs";
import { scenario, scenarios, expect, stubbedOnly } from "./pool/fixtures";
import { addDmIntentBodies, addMatchAvailabilityBodies, claim, facts, setExtractorStub, setRouterStub } from "../helpers/stub";
import { E2E } from "../helpers/env";
import type { PoolClub, PoolWorld } from "./pool/world";
import { friendClub } from "./friend-link/world";

/** The scenarios share one database, run in order: each guest is new. */
let seq = 500;
const nextGuestPhone = () => `+447700900${++seq}`;
let GUEST_PHONE = nextGuestPhone();
const card = (name: string, phone: string) =>
  ["BEGIN:VCARD", "VERSION:3.0", `N:;${name};;;`, `FN:${name}`, `TEL;type=CELL;waid=${phone.replace(/^\+/, "")}:${phone}`, "END:VCARD"].join("\n");
let ABU_CARD = card("Abu Ayoub Ftbl", GUEST_PHONE);
scenario.beforeEach(() => {
  GUEST_PHONE = nextGuestPhone();
  ABU_CARD = card("Abu Ayoub Ftbl", GUEST_PHONE);
});

/** What the guest reader says for these words (the model's raw JSON). */
const READ = { add: true, card: true, name: "", typed: [] as Array<{ name: string; phone: string }>, game: 1, game_not_listed: false, also: false, confidence: 0.95 };
const ADD_TONIGHT = READ;
/** Someone typed with a number (no card meant). */
const typedRead = (name: string, phone: string, over: Record<string, unknown> = {}) => ({ ...READ, card: false, typed: [{ name, phone }], ...over });
/** A UK number as an organiser types it ("07700 900507"). */
const local = (e164: string) => `0${e164.slice(3, 7)} ${e164.slice(7)}`;

function armReader(bodies: Record<string, Record<string, unknown>>, attendance: Record<string, Record<string, unknown>> = {}) {
  rmSync(`${E2E.EXTRACTOR_STUB_FILE}.calls`, { force: true });
  rmSync(`${E2E.ROUTER_STUB_FILE}.calls`, { force: true });
  setExtractorStub({ byExtractor: { guest_card: bodies }, bodies: attendance });
}

/** Every guest-reader call the stub saw. */
function readerCalls(): string[] {
  try {
    return readFileSync(`${E2E.EXTRACTOR_STUB_FILE}.calls`, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { label: string; user: string })
      .filter((c) => c.label === "extractor:guest_card")
      .map((c) => c.user);
  } catch {
    return [];
  }
}

/** Every user turn the stubbed router and extractors were shown. */
function modelInputs(): string {
  const read = (f: string) => {
    try {
      return readFileSync(f, "utf8");
    } catch {
      return "";
    }
  };
  return read(`${E2E.ROUTER_STUB_FILE}.calls`) + read(`${E2E.EXTRACTOR_STUB_FILE}.calls`);
}

async function venueWithAddress(pool: PoolWorld, club: PoolClub): Promise<void> {
  const id = `venue-guest-card-${++seq}`;
  await pool.db.run(
    `INSERT INTO "Venue" (id, name, "formattedAddress", lat, lng, "placeId", "createdAt", "updatedAt") VALUES ($1, 'Sim Arena', '12 Sim Road, London E2 8BN', 51.5229, -0.0757, $1, now(), now())`,
    [id],
  );
  await pool.db.run(`UPDATE "Activity" SET "venueId" = $2 WHERE id = $1`, [club.group.activityId, id]);
}

async function guestRow(pool: PoolWorld, matchId: string, phone = GUEST_PHONE) {
  return pool.db.one<{ userId: string; name: string; status: string; guestVia: string | null; guestMatchId: string | null; source: string | null }>(
    `SELECT u.id AS "userId", u.name, a.status, m."guestVia", m."guestMatchId", g.source
       FROM "User" u
       LEFT JOIN "Attendance" a ON a."userId" = u.id AND a."matchId" = $1
       LEFT JOIN "Membership" m ON m."userId" = u.id
       LEFT JOIN "GuestPlace" g ON g."userId" = u.id AND g."matchId" = $1
      WHERE u."phoneNumber" = $2`,
    [matchId, phone],
  );
}

const WELCOME = /^Hi Abu 👋 Oscar has added you to \*[A-Z]+\*'s game\.\n\n📅 \w+ \d+ \w+ at 20:00\n⚽ .+\n📍 Sim Arena\n12 Sim Road, London E2 8BN\n🗺️ https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=51\.5229%2C-0\.0757&query_place_id=venue-guest-card-\d+\n/;

scenarios("an organiser brings a guest by sharing his contact card", () => {
  scenario("(a) in HQ: the card, then '@Match Time add him for tonight': a guest, CONFIRMED, one reply, one welcome DM", async ({ pool }) => {
    stubbedOnly();
    const fnf = await friendClub(pool, "fnf", { hq: true });
    await venueWithAddress(pool, fnf);
    await pool.stranger("abu", { phone: GUEST_PHONE, name: "Abu" });
    armReader({ "@Match Time add him for tonight": ADD_TONIGHT });

    const held = await fnf.hq.say("owner", ABU_CARD, { tagged: false });
    expect(held.json.replyText).toBeNull();
    expect(held.sent).toEqual([]);

    const r = await fnf.hq.say("owner", "add him for tonight", { tag: true });
    expect(r.json.replyText).toMatch(/^✅ Abu Ayoub is in for (tonight|\w{3} \d+ \w{3}), I've sent him the details\.$/);
    pool.expectSent(r.sent, [
      { to: "fnf.hq", channel: "hq", text: r.json.replyText as string },
      { to: "abu", channel: "dm", text: WELCOME },
    ]);
    const welcome = r.sent[1].text;
    expect(welcome).toContain("You're in the squad.\nReply OUT if you can't make it.\nAny question about the game? Just message me here.");
    expect(welcome).not.toMatch(/chat\.whatsapp\.com|invite/i);

    const row = await guestRow(pool, fnf.group.matchId!);
    expect(row).toMatchObject({ name: "Abu Ayoub", status: "CONFIRMED", guestVia: "pool", guestMatchId: fnf.group.matchId, source: "pool" });
    // The HQ log keeps the card's label, never its number.
    const logged = await pool.db.all<{ text: string }>(`SELECT text FROM "AdminGroupMessage" WHERE "orgId" = $1`, [fnf.group.orgId]);
    expect(logged.map((l) => l.text).join("\n")).not.toContain(GUEST_PHONE.slice(3));
    expect(logged.map((l) => l.text)).toContain("[shared a contact card]");
    // The reader saw the card by name only.
    expect(readerCalls().join("\n")).not.toContain(GUEST_PHONE.slice(-6));

    // The same request again: no second welcome DM.
    const again = await fnf.hq.say("owner", "add him for tonight", { tag: true });
    expect(again.sent.filter((m) => m.channel === "dm")).toEqual([]);
  });

  scenario("(d) the guest asks by DM 'what time is it and where?': answered from his game's facts", async ({ pool }) => {
    stubbedOnly();
    const fnf = await friendClub(pool, "fnf", { hq: true });
    await venueWithAddress(pool, fnf);
    const abu = await pool.stranger("abu", { phone: GUEST_PHONE, name: "Abu" });
    armReader({ "@Match Time add him for tonight": ADD_TONIGHT });
    await fnf.hq.say("owner", ABU_CARD, { tagged: false });
    await fnf.hq.say("owner", "add him for tonight", { tag: true });

    addDmIntentBodies({ "what time is it and where?": "question" });
    const r = await abu.dm("what time is it and where?");
    expect(r.json.handled).toBe("dm-qa");
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0].to).toBe("abu");
    // The stubbed answer is the context the model is shown: his game, the
    // kick-off, the venue, its address, the map link, the format and his place.
    const ctx = r.sent[0].text;
    expect(ctx).toContain("[unified-dm-stub]");
    expect(ctx).toContain("THE ASKER IS A GUEST of the club");
    expect(ctx).toMatch(/- When: \w+ \d+ \w+ at 20:00 \(London\)/);
    expect(ctx).toContain("- Venue: Sim Arena, 12 Sim Road, London E2 8BN");
    expect(ctx).toContain("- Map: https://www.google.com/maps/search/");
    expect(ctx).toContain("- His place: in the squad");
    expect(ctx).toMatch(/UPCOMING MATCH: .*Sim Arena/);
    // His own WhatsApp name replaces the phone-book label.
    expect((await guestRow(pool, fnf.group.matchId!))!.name).toBe("Abu");
  });

  scenario("the guest says OUT by DM: his place is given back, he is told, the club is told by name", async ({ pool }) => {
    stubbedOnly();
    const fnf = await friendClub(pool, "fnf", { hq: true });
    const abu = await pool.stranger("abu", { phone: GUEST_PHONE, name: "Abu" });
    armReader({ "@Match Time add him for tonight": ADD_TONIGHT });
    await fnf.hq.say("owner", ABU_CARD, { tagged: false });
    await fnf.hq.say("owner", "add him for tonight", { tag: true });

    addMatchAvailabilityBodies({ "sorry can't make it": "out" });
    const r = await abu.dm("sorry can't make it");
    expect(r.json.handled).toBe("guest-card-out");
    expect((await guestRow(pool, fnf.group.matchId!))!.status).toBe("DROPPED");
    const dm = r.sent.find((m) => m.to === "abu");
    expect(dm?.text).toMatch(/^No problem, I've taken you off \*FNF\*'s game on /);
    const notice = r.sent.find((m) => m.to !== "abu");
    expect(notice?.text).toMatch(/Abu (Ayoub )?\(Oscar's guest\) can't make it on .* any more\. The place is free again\./);
    for (const m of r.sent) expect(m.text).not.toContain(GUEST_PHONE.slice(-6));
  });

  scenario("(b) in the players' group: the card and 'add him for tonight' in one batch", async ({ pool }) => {
    stubbedOnly();
    const fnf = await friendClub(pool, "fnf");
    await venueWithAddress(pool, fnf);
    await pool.stranger("abu", { phone: GUEST_PHONE, name: "Abu" });
    armReader({ "add him for tonight": ADD_TONIGHT });

    const b = await fnf.group.postBatch([
      { player: "owner", body: ABU_CARD },
      { player: "owner", body: "add him for tonight" },
    ]);
    expect(b.results[0].reply).toBeNull();
    expect(b.results[1].reply).toMatch(/^✅ Abu Ayoub is in for (tonight|\w{3} \d+ \w{3}), I've sent him the details\.$/);
    const sent = await pool.collect();
    pool.expectSent(sent, [{ to: "abu", channel: "dm", text: WELCOME }]);
    // Nothing posted in the group but the one reply, and never a number.
    expect(b.groupPosts).toEqual([]);
    expect(b.results.map((x) => x.reply ?? "").join("\n")).not.toContain(GUEST_PHONE.slice(-6));
    expect(await guestRow(pool, fnf.group.matchId!)).toMatchObject({ status: "CONFIRMED", guestVia: "pool" });
    // The card is stored as its label, so no model ever sees its number.
    const stored = await pool.db.one<{ body: string }>(`SELECT body FROM "AnalyzedMessage" WHERE "waMessageId" = $1`, [b.results[0].waMessageId]);
    expect(stored?.body).toBe("[shared a contact card]");
  });

  scenario("(c) a NON-organiser shares a card and says 'add him': nothing is added, the reader is never asked", async ({ pool }) => {
    stubbedOnly();
    const fnf = await friendClub(pool, "fnf");
    await pool.stranger("abu", { phone: GUEST_PHONE, name: "Abu" });
    const him = facts([claim({ subject: "other", personRef: "him", personNamed: false, personKind: "placeholder", polarity: "in" })]);
    armReader({ "add him for tonight": ADD_TONIGHT }, { "add him for tonight": him });
    setRouterStub({ floor: false, bodies: { "add him for tonight": "other_att", [ABU_CARD.trim()]: "none" } });

    const before = await fnf.group.counts();
    const b = await fnf.group.postBatch([
      { player: "shane", body: ABU_CARD },
      { player: "shane", body: "add him for tonight" },
    ]);
    expect(await pool.db.one(`SELECT id FROM "User" WHERE "phoneNumber" = $1`, [GUEST_PHONE])).toBeNull();
    expect(await fnf.group.counts()).toEqual(before);
    expect(readerCalls()).toEqual([]);
    expect(b.dms.filter((d) => d.phone === GUEST_PHONE.replace(/^\+/, ""))).toEqual([]);
    expect(b.results.map((x) => x.reply ?? "").join("\n")).not.toMatch(/Abu Ayoub/);
    // The card itself never reached the router: it left the batch as noise.
    expect(b.results[0]).toMatchObject({ intent: "noise", reply: null });
    expect(modelInputs()).not.toContain(GUEST_PHONE.slice(-6));
  });

  scenario("(e) a full game: the guest goes on the bench and the reply says so", async ({ pool }) => {
    stubbedOnly();
    const fnf = await friendClub(pool, "fnf", { hq: true, maxPlayers: 2, confirmed: ["owner", "dan"] });
    await pool.stranger("abu", { phone: GUEST_PHONE, name: "Abu" });
    armReader({ "@Match Time add him for tonight": ADD_TONIGHT });
    await fnf.hq.say("owner", ABU_CARD, { tagged: false });
    const r = await fnf.hq.say("owner", "add him for tonight", { tag: true });
    expect(r.json.replyText).toMatch(/^✅ Abu Ayoub is on the bench for (tonight|\w{3} \d+ \w{3}), the squad is full\. I've sent him the details\.$/);
    expect(await guestRow(pool, fnf.group.matchId!)).toMatchObject({ status: "BENCH", guestVia: "pool" });
    const dm = r.sent.find((m) => m.to === "abu");
    expect(dm?.text).toContain("The squad is full, so you're on the bench for now. If a place opens I'll tell you.");
    expect(await fnf.group.counts()).toMatchObject({ confirmed: 2, bench: 1 });
  });

  scenario("by DM: the organiser sends the card, then 'he's playing tonight'; the reply comes back by DM", async ({ pool }) => {
    stubbedOnly();
    const fnf = await friendClub(pool, "fnf");
    await pool.stranger("abu", { phone: GUEST_PHONE, name: "Abu" });
    armReader({ "he's playing tonight": ADD_TONIGHT });
    const owner = fnf.member("owner");
    const held = await owner.dm(ABU_CARD);
    expect(held.json.handled).toBe("guest-card-held");
    expect(held.sent).toEqual([]);
    const r = await owner.dm("he's playing tonight");
    expect(r.json.handled).toBe("guest-card-added");
    pool.expectSent(r.sent, [
      { to: "abu", channel: "dm", text: /^Hi Abu 👋 Oscar has added you to \*FNF\*'s game\./ },
      { to: "fnf.owner", channel: "dm", text: /^✅ Abu Ayoub is in for / },
    ]);
  });

  scenario("a typed name and number in HQ, no card: added under the name he wrote", async ({ pool }) => {
    stubbedOnly();
    const fnf = await friendClub(pool, "fnf", { hq: true });
    await pool.stranger("sami", { phone: GUEST_PHONE, name: "Sami" });
    const words = `@Match Time Sami Kaya ${local(GUEST_PHONE)} is playing tonight`;
    armReader({ [words]: typedRead("Sami Kaya", local(GUEST_PHONE), { confidence: 0.9 }) });
    const r = await fnf.hq.say("owner", words, { tagged: true });
    expect(r.json.replyText).toMatch(/^✅ Sami Kaya is in for /);
    expect(await guestRow(pool, fnf.group.matchId!)).toMatchObject({ name: "Sami Kaya", status: "CONFIRMED" });
    expect(r.json.replyText as string).not.toContain(GUEST_PHONE.slice(-6));
  });

  scenario("a number that belongs to someone else on MatchTime is never attached", async ({ pool }) => {
    stubbedOnly();
    const fnf = await friendClub(pool, "fnf", { hq: true });
    const other = await friendClub(pool, "other");
    const theirs = other.member("pete").phone;
    armReader({ "@Match Time add him for tonight": ADD_TONIGHT });
    await fnf.hq.say("owner", card("Pete", theirs), { tagged: false });
    const r = await fnf.hq.say("owner", "add him for tonight", { tag: true });
    expect(r.json.replyText).toBe("That number is already on MatchTime, so it can't be added here.");
    const att = await pool.db.one(`SELECT a.id FROM "Attendance" a JOIN "User" u ON u.id = a."userId" WHERE u."phoneNumber" = $1 AND a."matchId" = $2`, [theirs, fnf.group.matchId]);
    expect(att).toBeNull();
    expect(r.sent.filter((m) => m.channel === "dm")).toEqual([]);
  });

  scenario("quiet hours: the welcome DM waits for the morning", async ({ pool }) => {
    stubbedOnly();
    const fnf = await friendClub(pool, "fnf", { hq: true });
    await pool.db.run(`UPDATE "Organisation" SET "quietHoursEnabled" = true, "quietHoursFrom" = '23:00', "quietHoursTo" = '09:00' WHERE id = $1`, [fnf.group.orgId]);
    await pool.stranger("abu", { phone: GUEST_PHONE, name: "Abu" });
    armReader({ "@Match Time add him on Thursday": { ...ADD_TONIGHT, game: 1 } });
    // 23:30 London on the day before the game (the game is two days out at 20:00).
    const late = new Date(Date.now() + 24 * 3600_000);
    late.setUTCHours(23, 30, 0, 0);
    await fnf.hq.say("owner", ABU_CARD, { tagged: false, now: late });
    const r = await fnf.hq.say("owner", "add him on Thursday", { tag: true, now: late });
    const dm = r.sent.find((m) => m.to === "abu");
    expect(dm?.sendAfter).not.toBeNull();
    expect(dm!.sendAfter!.getTime()).toBeGreaterThan(late.getTime());
  });

  // ── The review of #621 ───────────────────────────────────────────────

  scenario("a typed number beside a held card adds the TYPED person; the card's person is untouched", async ({ pool }) => {
    stubbedOnly();
    const fnf = await friendClub(pool, "fnf", { hq: true });
    const abuPhone = GUEST_PHONE;
    const samiPhone = nextGuestPhone();
    await pool.stranger("abu", { phone: abuPhone, name: "Abu" });
    await pool.stranger("sami", { phone: samiPhone, name: "Sami" });
    const words = `@Match Time Sami ${local(samiPhone)} is playing tonight`;
    armReader({ [words]: typedRead("Sami", local(samiPhone)) });
    await fnf.hq.say("owner", ABU_CARD, { tagged: false });
    const r = await fnf.hq.say("owner", words, { tagged: true });
    expect(r.json.replyText).toMatch(/^✅ Sami is in for /);
    expect(await guestRow(pool, fnf.group.matchId!, samiPhone)).toMatchObject({ name: "Sami", status: "CONFIRMED" });
    expect(await pool.db.one(`SELECT id FROM "User" WHERE "phoneNumber" = $1`, [abuPhone])).toBeNull();
    expect(r.sent.filter((m) => m.channel === "dm").map((m) => m.to)).toEqual(["sami"]);
  });

  scenario("privacy: no card's number in any stored text or model input, organiser's or not", async ({ pool }) => {
    stubbedOnly();
    const fnf = await friendClub(pool, "fnf", { hq: true });
    const theirs = nextGuestPhone();
    await pool.stranger("abu", { phone: GUEST_PHONE, name: "Abu" });
    armReader({ "add him for tonight": ADD_TONIGHT, "@Match Time add him for tonight": ADD_TONIGHT });
    setRouterStub({ floor: false, bodies: { "hello all": "none" } });
    // The players' group: an organiser's card and a player's card, in one batch with chat.
    await fnf.group.postBatch(
      [
        { player: "owner", body: ABU_CARD },
        { player: "shane", body: card("Mo Stranger", theirs) },
        { player: "dan", body: "hello all", quote: { of: 1 } },
        { player: "owner", body: "add him for tonight" },
      ],
      { history: [{ authorName: "Shane Smith", body: card("Old Card", nextGuestPhone()) }] },
    );
    // HQ and a DM, a card each.
    await fnf.hq.say("alice", card("Hq Card", theirs), { tagged: false });
    await fnf.member("pete").dm(card("Dm Card", theirs));
    await fnf.member("owner").dm(card("Dm Organiser Card", theirs));
    const numbers = [GUEST_PHONE, theirs].map((p) => p.slice(-6));
    const texts = [
      ...(await pool.db.all<{ t: string }>(`SELECT coalesce(body, '') AS t FROM "AnalyzedMessage"`)),
      ...(await pool.db.all<{ t: string }>(`SELECT coalesce(body, '') AS t FROM "GroupMessage"`)),
      ...(await pool.db.all<{ t: string }>(`SELECT text AS t FROM "AdminGroupMessage"`)),
      ...(await pool.db.all<{ t: string }>(`SELECT coalesce(text, '') AS t FROM "SentNotification" WHERE kind <> 'guest-card-held'`)),
    ]
      .map((r) => r.t)
      .join("\n");
    for (const n of numbers) {
      expect(texts, "stored text").not.toContain(n);
      expect(modelInputs(), "model input").not.toContain(n);
    }
    // The organiser's card was still read for his request.
    expect(await guestRow(pool, fnf.group.matchId!)).toMatchObject({ status: "CONFIRMED" });
  });

  scenario("'IN, and Dave ... is playing tonight': both done, one reply", async ({ pool }) => {
    stubbedOnly();
    const fnf = await friendClub(pool, "fnf", { confirmed: ["dan"] });
    await pool.stranger("dave", { phone: GUEST_PHONE, name: "Dave" });
    const words = `IN, and Dave ${local(GUEST_PHONE)} is playing tonight`;
    armReader({ [words]: typedRead("Dave", local(GUEST_PHONE), { also: true }) }, { [words]: facts([claim({ subject: "sender", personRef: "IN", polarity: "in" })]) });
    setRouterStub({ floor: false, bodies: { [words]: "self_att" } });
    const b = await fnf.group.postBatch([{ player: "owner", body: words }]);
    expect((await fnf.group.attendanceOf("owner"))?.status).toBe("CONFIRMED");
    expect(await guestRow(pool, fnf.group.matchId!)).toMatchObject({ name: "Dave", status: "CONFIRMED", guestVia: "pool" });
    expect(b.results).toHaveLength(1);
    expect(b.results[0].reply).toMatch(/✅ Dave is in for /);
  });

  scenario("a day that is not on the list is asked, never guessed; the card stays for the answer", async ({ pool }) => {
    stubbedOnly();
    const fnf = await friendClub(pool, "fnf", { hq: true });
    await pool.stranger("abu", { phone: GUEST_PHONE, name: "Abu" });
    armReader({
      "@Match Time add him for Sunday": { ...ADD_TONIGHT, game: 0, game_not_listed: true },
      "@Match Time the next one then": ADD_TONIGHT,
    });
    await fnf.hq.say("owner", ABU_CARD, { tagged: false });
    const r = await fnf.hq.say("owner", "add him for Sunday", { tag: true });
    expect(r.json.replyText).toMatch(/^Which game is he for\? The coming games are .+\. Tell me the day, for example \*add him for .+\*\.$/);
    expect(await pool.db.one(`SELECT id FROM "User" WHERE "phoneNumber" = $1`, [GUEST_PHONE])).toBeNull();
    const again = await fnf.hq.say("owner", "the next one then", { tag: true });
    expect(again.json.replyText).toMatch(/^✅ Abu Ayoub is in for /);
  });

  scenario("a nameless card: 'who is this?' then 'add Sam Jones for tonight' uses the held card", async ({ pool }) => {
    stubbedOnly();
    const fnf = await friendClub(pool, "fnf", { hq: true });
    await pool.stranger("sam", { phone: GUEST_PHONE, name: "Sam" });
    const nameless = ["BEGIN:VCARD", "VERSION:3.0", `TEL;type=CELL;waid=${GUEST_PHONE.replace(/^\+/, "")}:${GUEST_PHONE}`, "END:VCARD"].join("\n");
    armReader({
      "@Match Time add him": ADD_TONIGHT,
      "@Match Time add Sam Jones for tonight": { ...ADD_TONIGHT, name: "Sam Jones" },
    });
    await fnf.hq.say("owner", nameless, { tagged: false });
    const first = await fnf.hq.say("owner", "add him", { tag: true });
    expect(first.json.replyText).toBe("What's his name? Tell me and I'll add him, for example *add Sam Jones for tonight*.");
    const r = await fnf.hq.say("owner", "add Sam Jones for tonight", { tag: true });
    expect(r.json.replyText).toMatch(/^✅ Sam Jones is in for /);
    expect(await guestRow(pool, fnf.group.matchId!)).toMatchObject({ name: "Sam Jones", status: "CONFIRMED" });
  });

  scenario("a Turkish club: a local Turkish mobile is read as +90", async ({ pool }) => {
    stubbedOnly();
    const fnf = await friendClub(pool, "fnf", { hq: true });
    await pool.db.run(`UPDATE "Organisation" SET language = 'tr' WHERE id = $1`, [fnf.group.orgId]);
    const tr = `+90532${String(++seq).padStart(7, "0")}`;
    const typed = `0${tr.slice(3, 6)} ${tr.slice(6, 9)} ${tr.slice(9, 11)} ${tr.slice(11)}`;
    await pool.stranger("ali", { phone: tr, name: "Ali" });
    const words = `@Match Time Ali ${typed} bu akşam oynuyor`;
    armReader({ [words]: typedRead("Ali", typed) });
    const r = await fnf.hq.say("owner", words, { tagged: true });
    expect(r.json.replyText).toMatch(/^✅ Ali bu akşamki maça eklendi|^✅ Ali .+ maçına eklendi/);
    expect(await guestRow(pool, fnf.group.matchId!, tr)).toMatchObject({ name: "Ali", status: "CONFIRMED" });
  });

  scenario("a number with no country to read: asked for the code, nobody added", async ({ pool }) => {
    stubbedOnly();
    const fnf = await friendClub(pool, "fnf", { hq: true });
    const words = "@Match Time Ali 0532 999 88 77 is playing tonight";
    armReader({ [words]: typedRead("Ali", "0532 999 88 77") });
    const r = await fnf.hq.say("owner", words, { tagged: true });
    expect(r.json.replyText).toBe("I couldn't read that number. Please send it with the country code, starting with +.");
  });

  scenario("another club's member (a past partner guest here) is never made this club's guest", async ({ pool }) => {
    stubbedOnly();
    const fnf = await friendClub(pool, "fnf", { hq: true });
    const other = await friendClub(pool, "other");
    const pete = other.group.player("pete");
    await pool.db.run(
      `INSERT INTO "Membership" (id, "userId", "orgId", role, "guestVia", "guestFromOrgId", "guestMatchId", "leftAt") VALUES ($1, $2, $3, 'PLAYER', 'partner', $4, $5, now())`,
      [`mem-partner-${++seq}`, pete.userId, fnf.group.orgId, other.group.orgId, fnf.group.matchId],
    );
    armReader({ "@Match Time add him for tonight": ADD_TONIGHT });
    await fnf.hq.say("owner", card("Pete", pete.phone!), { tagged: false });
    const r = await fnf.hq.say("owner", "add him for tonight", { tag: true });
    expect(r.json.replyText).toBe("That number is already on MatchTime, so it can't be added here.");
    const mem = await pool.db.one<{ guestVia: string }>(`SELECT "guestVia" FROM "Membership" WHERE "userId" = $1 AND "orgId" = $2`, [pete.userId, fnf.group.orgId]);
    expect(mem?.guestVia).toBe("partner");
  });

  scenario("two typed guests in one message: both added", async ({ pool }) => {
    stubbedOnly();
    const fnf = await friendClub(pool, "fnf", { hq: true });
    const a = GUEST_PHONE;
    const b = nextGuestPhone();
    await pool.stranger("abu", { phone: a, name: "Abu" });
    await pool.stranger("can", { phone: b, name: "Can" });
    const words = `@Match Time Abu ${local(a)} and Can ${local(b)} are in tonight`;
    armReader({ [words]: { ...READ, card: false, typed: [{ name: "Abu", phone: local(a) }, { name: "Can", phone: local(b) }] } });
    const r = await fnf.hq.say("owner", words, { tagged: true });
    expect(r.json.replyText).toMatch(/^✅ Abu is in for .+\n✅ Can is in for /);
    expect(await guestRow(pool, fnf.group.matchId!, a)).toMatchObject({ status: "CONFIRMED" });
    expect(await guestRow(pool, fnf.group.matchId!, b)).toMatchObject({ status: "CONFIRMED" });
  });

  scenario("a guest's DM answer sees his game only: no member list, no stats, no results", async ({ pool }) => {
    stubbedOnly();
    const fnf = await friendClub(pool, "fnf", { hq: true });
    const abu = await pool.stranger("abu", { phone: GUEST_PHONE, name: "Abu" });
    armReader({ "@Match Time add him for tonight": ADD_TONIGHT });
    await fnf.hq.say("owner", ABU_CARD, { tagged: false });
    await fnf.hq.say("owner", "add him for tonight", { tag: true });
    addDmIntentBodies({ "who else is playing?": "question" });
    // A guest is answered by the unified step, cut down to his game.
    const r = await abu.dm("who else is playing?");
    const ctx = r.sent[0].text;
    expect(ctx).toContain("[unified-dm-stub]");
    expect(ctx).toContain("THE ASKER IS A GUEST");
    expect(ctx).toContain("Oscar Owner");
    expect(ctx).not.toContain("Pete Power");
    expect(ctx).not.toContain("Shane Smith");
  });
});
