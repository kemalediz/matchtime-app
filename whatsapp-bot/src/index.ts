import pkg from "whatsapp-web.js";
const { Client, LocalAuth } = pkg;
import qrcode from "qrcode-terminal";
import { setMonitoredGroups, isMonitoredGroup, addMonitoredGroup } from "./handlers.js";
import { initScheduler, stopScheduler } from "./scheduler.js";
import {
  getEnabledOrgs,
  postReaction,
  postPollVote,
  postGroupJoin,
  postGroupLeave,
  postDmReply,
  postSyncParticipants,
  postBotAdded,
} from "./api.js";
import {
  enqueueForAnalysis,
  recordHistory,
  recoverGroupMessages,
  startBatchFlushTimer,
  stopBatchFlushTimer,
} from "./smart-analysis.js";
import { config } from "./config.js";
import { resolveWaMessageId } from "./message-id.js";
import { acquireInstanceLock } from "./instance-lock.js";
import {
  resolveWebVersionOptions,
  describeWebVersionOptions,
  warnIfPinUnreachable,
} from "./web-version.js";
import {
  resolvePairingOptions,
  describePairingOptions,
  formatPairingCodeBanner,
} from "./pair-phone.js";

/**
 * Retry an async call a few times with a fixed delay. Used for the ONE
 * startup call whose failure silently disables the whole bot (org config).
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  attempts: number,
  delayMs: number,
  label: string,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      console.error(
        `[startup] ${label} attempt ${i}/${attempts} failed:`,
        err instanceof Error ? err.message : err,
      );
      if (i < attempts) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

async function main() {
  console.log("MatchTime WhatsApp Bot starting...");

  // ── Single-instance guard (2026-07-19 duplicate-send incident) ──────
  // Several bot processes were alive on the Pi at once (orphans left
  // outside systemd's cgroup by repeated `systemctl restart`), all
  // logged into the same WhatsApp account, all polling due-posts — so
  // one due instruction became 30+ group messages. Refuse to be the
  // second instance. Exit code is 0 under systemd on purpose: the unit
  // has Restart=on-failure, and a non-zero exit here would produce an
  // endless crash-restart loop. See instance-lock.ts.
  const lock = acquireInstanceLock();
  if (!lock.acquired) {
    console.error(
      `CRITICAL: another MatchTime bot instance is already running (pid ${lock.holderPid}). ` +
        `Refusing to start a second one — duplicate instances cause duplicate WhatsApp sends. ` +
        `Use scripts/deploy-pi.sh to restart cleanly; never bare 'systemctl restart'.`,
    );
    process.exit(lock.exitCode);
  }

  console.log(`API URL: ${config.apiUrl}`);

  // WhatsApp Web version pinning — see src/web-version.ts. Resolves to {}
  // when the WA_WEB_VERSION* env vars are unset, so the client is built
  // exactly as before unless someone opts in on the Pi. This is the escape
  // hatch for the next time WhatsApp ships a frontend change that breaks
  // whatsapp-web.js's injected code: pin a known-good build in
  // ~/matchtime-bot/.env and redeploy, no code change needed.
  const webVersionOptions = resolveWebVersionOptions(process.env);
  console.log(describeWebVersionOptions(webVersionOptions));
  // Warn-only: a pin to a build the archive doesn't have is ignored SILENTLY
  // by whatsapp-web.js, which would look identical to a working pin.
  // Fire-and-forget so a slow GitHub can't delay startup.
  void warnIfPinUnreachable(webVersionOptions);

  // Mobile-friendly login — see src/pair-phone.ts. Resolves to {} when
  // WA_PAIR_PHONE is unset, so the client is built exactly as before and the
  // QR flow is untouched. When it IS set, whatsapp-web.js asks WhatsApp for
  // an 8-character pairing code instead, which can be typed into the burner
  // phone with no second screen — the QR needed a terminal AND the phone,
  // which repeatedly left the bot logged out and the product dead.
  //
  // Note the library treats QR and pairing code as mutually exclusive
  // (Client.js:161), so no QR is printed while WA_PAIR_PHONE is set. Unset it
  // and redeploy to get the QR route back.
  const pairing = resolvePairingOptions(process.env);
  if (pairing.criticalLog) console.error(pairing.criticalLog);
  console.log(describePairingOptions(pairing));

  const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
      headless: true,
      executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    },
    ...webVersionOptions,
    ...pairing.clientOptions,
  });

  // Still registered unconditionally: harmless when pairing is on (the
  // library simply never emits 'qr' in that mode) and the sole auth path
  // when it is off.
  client.on("qr", (qr: string) => {
    console.log("\nScan this QR code with WhatsApp on the burner phone:\n");
    qrcode.generate(qr, { small: true });
  });

  // whatsapp-web.js emits 'code' each time a pairing code is generated —
  // once immediately and again on every refresh, so a lapsed code is
  // replaced without anyone touching the Pi.
  client.on("code", (code: string) => {
    console.log(formatPairingCodeBanner(code, pairing.intervalMs));
  });

  client.on("ready", async () => {
    console.log("\nWhatsApp bot is ready!");

    try {
      const chats = await client.getChats();
      const groups = chats.filter((c) => c.isGroup);
      console.log(`\n=== Groups this account is a member of (${groups.length}) ===`);
      groups.forEach((g) => {
        console.log(`  ${g.id._serialized}   "${g.name}"`);
      });
      console.log(`=== end groups ===\n`);
    } catch (err) {
      // Non-fatal: this block is a startup diagnostic only. But it is also
      // the CANARY for whatsapp-web.js's injected page code being out of
      // step with the live WhatsApp Web build (2026-08-28: this threw the
      // minified `r: r` while every contact/chat lookup on the inbound path
      // died the same way). Say so loudly rather than logging a bare error.
      console.error(
        "Failed to enumerate groups:",
        err instanceof Error ? err.message : err,
      );
      console.error(
        "CRITICAL: client.getChats() failed. whatsapp-web.js's injected page " +
          "code is probably out of step with the live WhatsApp Web build. " +
          "Group posting may still work, but contact/chat lookups will not. " +
          "Mitigation: pin a known-good build with WA_WEB_VERSION in " +
          "~/matchtime-bot/.env, or upgrade whatsapp-web.js. " +
          "See MDs/whatsapp-web-version-pinning.md.",
      );
    }

    try {
      // Retry: everything below (scheduler, batch-flush timer, catch-up)
      // only ever starts here. A single transient failure used to leave the
      // bot connected to WhatsApp but permanently deaf and mute — no polling,
      // no analysis — until someone noticed and restarted it.
      const data = await withRetry(getEnabledOrgs, 3, 5_000, "getEnabledOrgs");
      const orgConfigs = (data.orgs || [])
        .filter((o: { whatsappGroupId: string | null }) => o.whatsappGroupId)
        .map((o: { whatsappGroupId: string; name: string }) => ({
          groupId: o.whatsappGroupId,
          orgName: o.name,
        }));

      // Phase 2: groups mid-onboarding have no bot-enabled org yet but
      // must stay monitored so a restart doesn't stall an in-progress
      // setup.
      const onboardingGroups: string[] = Array.isArray(data.onboardingGroups)
        ? data.onboardingGroups
        : [];
      setMonitoredGroups([
        ...orgConfigs.map((o: { groupId: string }) => o.groupId),
        ...onboardingGroups,
      ]);
      if (onboardingGroups.length)
        console.log(`Also monitoring ${onboardingGroups.length} onboarding group(s)`);

      console.log(`Monitoring ${orgConfigs.length} group(s):`);
      orgConfigs.forEach((o: { orgName: string; groupId: string }) =>
        console.log(`  - ${o.orgName} (${o.groupId})`),
      );

      initScheduler(client, orgConfigs);

      // Start the batch-flush timer. Every inbound group message is
      // buffered in-memory and flushed every 10 min (or immediately
      // when the next match is within an hour of kickoff), at which
      // point the server-side analyser classifies the batch and the
      // bot executes the returned reacts/replies.
      startBatchFlushTimer(
        client,
        orgConfigs.map((o: { groupId: string }) => o.groupId),
      );

      // Catch-up on reconnect: whatsapp-web.js silently DROPS messages
      // that arrive while the socket is down (during a deploy/restart).
      // Re-feed the last ~2h of each monitored group's messages into the
      // analyser — the server dedupes on waMessageId, so only genuinely
      // missed messages reach the LLM. Fixes the gap that lost Ibrahim's
      // "in" during a restart (Kemal 2026-06-06). Fire-and-forget; the
      // re-queued messages get classified by the startup flush above.
      recoverGroupMessages(
        client,
        orgConfigs.map((o: { groupId: string }) => o.groupId),
      ).catch((err) => console.error("[recover-group] sweep failed:", err));

      // Backfill the "lurker gap": members who were in the WhatsApp
      // group before the bot joined, who haven't typed since (so
      // group_join + auto-provision never fired). Fire-and-forget on
      // every startup; idempotent on the server side. Ignores @lid
      // privacy participants — they're picked up by pushname-based
      // resolution the moment they message.
      for (const o of orgConfigs as { groupId: string; orgName: string }[]) {
        try {
          const chat = await client.getChatById(o.groupId);
          // wweb.js types — GroupChat has participants[]; non-group
          // chats don't.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const participants = (chat as any).participants ?? [];
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const selfId = client.info?.wid?._serialized;
          const out: Array<{ phone?: string; lidId?: string; pushname?: string }> = [];
          for (const p of participants as Array<{ id: { _serialized: string } }>) {
            const id = p.id._serialized;
            if (selfId && id === selfId) continue; // skip the bot itself
            let phone: string | undefined;
            let lidId: string | undefined;
            if (id.endsWith("@c.us")) {
              phone = id.replace("@c.us", "").replace(/^\+/, "");
            } else if (id.endsWith("@lid")) {
              lidId = id;
              // wweb.js sometimes resolves the underlying phone via
              // getContactById; try once, swallow any failure.
              try {
                const contact = await client.getContactById(id);
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const num = (contact as any).number;
                if (typeof num === "string" && num.length > 0) phone = num;
              } catch {
                /* ignore — server falls back to lurker-skipped */
              }
            }
            let pushname: string | undefined;
            try {
              const contact = await client.getContactById(id);
              pushname = contact.pushname || contact.name || undefined;
            } catch {
              /* non-fatal */
            }
            out.push({ phone, lidId, pushname });
          }
          const result = await postSyncParticipants({
            groupId: o.groupId,
            participants: out,
          });
          if (result) {
            console.log(
              `[sync-participants] ${o.orgName}: ${result.added ?? 0} added, ${result.alreadyKnown ?? 0} known, ${result.skippedNoPhone ?? 0} no-phone, ${result.restoredMembership ?? 0} restored, total=${result.total ?? 0}`,
            );
          }
        } catch (err) {
          console.error(
            `[sync-participants] ${o.orgName} failed:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    } catch (err) {
      console.error(
        "CRITICAL: failed to fetch org configs after retries — the scheduler " +
          "and the batch-flush timer did NOT start, so nothing will be posted " +
          "and no inbound message will be analysed. Restart the bot with " +
          "scripts/deploy-pi.sh once the API is reachable. Cause:",
        err,
      );
    }

    // One-shot recovery: if BOT_RECOVER_DM_REPLIES=1, walk every
    // non-group chat, pick up the most recent inbound text message
    // from the last 48h, and replay it through the dm-reply pipe.
    // Uses chat.lastMessage (already cached on the chat object) so
    // we don't have to fetch history per chat — fetchMessages() was
    // failing with whatsapp-web.js "waitForChatLoading" errors for
    // chats not yet opened in the headless WA Web session.
    // Idempotent: dm-reply is upsert-by-(survey, user).
    if (process.env.BOT_RECOVER_DM_REPLIES === "1") {
      try {
        console.log("[recover] BOT_RECOVER_DM_REPLIES=1 — replaying recent DM replies");
        const allChats = await client.getChats();
        const dms = allChats.filter((c) => !c.isGroup);
        const cutoffSec = Math.floor(Date.now() / 1000) - 48 * 60 * 60;
        let replayed = 0;
        let skippedNoLast = 0;
        let skippedFromMe = 0;
        let skippedOldOrEmpty = 0;
        let errored = 0;
        for (const chat of dms) {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const lm = (chat as any).lastMessage;
            if (!lm) {
              skippedNoLast += 1;
              continue;
            }
            if (lm.fromMe) {
              skippedFromMe += 1;
              continue;
            }
            if ((lm.timestamp ?? 0) < cutoffSec) {
              skippedOldOrEmpty += 1;
              continue;
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const dataBody = (lm as any)._data?.body;
            const text = (
              typeof lm.body === "string" && lm.body.length > 0
                ? lm.body
                : typeof dataBody === "string"
                  ? dataBody
                  : ""
            ).trim();
            if (text.length === 0) {
              skippedOldOrEmpty += 1;
              continue;
            }

            const fromId = (lm.from as string | undefined) ?? "";
            let phone = "";
            if (fromId.endsWith("@c.us")) {
              phone = fromId.replace("@c.us", "").replace(/^\+/, "");
            }
            let authorName: string | undefined;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const rawNotify = (lm as any)._data?.notifyName;
            if (typeof rawNotify === "string" && rawNotify.trim()) {
              authorName = rawNotify.trim();
            } else if (chat.name && chat.name.trim()) {
              authorName = chat.name.trim();
            }

            await postDmReply({
              phone,
              authorName,
              body: text,
              waMessageId: lm.id?._serialized ?? "",
            });
            replayed += 1;
            console.log(
              `[recover] replayed from=${fromId} authorName=${authorName ?? "?"} text=${JSON.stringify(text.slice(0, 50))}`,
            );
            await new Promise((r) => setTimeout(r, 250));
          } catch (innerErr) {
            errored += 1;
            console.error(
              "[recover] chat replay failed for",
              chat.id?._serialized,
              innerErr instanceof Error ? innerErr.message : innerErr,
            );
          }
        }
        console.log(
          `[recover] done: replayed=${replayed} noLast=${skippedNoLast} fromMe=${skippedFromMe} oldOrEmpty=${skippedOldOrEmpty} errored=${errored}`,
        );
      } catch (err) {
        console.error(
          "[recover] failed:",
          err instanceof Error ? err.message : err,
        );
      }
    }
  });

  // Inbound group messages. EVERY message goes to the smart-analysis
  // pipeline — no regex fast-path. Claude sees the batch every 10 min
  // (or sooner if kickoff is within an hour) and decides intent:
  // IN / OUT / score / replacement_request / conditional_in / question
  // / noise / unclear. The server executes side effects (attendance,
  // scoring, Elo, replies) and hands back the WhatsApp-side actions
  // (react, reply) for the bot to perform.
  client.on("message", async (msg) => {
    try {
      // whatsapp-web.js gotcha: for messages from chats the bot
      // hasn't fully synced yet, msg.body is sometimes empty but the
      // raw payload still carries the text in msg._data.body. Fall
      // back to it before deciding the message is empty/media.
      // Discovered when the morning roster-survey DMs landed: 50+
      // inbound replies all logged as bodyLen=0 even though Kemal
      // could see them as plain text in WhatsApp.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rawBody = (msg as any)._data?.body;
      const effectiveBody =
        typeof msg.body === "string" && msg.body.length > 0
          ? msg.body
          : typeof rawBody === "string"
            ? rawBody
            : "";

      // Diagnostic — log every incoming message's headline metadata
      // so we can debug the DM-reply path without re-deploying.
      // Trim if too noisy in production.
      console.log(
        `[msg] from=${msg.from} fromMe=${msg.fromMe} type=${msg.type} bodyLen=${(msg.body ?? "").length} dataBodyLen=${typeof rawBody === "string" ? rawBody.length : "?"} hasMedia=${msg.hasMedia ?? false}`,
      );

      if (msg.fromMe) return;

      // 1-1 DM detection: anything that's NOT a group (@g.us) is
      // treated as a DM. Sender JID can be @c.us (phone-keyed) or
      // @lid (privacy-mode, opaque). For @c.us we extract the phone.
      // For @lid we forward an empty phone + the sender's pushname,
      // and let the server resolve by name against open survey DMs.
      const isGroup = msg.from?.endsWith("@g.us");
      if (!isGroup) {
        const text = effectiveBody.trim();

        // Non-text replies (voice notes, images, stickers, audio,
        // video) come in with empty msg.body. The roster-survey
        // classifier only handles text — nudge the sender to retype
        // in words. Reply at most once per inbound non-text DM so we
        // don't spam reactions/system events; the server side gates
        // on the user's open-survey state too.
        if (text.length === 0) {
          const isMediaReply =
            msg.hasMedia === true ||
            ["audio", "ptt", "image", "video", "sticker", "document"].includes(
              String(msg.type),
            );
          if (isMediaReply) {
            try {
              await msg.reply(
                "Hey 👋 I can only read text replies for the check-in. Could you type a quick word or two?\n\n" +
                  "• \"yes\" / \"I'm in\" — keep me on the roster\n" +
                  "• \"maybe\" / \"depends\"\n" +
                  "• \"not for now\" / \"out\"",
              );
              console.log(`[dm] nudged non-text reply from=${msg.from} type=${msg.type}`);
            } catch (err) {
              console.error("dm nudge reply failed:", err);
            }
          }
          return;
        }
        let phone = "";
        if (msg.from?.endsWith("@c.us")) {
          phone = msg.from.replace("@c.us", "").replace(/^\+/, "");
        }
        // Pushname / contact name — fallback identifier.
        let authorName: string | undefined;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rawNotify = (msg as any)._data?.notifyName;
        if (typeof rawNotify === "string" && rawNotify.trim()) {
          authorName = rawNotify.trim();
        }
        // @lid privacy DMs hide the phone in the JID (msg.from ends in
        // "@lid", not "@c.us"). Without a phone the server can't map the
        // sender to a user and drops the reply as "unknown sender" — which
        // silently broke collector fee replies ("£10 each"), DM Q&A, etc.
        // Recover the real number (and name) from the contact record.
        if (!phone || !authorName) {
          try {
            const contact = await msg.getContact();
            if (!phone) {
              // Contact.number is the real phone even when the JID is @lid.
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const num = (contact as any)?.number;
              if (num && String(num).trim()) {
                phone = String(num).replace(/[^\d]/g, "");
              }
            }
            if (!authorName) {
              const pn = contact.pushname || contact.name;
              if (pn && pn.trim()) authorName = pn.trim();
            }
          } catch {
            /* non-fatal */
          }
        }
        console.log(
          `[dm] resolved from=${msg.from} phone=${phone || "?"} name=${authorName ?? "?"}`,
        );
        try {
          // `/api/whatsapp/dm-reply` 400s on an empty waMessageId, so the old
          // `msg.id?._serialized ?? ""` silently binned every DM reply once
          // the injected page code stopped exposing a readable id — the same
          // failure that killed group attendance on 2026-08-30. Degrade to a
          // deterministic synthetic id instead (the route only uses the field
          // as a presence check, so a stand-in is safe).
          await postDmReply({
            phone,
            authorName,
            body: text,
            waMessageId: resolveWaMessageId(msg).waMessageId,
          });
          console.log(
            `[dm] forwarded reply from=${msg.from} authorName=${authorName ?? "?"}`,
          );
        } catch (err) {
          console.error("dm-reply forward failed:", err);
        }
        return;
      }

      // Phase 2: a group the bot isn't monitoring yet can bootstrap
      // itself with an explicit "@MatchTime setup". Loose pre-filter
      // here (server has the authoritative tight regex); on a hit we
      // start monitoring this group dynamically so the trigger + all
      // subsequent onboarding answers flow through the normal analyze
      // path. Everything else from unmonitored groups is still
      // dropped (no extra server load).
      //
      // 2026-05-25: also treat an @-mention of the bot's own JID as a
      // match. Reason: when a real user types `@MatchTime setup`,
      // WhatsApp replaces the visible "@MatchTime" with the bot's
      // PHONE NUMBER in the raw body (e.g. "@447... setup"), so a
      // literal-text-only regex misses every real @-mention. Without
      // this, every Amir-group setup attempt got silently dropped.
      if (!isMonitoredGroup(msg.from!)) {
        const t = effectiveBody.toLowerCase();
        // Both reads below go through whatsapp-web.js's injected page code and
        // can THROW on a build mismatch. Unguarded they'd escape to the outer
        // catch and drop the message entirely, so the setup trigger could
        // never fire while the library was broken. Degrade to the text regex.
        let selfId: string | undefined;
        try {
          selfId = client.info?.wid?._serialized; // e.g. "447...@c.us"
        } catch {
          /* non-fatal — fall back to the literal "match time" regex below */
        }
        let mentionedIds: string[] = [];
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          mentionedIds = ((msg as any).mentionedIds ?? []) as string[];
        } catch {
          /* non-fatal */
        }
        const mentionsBot = !!selfId && mentionedIds.includes(selfId);
        const looksLikeSetup =
          (mentionsBot || /match\s*time/.test(t)) &&
          /\b(set\s*up|setup|get\s*started|onboard)\b/.test(t);
        if (!looksLikeSetup) return;
        addMonitoredGroup(msg.from!);
        console.log(
          `[onboarding] setup trigger in ${msg.from} — now monitoring (mentionsBot=${mentionsBot})`,
        );
      }

      // WhatsApp pushname — the sender's self-set profile name. Used
      // for auto-enrolment on new phones and for name-based fallback
      // when the sender is an @lid (opaque, no phone).
      let authorName: string | undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rawNotify = (msg as any)._data?.notifyName;
      if (typeof rawNotify === "string" && rawNotify.trim()) {
        authorName = rawNotify.trim();
      } else {
        try {
          const contact = await msg.getContact();
          const pn = contact.pushname || contact.name;
          if (pn && pn.trim()) authorName = pn.trim();
        } catch {
          /* non-fatal — missing name just means server falls back to phone */
        }
      }

      // Context buffer the analyser reads for nuanced classification.
      recordHistory(msg.from, {
        authorName: authorName ?? null,
        body: effectiveBody,
        timestamp: new Date((msg.timestamp ?? Date.now() / 1000) * 1000).toISOString(),
      });

      await enqueueForAnalysis(client, msg);
    } catch (err) {
      console.error("message handler failed:", err);
    }
  });

  // Reactions on any tracked message (bench-prompt 👍/👎). Forward to server
  // and let it decide the outcome.
  client.on("message_reaction", async (reaction) => {
    try {
      const waMessageId = reaction.msgId?._serialized;
      const fromId = reaction.senderId;
      const emoji = reaction.reaction;
      if (!waMessageId || !fromId || !emoji) return;
      // @c.us reactors carry a phone in the senderId. @lid privacy
      // reactors don't — sending the opaque @lid string as a "phone"
      // is useless, so forward an empty phone + the pushname instead
      // and let the server verify identity against the expected bench
      // player. Mirrors the poll-vote + DM @lid handling. (Without
      // this, every privacy-mode bench player's 👍/👎 was silently
      // dropped — Kemal flagged Erdal's lost 👎 on 2026-05-18.)
      const isCus = fromId.endsWith("@c.us");
      const phone = isCus ? fromId.replace("@c.us", "").replace(/^\+/, "") : "";
      let fromAuthorName: string | undefined;
      try {
        const contact = await client!.getContactById(fromId);
        fromAuthorName =
          contact?.pushname ||
          contact?.name ||
          (contact as unknown as { verifiedName?: string })?.verifiedName ||
          undefined;
      } catch {
        // best-effort — server falls back to phone match if unavailable
      }
      await postReaction({ waMessageId, emoji, fromPhone: phone, fromAuthorName });
    } catch (err) {
      console.error("Error forwarding reaction:", err);
    }
  });

  // Poll votes — forwarded to the server so MoM polls can merge with app
  // votes. The wweb.js event delivers a PollVote object with the voter
  // and the selected option names.
  client.on(
    "vote_update" as Parameters<typeof client.on>[0],
    async (vote: {
      parentMessage?: { id?: { _serialized?: string } };
      voter?: string;
      selectedOptions?: Array<{ name?: string; localId?: number }>;
    }) => {
      try {
        const waMessageId = vote.parentMessage?.id?._serialized;
        const voterId = vote.voter;
        if (!waMessageId || !voterId) return;
        const phone = voterId.replace("@c.us", "").replace(/^\+/, "");
        // selectedOptions can be empty (un-vote).
        const picked = vote.selectedOptions?.[0]?.name ?? null;
        // Pull the voter's pushname so the server can fuzzy-match as a
        // fallback when WhatsApp's @lid privacy hides the phone.
        let voterName: string | undefined;
        try {
          const contact = await client!.getContactById(voterId);
          voterName =
            contact?.pushname ||
            contact?.name ||
            (contact as unknown as { verifiedName?: string })?.verifiedName ||
            undefined;
        } catch {
          // best-effort — server falls back to phone match if unavailable
        }
        await postPollVote({ waMessageId, voterPhone: phone, voterName, optionName: picked });
      } catch (err) {
        console.error("Error forwarding poll vote:", err);
      }
    },
  );

  // Group-membership events — someone joined or left a monitored group.
  // We forward the phone numbers (minus `@c.us`, minus any `@lid`
  // participants we can't resolve) to the server, which auto-onboards
  // new joiners and marks leavers as `leftAt` without destroying their
  // history. DMs to admins are queued server-side.
  //
  // Self-events (the bot itself being added/removed) are skipped so we
  // don't DM admins about the bot joining its own group.
  function extractPhones(recipientIds: string[] | undefined, selfId: string | undefined): string[] {
    if (!Array.isArray(recipientIds)) return [];
    return recipientIds
      .filter((id) => id.endsWith("@c.us"))
      .filter((id) => id !== selfId)
      .map((id) => id.replace("@c.us", "").replace(/^\+/, ""))
      .filter((p) => p.length > 0);
  }

  // Phase 1 autonomous onboarding helper: snapshot a group's current
  // participants with the SAME phone/lid/pushname extraction as the
  // startup sync sweep (index.ts ready-handler). Used only by the
  // self-add branch below; the startup sweep is deliberately untouched.
  async function collectGroupParticipants(
    groupId: string,
    selfId: string | undefined,
  ): Promise<Array<{ phone?: string; lidId?: string; pushname?: string }>> {
    const chat = await client.getChatById(groupId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const participants = (chat as any).participants ?? [];
    const out: Array<{ phone?: string; lidId?: string; pushname?: string }> = [];
    for (const p of participants as Array<{ id: { _serialized: string } }>) {
      const id = p.id._serialized;
      if (selfId && id === selfId) continue; // skip the bot itself
      let phone: string | undefined;
      let lidId: string | undefined;
      if (id.endsWith("@c.us")) {
        phone = id.replace("@c.us", "").replace(/^\+/, "");
      } else if (id.endsWith("@lid")) {
        lidId = id;
        try {
          const contact = await client.getContactById(id);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const num = (contact as any).number;
          if (typeof num === "string" && num.length > 0) phone = num;
        } catch {
          /* ignore — server skips lid-only participants */
        }
      }
      let pushname: string | undefined;
      try {
        const contact = await client.getContactById(id);
        pushname = contact.pushname || contact.name || undefined;
      } catch {
        /* non-fatal */
      }
      out.push({ phone, lidId, pushname });
    }
    return out;
  }

  // Phase-2 onboarding enrichment helper: capture the group's recent chat
  // history shortly after the bot is added, so the server can mine player
  // positions / seed ratings / schedule LATER at onboarding completion
  // (the bot can only reliably fetch WhatsApp history around JOIN time).
  //
  // WhatsApp may not have synced history to a freshly-joined member yet,
  // so we RETRY a couple of times. Whole thing is best-effort: any failure
  // returns [] and the caller proceeds without history (degrade
  // gracefully — never block the intro/onboarding).
  async function collectGroupHistory(
    groupId: string,
    _selfId: string | undefined,
  ): Promise<
    Array<{ author: string; authorPhone: string | null; text: string; timestamp: string }>
  > {
    const LIMIT = 600;
    const ATTEMPTS = 3;
    const RETRY_MS = 4000;
    const MIN_USEFUL = 5; // < this many → assume history hasn't synced yet

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let raw: any[] = [];
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      try {
        const chat = await client.getChatById(groupId);
        try {
          raw = await chat.fetchMessages({ limit: LIMIT });
        } catch {
          // fetchMessages can throw for a chat not fully loaded in the
          // headless session — fall back to the cached last message.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const lm = (chat as any).lastMessage;
          raw = lm ? [lm] : [];
        }
      } catch {
        raw = [];
      }
      console.log(
        `[bot-added] history fetch attempt ${attempt}: got ${raw.length} msgs`,
      );
      if (raw.length >= MIN_USEFUL) break;
      if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, RETRY_MS));
    }

    if (raw.length === 0) return [];

    // Sort oldest→newest (fetchMessages usually returns oldest-first, but
    // don't rely on it).
    raw.sort((a, b) => (a?.timestamp ?? 0) - (b?.timestamp ?? 0));

    const out: Array<{
      author: string;
      authorPhone: string | null;
      text: string;
      timestamp: string;
    }> = [];
    for (const m of raw) {
      try {
        if (m.fromMe) continue; // never include the bot's own messages
        // Skip system / notification events: keep only normal chat
        // messages (type "chat") OR anything carrying a non-empty body.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const dataBody = (m as any)._data?.body;
        const text =
          typeof m.body === "string" && m.body.length > 0
            ? m.body
            : typeof dataBody === "string"
              ? dataBody
              : "";
        if (m.type !== "chat" && !text) continue;
        if (!text.trim()) continue; // blank text → server drops it anyway

        // Author display name (best-effort; skip nameless rows — the
        // server drops blank-author rows regardless).
        let author: string | null = null;
        try {
          const contact = await m.getContact();
          author = contact?.pushname || contact?.name || null;
        } catch {
          /* non-fatal */
        }
        if (!author) continue;

        // authorPhone: E.164 digits without "+", or null. @c.us → digits;
        // @lid → resolve via the contact's .number; else null.
        let authorPhone: string | null = null;
        const id: string | undefined = m.author ?? m.from;
        if (id?.endsWith("@c.us")) {
          authorPhone = id.replace("@c.us", "").replace(/^\+/, "") || null;
        } else if (id?.endsWith("@lid")) {
          try {
            const contact = await client.getContactById(id);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const num = (contact as any)?.number;
            if (typeof num === "string" && num.length > 0) {
              authorPhone = num.replace(/^\+/, "");
            }
          } catch {
            /* non-fatal — leave null */
          }
        }
        if (authorPhone) authorPhone = authorPhone.replace(/\D/g, "") || null;

        out.push({
          author,
          authorPhone,
          text,
          timestamp: new Date(
            (m.timestamp ?? Date.now() / 1000) * 1000,
          ).toISOString(),
        });
      } catch {
        /* skip this message; never abort the whole capture */
      }
    }

    console.log(
      `[bot-added] history fetched ${raw.length} msgs (mapped ${out.length} after filtering) for ${groupId}`,
    );
    return out;
  }

  client.on(
    "group_join" as Parameters<typeof client.on>[0],
    async (notification: { chatId?: string; recipientIds?: string[]; author?: string }) => {
      try {
        const groupId = notification.chatId;
        if (!groupId) return;
        const selfId = client.info?.wid?._serialized;

        // ── Self-add detection (Phase 1 autonomous onboarding) ─────
        // The bot itself was just ADDED to a group it isn't monitoring
        // → tell the server. The server is fully authoritative: the
        // ONBOARDING_AUTOSTART flag gate and the live-org
        // short-circuit both live there; the bot only posts the intro
        // (and starts monitoring) when the server hands text back.
        // Monitored groups and human joins are untouched below.
        const recipientIds = notification.recipientIds ?? [];
        const isSelfAdd = !!selfId && recipientIds.includes(selfId);
        if (isSelfAdd && !isMonitoredGroup(groupId)) {
          console.log(
            `[bot-added] self-add detected in ${groupId} (author=${notification.author ?? "?"})`,
          );
          let groupSubject: string | undefined;
          let participants: Array<{ phone?: string; lidId?: string; pushname?: string }> = [];
          try {
            const chat = await client.getChatById(groupId);
            groupSubject = chat?.name || undefined;
          } catch (err) {
            console.error("[bot-added] getChatById failed:", err);
          }
          try {
            participants = await collectGroupParticipants(groupId, selfId);
          } catch (err) {
            console.error("[bot-added] participant snapshot failed:", err);
          }
          // The adder's JID → phone. @lid adders: try the contact record.
          let addedByPhone: string | undefined;
          const author = notification.author;
          if (author?.endsWith("@c.us")) {
            addedByPhone = author.replace("@c.us", "").replace(/^\+/, "");
          } else if (author?.endsWith("@lid")) {
            try {
              const contact = await client.getContactById(author);
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const num = (contact as any)?.number;
              if (typeof num === "string" && num.length > 0) addedByPhone = num;
            } catch {
              /* non-fatal — server falls back to the consent replier */
            }
          }
          // Capture chat history for the onboarding enrichment pass. The
          // server persists it and uses it later at completion. Best-effort
          // — any failure leaves history undefined and onboarding proceeds.
          let enrichmentHistory:
            | Array<{ author: string; authorPhone: string | null; text: string; timestamp: string }>
            | undefined;
          try {
            const hist = await collectGroupHistory(groupId, selfId);
            if (hist.length > 0) {
              enrichmentHistory = hist;
              console.log(
                `[bot-added] sending ${hist.length} history msgs to server`,
              );
            }
          } catch (err) {
            console.error("[bot-added] history capture failed:", err);
          }
          const res = await postBotAdded({
            groupId,
            groupSubject,
            addedByPhone,
            participants,
            enrichmentHistory,
          });
          if (res?.introText) {
            addMonitoredGroup(groupId);
            await client.sendMessage(groupId, res.introText);
            console.log(
              `[bot-added] intro posted in ${groupId} ("${groupSubject ?? "?"}") — now monitoring`,
            );
          } else {
            console.log(
              `[bot-added] server says stay silent for ${groupId} (${res?.ignored ?? res?.existing ?? "no-intro"})`,
            );
          }
          return;
        }

        // ── Existing human-join path (byte-identical behaviour) ────
        if (!isMonitoredGroup(groupId)) return;
        const phones = extractPhones(notification.recipientIds, selfId);
        if (phones.length === 0) return;
        console.log(`group_join in ${groupId}: ${phones.join(", ")}`);
        await postGroupJoin({ groupId, phones });
      } catch (err) {
        console.error("Error forwarding group_join:", err);
      }
    },
  );

  client.on(
    "group_leave" as Parameters<typeof client.on>[0],
    async (notification: { chatId?: string; recipientIds?: string[] }) => {
      try {
        const groupId = notification.chatId;
        if (!groupId || !isMonitoredGroup(groupId)) return;
        const selfId = client.info?.wid?._serialized;
        const phones = extractPhones(notification.recipientIds, selfId);
        if (phones.length === 0) return;
        console.log(`group_leave in ${groupId}: ${phones.join(", ")}`);
        await postGroupLeave({ groupId, phones });
      } catch (err) {
        console.error("Error forwarding group_leave:", err);
      }
    },
  );

  client.on("disconnected", (reason: string) => {
    console.log("Client disconnected:", reason);
    stopScheduler();
    stopBatchFlushTimer();
  });

  process.on("SIGINT", async () => {
    console.log("\nShutting down...");
    stopScheduler();
    stopBatchFlushTimer();
    await client.destroy();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    stopScheduler();
    stopBatchFlushTimer();
    await client.destroy();
    process.exit(0);
  });

  await client.initialize();
}

main().catch(console.error);
