# Findings backlog

Things Kemal has noted that are NOT being worked on yet. Each entry says what, why and where. Move an entry out of here when work on it starts.

---

## F1. Info (ⓘ) buttons on every organiser-facing section (Kemal, 2026-09-30)

**What:** every section, badge and field on the owner/organiser pages gets an ⓘ button. Tapping it opens a popup panel explaining what that section is and what to do with it. "Owners need info."

**Why:** during the first in-group self-setup test ("MT Test"), the setup check page showed a player card with a **low** badge and Kemal could not tell what it meant (it is the confidence of MatchTime's guess of position and seed rating from the chat history, not a low rating). Organisers outside Sutton will hit the same confusion everywhere.

**How:** same approach as HomeTenant (HT): an "i" button per section opening a popup panel. Reuse `src/components/stats/info-button.tsx` if it fits. EN and TR copy via `src/lib/i18n`, no em dashes.

**Where, at least:**
- `/finish-setup/[sessionId]` (Proposed players, the high/medium/low confidence badge, Position, Seed rating, the evidence note)
- `/admin` dashboard cards
- `/admin/players` (seed rating, club rating, aliases, merge, possible duplicates, new-player banner)
- `/admin/settings` (features list, money collector's bank / Stripe connect)
- `/admin/activities`, `/admin/block-bookings`, `/admin/matches/*` (cancel, switch format, teams)
- `/admin/clubs` and `/admin/health` (owner only)

**Related wording fix to fold in:** the confidence badge "low" should read as a guess ("Guess: low confidence" or "Please check"), and the evidence note "No clear signal in chat — defaulting to neutral" should become "Nothing in the chat about this player, so I've set a neutral starting point." (the note comes from `src/lib/onboarding-analyzer.ts`; change it on the display side to avoid a prompt change).

**When:** after the Hamzah demo (2026-09-30).

---

## F3. Learn how the group works and set it up that way (Kemal, 2026-10-01)

**What:** once, right after a new club is approved, MatchTime reads the chat history WhatsApp shared when it joined (already captured by the Pi) with one AI call and works out how the group runs. **It then applies the settings itself and shows the organiser what it set and why**, with one tap to change any of them (Kemal: "settings can be automatically done, and shown to the organiser"). Replaces AI-drafted seed ratings, which gave little value (most players came back "low" confidence at the neutral 6).

**Signals and the setting each one drives:**
- nobody says "In", an admin posts the list or "same as last week": rolling squad
- admins announce who plays, players message admins: organisers pick from the waiting list
- "clear your names by Monday", "list out Tuesday": weekly deadlines with those times
- "paid", "sent", "transferred" after games: payment tracking on
- day, time, venue, how many a side: the weekly game and the format
- Turkish or English: language (already done without AI)

**Rules:** nothing changes when the history is empty or too short; each applied setting is listed in the organiser DM and on /admin/settings with the chat evidence ("from messages like: ...") and an undo. One AI call per new club, inside the new club's daily cap. It is a new prompt, so it needs Kemal's approval for one live check (each case once).

**When:** after the Friday features are live with Hamzah's group.
