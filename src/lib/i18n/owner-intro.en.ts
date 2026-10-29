/** Kemal's introduction messages in English. See `owner-intro.ts`. Approved copy, 2026-10-29: change only with Kemal. */
import type { OwnerIntroCopy } from "./owner-intro";

export const OWNER_INTRO_EN: OwnerIntroCopy = {
  footballGroups: (siteUrl) => `Hi lads 👋

I've seen we keep struggling to get numbers, so I thought I'd share something that might help.

I run another football group, and we use *MatchTime*, a WhatsApp assistant I built that sits in the group and does the admin for us:

✅ *Attendance:* players just say IN or OUT, and it keeps the list and the count
🪑 *Bench:* when the squad is full, extra names go on the bench and step in when someone drops out
🔎 *Finding players:* if we're short, the organiser tags MatchTime and it asks nearby players from the MatchTime player pool and from partner clubs
⚖️ *Balanced teams:* it picks fair teams from player ratings
💷 *Payments:* it tracks who has paid
🏆 *Ratings, Man of the Match and a stats page* the lads actually enjoy

No more re-pasting lists or chasing people one by one.

Have a look: ${siteUrl}

If the organisers fancy trying it, I'm happy to set it up for the group.`,
  poolInvite: (playUrl) => `Hi all 👋

Quick one for anyone who likes a kickabout ⚽

I've built *MatchTime*, which helps local football teams, and it now has a *player pool*: a list of people who'd like a game when a team nearby is short.

*How it works*
1. Tell it your postcode area (just the first part, e.g. SM1), how far you'll travel, and the days and times you're free.
2. Confirm with one WhatsApp message.
3. When a team near you needs a player, MatchTime messages you with the game. You say yes or no each time.

🙌 No commitment, you only play when you want to
🔒 A team sees your first name and initial only after you say yes
📵 A limited number of messages a week, and you can stop any time
🆓 Free to join

Sign up here: ${playUrl}`,
  newFeatures: (playUrl) => [
    `Hi all 👋

Some new MatchTime features you can use from today:

⚽ *The MatchTime player pool*
The pool is a list of local players who'd like extra games. When a team nearby is a player short, MatchTime messages them on WhatsApp with the game, and they decide each time. Clubs can now fill their empty places from it.

🔎 *Short of players? MatchTime finds them.*
Organisers, just tag MatchTime and say where to look. It asks straight away:
• *@Match Time find 2 players from the pool for Thursday*
• *@Match Time find players from partner clubs for Thursday*
• *@Match Time find players from partner clubs and the pool for Thursday*

🤝 *Partner clubs:* link up with other MatchTime clubs nearby and share spare players. If you switch it on, MatchTime can ask your partners automatically on match day.

🙋 *You see who's coming:* when a pool player or a partner club's player takes a place or goes on the bench, MatchTime posts it here, so everyone knows who's joining.`,
    `⚽ *Want more games yourself? Join the pool.*
Turn on *Play elsewhere too* on your MatchTime profile, or sign up here:
${playUrl}

When a team near you is a player short, you get a WhatsApp message with the game, and you decide each time. No spam: a limited number of messages a week, and you can stop any time. You also get your own link to invite friends.

Any questions, just tag *@Match Time help*.`,
  ],
};
