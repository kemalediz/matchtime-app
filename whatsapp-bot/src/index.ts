import pkg from "whatsapp-web.js";
const { Client, LocalAuth } = pkg;
import qrcode from "qrcode-terminal";
import { setMonitoredGroups, isMonitoredGroup } from "./handlers.js";
import { initScheduler, stopScheduler } from "./scheduler.js";
import {
  getEnabledOrgs,
  postReaction,
  postPollVote,
  postGroupJoin,
  postGroupLeave,
  postDmReply,
  postSyncParticipants,
} from "./api.js";
import {
  enqueueForAnalysis,
  recordHistory,
  startBatchFlushTimer,
  stopBatchFlushTimer,
} from "./smart-analysis.js";
import { config } from "./config.js";

async function main() {
  console.log("MatchTime WhatsApp Bot starting...");
  console.log(`API URL: ${config.apiUrl}`);

  const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
      headless: true,
      executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    },
  });

  client.on("qr", (qr: string) => {
    console.log("\nScan this QR code with WhatsApp on the burner phone:\n");
    qrcode.generate(qr, { small: true });
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
      console.error("Failed to enumerate groups:", err);
    }

    try {
      const data = await getEnabledOrgs();
      const orgConfigs = (data.orgs || [])
        .filter((o: { whatsappGroupId: string | null }) => o.whatsappGroupId)
        .map((o: { whatsappGroupId: string; name: string }) => ({
          groupId: o.whatsappGroupId,
          orgName: o.name,
        }));

      setMonitoredGroups(orgConfigs.map((o: { groupId: string }) => o.groupId));

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
      console.error("Failed to fetch org configs:", err);
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
        // Pushname / contact name — used as fallback when phone is
        // hidden by @lid privacy.
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
            /* non-fatal */
          }
        }
        try {
          await postDmReply({
            phone,
            authorName,
            body: text,
            waMessageId: msg.id?._serialized ?? "",
          });
          console.log(
            `[dm] forwarded reply from=${msg.from} authorName=${authorName ?? "?"}`,
          );
        } catch (err) {
          console.error("dm-reply forward failed:", err);
        }
        return;
      }

      if (!isMonitoredGroup(msg.from!)) return;

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
      const phone = fromId.replace("@c.us", "").replace(/^\+/, "");
      await postReaction({ waMessageId, emoji, fromPhone: phone });
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

  client.on(
    "group_join" as Parameters<typeof client.on>[0],
    async (notification: { chatId?: string; recipientIds?: string[] }) => {
      try {
        const groupId = notification.chatId;
        if (!groupId || !isMonitoredGroup(groupId)) return;
        const selfId = client.info?.wid?._serialized;
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
