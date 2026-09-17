/**
 * A group's subject and participants WITHOUT `client.getChatById`.
 *
 * On the live WhatsApp Web build (2026-09-16, whatsapp-web.js 1.34.7)
 * `getChatById` throws the minified `r` from `window.WWebJS.getChatModel`
 * (`groupMetadata.update(chatWid)` and the lid migration inside it), so
 * the self-setup flow reached the server with no group name and no
 * roster (MDs/second-group-readiness-erdal-2026-09-16.md, section 1).
 *
 * The chat model itself is still in the page's collection: `getChat`
 * finds it with `Chat.get(wid)` before it ever calls `getChatModel`
 * (util/Injected/Utils.js:842), and the model already carries
 * `formattedTitle` / `name` and `groupMetadata.participants` (a
 * collection of `{id, isAdmin, isSuperAdmin}`), because the page keeps
 * group metadata for every chat it renders. So this module reads those
 * fields straight off the raw model with one `pupPage.evaluate`, and only
 * falls back to `getChatById` when the page read gives nothing. Every
 * step degrades with a named reason rather than a bare `r`.
 *
 * The page function below is serialised by puppeteer and runs INSIDE the
 * page: it may use only `window.require` and its own argument, never a
 * closure over this module.
 */
import type { Client } from "whatsapp-web.js";

export interface SnapshotParticipant {
  /** E.164 digits without "+", when the id (or its lid → pn mapping) is a phone. */
  phone?: string;
  /** The `@lid` privacy id, when that is all the page has. */
  lidId?: string;
  pushname?: string;
  isAdmin?: boolean;
}

export interface GroupSnapshot {
  subject: string | null;
  participants: SnapshotParticipant[];
  /** Which path produced the result. */
  source: "page" | "getChatById" | "none";
  /** Human-readable reasons for anything that degraded, for the log. */
  notes: string[];
}

/** What the page function returns. Plain data only. */
interface PageResult {
  subject: string | null;
  participants: Array<{ id: string | null; pn: string | null; isAdmin: boolean }>;
  error: string | null;
}

/**
 * Runs in the page. Reads the raw chat model; never calls getChatModel,
 * never calls groupMetadata.update. Returns plain data.
 */
function readGroupInPage(gid: string): PageResult {
  const out: PageResult = { subject: null, participants: [], error: null };
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = (globalThis as any).window;
    const req = w.require as (m: string) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
    let wid: unknown = null;
    try {
      wid = req("WAWebWidFactory").createWid(gid);
    } catch {
      wid = null;
    }
    const collection = req("WAWebCollections").Chat;
    let chat = (wid && collection.get(wid)) || collection.get(gid) || null;
    if (!chat && typeof collection.getModelsArray === "function") {
      chat =
        collection
          .getModelsArray()
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .find((c: any) => c && c.id && c.id._serialized === gid) ?? null;
    }
    if (!chat) {
      out.error = "chat is not in the page's Chat collection";
      return out;
    }
    const gm = chat.groupMetadata;
    out.subject =
      (typeof chat.formattedTitle === "string" && chat.formattedTitle) ||
      (typeof chat.name === "string" && chat.name) ||
      (gm && typeof gm.subject === "string" && gm.subject) ||
      null;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let toPn: ((id: unknown) => any) | null = null;
    try {
      toPn = req("WAWebLidMigrationUtils").toPn ?? null;
    } catch {
      toPn = null;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let parts: any[] = [];
    if (gm && gm.participants) {
      const p = gm.participants;
      if (typeof p.getModelsArray === "function") parts = p.getModelsArray();
      else if (Array.isArray(p._models)) parts = p._models;
      else if (Array.isArray(p)) parts = p;
    }
    for (const p of parts) {
      try {
        const id = p && p.id ? (typeof p.id === "string" ? p.id : p.id._serialized ?? null) : null;
        let pn: string | null = null;
        try {
          const mapped = toPn && p && p.id ? toPn(p.id) : null;
          pn = mapped ? (typeof mapped === "string" ? mapped : mapped._serialized ?? null) : null;
        } catch {
          pn = null;
        }
        out.participants.push({ id, pn, isAdmin: !!(p && (p.isAdmin || p.isSuperAdmin)) });
      } catch {
        /* skip this participant */
      }
    }
    return out;
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e);
    return out;
  }
}

function phoneFromJid(jid: string | null | undefined): string | undefined {
  if (!jid || !jid.endsWith("@c.us")) return undefined;
  const digits = jid.replace("@c.us", "").replace(/\D/g, "");
  return digits.length > 0 ? digits : undefined;
}

/**
 * Read the group's subject and participants, page first, `getChatById`
 * second, and say what happened. Pushnames come from `getContactById`,
 * one guarded call per participant; a throw there loses only the name.
 */
export async function readGroupSnapshot(
  client: Client,
  gid: string,
  selfIds: string[] = [],
): Promise<GroupSnapshot> {
  const notes: string[] = [];
  const self = new Set(selfIds);
  let subject: string | null = null;
  let raw: Array<{ id: string | null; pn: string | null; isAdmin: boolean }> = [];
  let source: GroupSnapshot["source"] = "none";

  // 1. The page's raw chat model.
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const page = (client as any).pupPage as { evaluate: (fn: unknown, arg: string) => Promise<unknown> } | undefined;
    if (!page) throw new Error("client has no page");
    const res = (await page.evaluate(readGroupInPage, gid)) as PageResult | null;
    if (!res) throw new Error("page returned nothing");
    if (res.error) notes.push(`page read: ${res.error}`);
    subject = res.subject ?? null;
    raw = Array.isArray(res.participants) ? res.participants : [];
    if (subject || raw.length > 0) source = "page";
  } catch (err) {
    notes.push(`page read threw: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 2. The library path, only for what the page did not give.
  if (!subject || raw.length === 0) {
    try {
      const chat = await client.getChatById(gid);
      if (!subject && chat?.name) subject = chat.name;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const parts = ((chat as any)?.participants ?? []) as Array<{ id: { _serialized: string }; isAdmin?: boolean }>;
      if (raw.length === 0 && parts.length > 0) {
        raw = parts.map((p) => ({ id: p.id?._serialized ?? null, pn: null, isAdmin: !!p.isAdmin }));
      }
      if (subject || raw.length > 0) source = source === "page" ? "page" : "getChatById";
    } catch (err) {
      notes.push(`getChatById threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 3. Shape the participants for the server, skipping the bot itself.
  const participants: SnapshotParticipant[] = [];
  for (const p of raw) {
    const id = p.id ?? undefined;
    if (!id) continue;
    if (self.has(id) || (p.pn && self.has(p.pn))) continue;
    const entry: SnapshotParticipant = { isAdmin: p.isAdmin };
    const phone = phoneFromJid(p.pn) ?? phoneFromJid(id);
    if (phone) entry.phone = phone;
    if (id.endsWith("@lid")) entry.lidId = id;
    // The pushname: one guarded call. On a broken build every call throws
    // and the roster still imports by phone; names arrive on first message.
    try {
      const contact = await client.getContactById(id);
      const name = contact?.pushname || contact?.name || undefined;
      if (name) entry.pushname = name;
      if (!entry.phone) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const num = (contact as any)?.number;
        if (typeof num === "string" && num.replace(/\D/g, "").length > 0) entry.phone = num.replace(/\D/g, "");
      }
    } catch {
      /* name lost, nothing else */
    }
    participants.push(entry);
  }

  if (source === "none") {
    notes.push(
      "no subject and no participants could be read: the server gets neither, the club name " +
        "falls back to the group's answers and players are provisioned on their first message",
    );
  }
  return { subject, participants, source, notes };
}
