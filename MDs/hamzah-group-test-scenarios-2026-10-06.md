# Friday group features: manual test script for MT Test

Written 2026-10-06 for Kemal. It rehearses everything built for Hamzah's Friday group, in the WhatsApp group "MT Test", before the real group goes live. Every expected result below was traced in the code or in a test. Anything that could not be confirmed is in the "Not confirmed" list at the end, not in a scenario.

Monthly squad mode is not covered here. It has its own script, which reuses MT Test after this one.

---

## 1. Read this first

### Phones

| Phone | Who | Used for |
|---|---|---|
| A | Yours | Club owner, platform approver, admin group |
| B | Borrowed, called "Bilal" here | A normal player |
| C | Borrowed, called "Callum" here | A second player (one scenario only) |

- 17 scenarios need only phone A. 6 need phone B. 1 needs phone C.
- B and C must be members of MT Test before you start, and must NOT be members of Sutton Football Club's group.
- B and C should each post one message in MT Test after approval, so MatchTime learns their WhatsApp names.

### Your own number is special. Three rules.

Your number is the platform owner, and it is also an admin of Sutton Football Club. Messages you type inside MT Test always belong to the test club. Direct messages to MatchTime do not.

1. **Do not DM MatchTime "IN" or "OUT" from phone A.** A DM is recorded against whichever of your clubs kicks off soonest. Sutton plays on Tuesdays, so on some days that is Sutton's real match, and it is announced in Sutton's group.
2. **Do not DM MatchTime a request for players, or a question, from phone A.** A request for players is acted on for whichever of your clubs has the soonest match, and sends real invitations. A question is answered about Sutton.
3. **Before you save anything on the website, check the club name at the top of the side menu.** It must say your test club. Opening a link from an old Sutton message switches the website back to Sutton.

The only DMs this script asks phone A to send are the connect message, APPROVE, and "help". Do every other DM test from phone B.

### How fast things happen

- A plain "IN" or "OUT" in the group is read in batches. The tick can take up to 10 minutes. Within 1 hour of kickoff it is immediate.
- A message that tags MatchTime is read within seconds.
- Scheduled posts are checked every 30 seconds.
- DMs go out one per minute, so several DMs arrive spread out.
- A brand new club can send at most 20 DMs a day to its members for its first 28 days.
- Messages to admins wait for 08:00 if they come due between 22:00 and 07:59.
- There is no way to move the clock in production. Section 5 says which things can be brought forward safely and which cannot.

---

## 2. Setup, from zero

### Step 1. Take MatchTime out of both groups

Remove MatchTime from MT Test. If MatchTime is in your admin group, remove it from there too.

Why: a group is attached when MatchTime is ADDED to it. Being a member already does not count. And an add is matched to whichever connect code is open, so the admin group must not be added while the code is open.

### Step 2. Create the club

1. Sign in at matchtime.ai with your usual account.
2. Open matchtime.ai/create-org. The page is headed "Set up your club".
3. Fill in:
   - Club name: for example "MT Test FC"
   - Language MatchTime speaks in your group: English
   - Day: Friday
   - Kick-off time: 20:30 (use the Friday group's real time if it differs)
   - Venue: anything
   - Players per side: 9-a-side
4. Press "Create club".

You land on the club's admin page with a card headed "Connect MatchTime to WhatsApp".

Choosing the day: the first match is created by the overnight run (01:00 UK time until the clocks change on 25 October, midnight after). It creates the next Friday that is not today. The opening announcement needs more than 24 hours before kickoff. So do the setup on a Tuesday or Wednesday for a Friday game. A new organiser would start at matchtime.ai/signup instead (name, mobile, a 6 digit code by WhatsApp) and then reach the same form.

### Step 3. Connect, then add MatchTime back

1. Press "Add MatchTime to WhatsApp". WhatsApp opens with a message ready: "Connect MT Test FC, code XXXX". Send it. The code lasts 60 minutes.
2. MatchTime replies by DM: "Hi <your first name>, got it: MT Test FC is connected to this chat." followed by how to add it to the group.
3. Now add MatchTime to MT Test. You have 24 hours.
4. You get two DMs, about a minute apart:
   - "Thanks, I'm in "MT Test". I'll stay quiet there until your club is approved, usually within a day. I'll message you here when it's live."
   - "New club waiting: *MT Test FC* (ref XXXX)" with the organiser, who added it, the group and its member count, ending "Reply APPROVE XXXX or REJECT XXXX, or use matchtime.ai/admin/clubs".
5. **Check the "Group:" line names MT Test.** If it names any other group, remove MatchTime from that group (the club goes back to a draft and the card offers the button again) and repeat this step.

Do not add MatchTime to the admin group yet. Do not press the button and then wait a day: add it in the same sitting.

Now run scenarios 1 to 5 in order. Scenario 2 is the approval. Scenario 5 links the admin group.

### Step 4. Settings that mirror the Friday game

Open Settings from the link in your "you're live" DM (it opens the right club). Wait until scenario 3 is done before you change anything here.

| Section | Setting | Value for the test |
|---|---|---|
| Bot features | Payment tracking | On |
| Bot features | Collect match fees (Stripe) | Leave OFF |
| Weekly routine | Rolling squad | On |
| Weekly routine | Who fills an open place | "First to say IN" to begin with. Scenario 19 changes it to "The organisers pick" |
| Weekly routine | If nobody picks in time | "Leave it open" for this test (see Known gaps, item 1) |
| Weekly routine | Drop-out deadline, List published | Leave empty. Scenario 10 sets them |
| Weekly routine | Admin messages go to | "Admin WhatsApp group", linked in scenario 5 |

For the real Friday group the deadlines would be Monday 21:00 and Tuesday 20:00.

### Day plan (example: setup on Tuesday, game on Friday)

| Day | Scenarios |
|---|---|
| Tuesday, setup day | 1 to 7 |
| Wednesday | 8 (09:00), 9, 10, 11, then 18 to 21 and 24 with the borrowed phones |
| Thursday | 12 (17:00), 13 (18:00) |
| Friday, match day | 14, 22, 15 (one hour after kickoff) |
| Saturday | 16 (08:00 and 09:00), 17 |
| Sunday | 23 (10:00) |

---

## 3. Scenarios

### Solo: phone A only

- [ ] **1. Silent before approval**
  Proves: MatchTime says nothing in a group whose club is not approved.
  Steps: after Step 3, type in MT Test: "@Match Time help". Then type "IN".
  Expected: no reply, no tick, nothing at all. No match exists yet for the club.
  Pass if: MatchTime stays completely silent in MT Test.

- [ ] **2. Approval, the hello and the "you're live" DM**
  Proves: the owner's approval switches the club on, greets the group and briefs the organiser.
  Steps: from phone A, DM MatchTime: "APPROVE XXXX" (your code). The button "Approve MT Test FC" on matchtime.ai/admin/clubs, under "Waiting for you", does the same.
  Expected:
  - DM: "Approved MT Test FC. The hello goes out in the group within a few minutes." (Only when you approve by DM. The button shows the same words on the page.)
  - In MT Test: a message starting "👋 Hi everyone, I'm *MatchTime*. <Your first name> has set me up to run this group's games." It lists who's in, the bench, reminders, fair teams, ratings, stats and match fees, and ends "Anything else, tag me: *@Match Time help*".
  - DM: "Good news: MT Test FC is live. I've said hello in "MT Test"." with three links (your weekly game, starting ratings, Settings), then "Your first month is free." and a club fee tip.
  - The card on the admin page reads: "You're live. MatchTime said hello in "MT Test"."
  - You may also get a second group message starting "👋 Hi all, MatchTime bot is live for this group." See Known gaps, item 2.
  Pass if: the hello names you, and the DM carries three working links that open the test club.

- [ ] **3. Learned setup**
  Proves: MatchTime reads the group's chat once after approval and only changes what it has clear evidence for.
  Steps: do not touch Settings for 30 minutes after approval. Then open Settings.
  Expected, one of three:
  - Most likely for a test group: nothing. No DM and no panel. MatchTime only reads a chat of at least 20 messages from at least 3 people.
  - A DM starting "I read the recent messages in "MT Test" to see how it runs. I didn't change any settings, but a few things are worth a look."
  - A DM starting "I read the recent messages in "MT Test" to see how it runs, and set MatchTime up the same way.", with one line per setting it switched, a quote from the chat and an "Undo or change:" link.
  It can switch on rolling squad, the two deadlines and payment tracking, each only with two quoted messages. It never switches on "The organisers pick": it only suggests it. It never changes the weekly game or the language.
  The DM is only sent between 10:00 and 20:00. An evening run waits for 10:00.
  To see or undo: the top of Settings shows a panel "Set up from your group chat" with an "Undo" button on each item. No panel means nothing was set.
  Pass if: any setting that changed is listed in the panel with its quote, and "Undo" puts it back.

- [ ] **4. Help, in the group and by DM**
  Proves: help is answered instantly with fixed text, and a DM from your number answers for Sutton.
  Steps:
  a. In MT Test: "@Match Time help"
  b. In MT Test: "@Match Time help badges"
  c. In MT Test: "@Match Time help badges Mr Reliable"
  d. From phone A, DM MatchTime: "help"
  Expected:
  a. Starts "ℹ️ *MatchTime help*: here's what I can explain. Tag me with one of these:" and lists topics.
  b. Starts "🏅 *Badges: how to earn them*", lists eight badges, ends with "*@Match Time help badges Mr Reliable*".
  c. Starts "🧱 *Mr Reliable*" with its numbered rules.
  d. Starts "🏟️ For *Sutton Football Club*:". This is expected: you run two clubs, and DM help picks the one with the latest fixture booked.
  Pass if: a, b and c are about the test club and arrive within seconds, and d names Sutton on its first line.

- [ ] **5. Link the admin group**
  Proves: the admin group is linked with a one time code and never becomes a club of its own.
  Steps:
  1. In Settings, under "Admin messages go to", choose "Admin WhatsApp group" and press "Link admin group". The page shows "Keep this page open. Your code: XXXXXX" and three steps.
  2. In MT Test, send: "@Match Time admin group XXXXXX".
  3. Add MatchTime to your admin group. It says nothing.
  4. In the admin group, send the command with one letter wrong.
  5. In the admin group, send the command correctly.
  Expected:
  2. "This is *MT Test FC*'s main group, so it can't be the admin group. Add me to a separate group for the admins."
  3. Silence. No setup questions.
  4. "That code isn't valid any more. Open Settings on the website and press *Link admin group* for a new one." The real code still works.
  5. "✅ Linked as the admin group for *MT Test FC*." The Settings page changes to "Linked: <group name>" with an "Unlink" button.
  The code works once and lasts 48 hours. If no correct code is sent within 48 hours, MatchTime leaves the admin group.
  Pass if: step 5 gives the ✅ line and Settings shows "Linked".

- [ ] **6. The admin group is left alone**
  Proves: MatchTime reads nothing in the admin group unless a pick is open.
  Steps: in the admin group type "2", then "@Match Time help", then any sentence.
  Expected: no reply to any of them.
  Pass if: MatchTime stays silent.

- [ ] **7. Settings save, and bad deadlines are refused**
  Proves: each setting saves on its own and the deadline checks work.
  Steps: set the values in Step 4. Then, in "Drop-out deadline", try each of these and press "Save":
  a. Friday 21:00
  b. Wednesday 07:00
  c. A day with no time
  Expected: turning rolling squad on shows "Rolling squad is on". Changing who fills a place shows "Saved".
  a. "On match day, pick a time before kickoff."
  b. "Pick a time between 08:00 and 21:30."
  c. "Pick both a day and a time, or neither."
  Leave both deadlines empty afterwards.
  Pass if: all three are refused with those words and nothing is saved.

- [ ] **8. The opening announcement** (timed: 09:00 to 12:59, more than 24 hours before kickoff)
  Proves: a new match is announced once, in the morning, only while nobody is in.
  Steps: the morning after setup, check matchtime.ai shows Friday's match. Do not say IN before 09:00.
  Expected: one post: "📅 *Football 9-a-side*: *<day, date and time>* at <venue>." then "Say *IN* to join. First 18 confirmed play."
  Pass if: it arrives once, after 09:00, and says 18.

- [ ] **9. IN and OUT**
  Proves: plain words are recorded with a tick and no reply.
  Steps: in MT Test type "IN". Wait for the tick. Type "OUT". Wait. Type "IN" again.
  Expected: ✅ on the first IN, 👋 on the OUT, ✅ on the second IN. No text replies. Each tick can take up to 10 minutes. Nobody is told about the OUT, because it is before the drop-out deadline.
  Pass if: the three ticks match and the match page lists you as playing.

- [ ] **10. The final list once, the reminder without a second list, and the admin summary**
  Proves: the deadline posts, and that the same squad is not listed twice within 3 hours.
  Steps (any day before match day, between 10:00 and 20:00, you are IN):
  1. Set "List published" to today, at a time 5 minutes from now. Save. Leave "Drop-out deadline" empty.
  2. When the list has arrived: change "List published" to today, 60 minutes from now. Save.
  3. Set "Drop-out deadline" to today, 30 minutes from now. Save.
  Expected:
  1. At the time: "📋 *Football 9-a-side* list, *<date>*, <venue>", then "*Playing (1/18):*" with your name, "17 places still open." and "Can't make it now? Say *OUT* as soon as you can so a replacement can be brought in."
  3. Within a minute: "⏰ *Football 9-a-side*, <day and time>: the drop-out deadline is *today at HH:MM*. If you can't play, say *OUT* before then." With NO list of names under it, because the group saw this squad a few minutes ago.
  At the deadline, in the admin group: "Drop-out deadline passed for *Football 9-a-side* (<day and time>). Squad 1/18." then "Out this week: nobody.", "Waiting list: empty." and "17 places open."
  At the new publish time: nothing. The final list is posted once per match.
  Leave both deadlines set.
  Pass if: the reminder has no names, the summary lands in the admin group and not in MT Test, and the list is not posted a second time.

- [ ] **11. Late drop-out**
  Proves: with rolling squad on, an OUT after the deadline still counts and the admins are told.
  Steps: after the deadline from scenario 10 has passed, type "OUT" in MT Test. Later type "IN" to go back.
  Expected: 👋 on your OUT. In the admin group: "Late drop-out: *<your name>* said OUT for *Football 9-a-side* (<day and time>) at HH:MM, after the <weekday HH:MM> deadline. Squad is now n/18." Your later IN gets ✅ and puts you straight back.
  Off: with rolling squad switched off, the same late OUT tells nobody.
  Pass if: the OUT is recorded and the line arrives in the admin group.

- [ ] **12. The daily 17:00 post is off** (timed: 17:00 to 17:59 on a day that is not match day)
  Proves: with both deadlines set, the daily squad post stops except on match day.
  Steps: with both deadlines still set, watch MT Test from 17:00 to 18:00 on Thursday.
  Expected: no squad post.
  Off: if you press "Clear" on one deadline before 17:00, a post starting "🗓 *Football 9-a-side*: need *N more*." arrives with the list. Set the deadline again afterwards (scenarios 17 and 23 need both).
  Pass if: nothing is posted at 17:00 while both are set.

- [ ] **13. Admin messages go to the admin group** (timed: 18:00 to 18:59 the day before the match)
  Proves: a message meant for admins is posted once in the admin group, not sent to each admin.
  Steps: none. Fewer than 18 players are in, so a warning is due.
  Expected: in the admin group: "🚨 *Match in trouble*: only *N* confirmed for *Football 9-a-side* tomorrow, below the minimum to play (18)." with a link to the cancel page. The link asks you to sign in. Do NOT cancel the match.
  Pass if: it appears in the admin group and nothing about it appears in MT Test.

- [ ] **14. Match day posts** (timed, see section 5)
  Proves: a rolling squad club gets fixed wording on match day, and tonight means tonight.
  Steps: none. Stay short of 18.
  Expected in MT Test:
  - 08:00 to 08:59: "☀️ Still *N short* for tonight's *Football 9-a-side*. Any takers? 👀"
  - 3 to 4 hours before kickoff: "⏳ Still *N short* for *Football 9-a-side* at 20:30. Anyone free tonight?"
  - From 2 hours before: "⏰ Tonight *20:30* at *<venue>* · n/18. *Still need N*, last chance to jump in. 🙏"
  - 1.5 to 2 hours before: "⚽ *20:30 at <venue>*, see you there!" with the reminder to bring gloves, a ball and bibs.
  Off: with rolling squad off, the first three are written by the AI and vary.
  Pass if: each arrives once in its window.

- [ ] **15. The payment poll** (timed: kickoff plus 60 minutes)
  Proves: payment tracking posts the poll at the final whistle.
  Steps: be IN at kickoff. After the poll arrives, do NOT vote from phone A.
  Expected: a poll: "💳 Payments for *Football 9-a-side*: tick when you've paid" with the two team names as options. About an hour later: "🏁 *Football 9-a-side*: hope it was a good one. What was the final score? I'll use it to keep next week's teams balanced."
  Off: with Payment tracking off, no poll.
  Pass if: the poll arrives within a few minutes of the final whistle.

- [ ] **16. Rolling squad** (timed: 08:00 and 09:00 the morning after the match)
  Proves: whoever was in at the final whistle is in next week without saying so.
  Steps: none. To bring it forward, see section 5.
  Expected: after 08:00 the match page for next Friday lists everyone who was playing at the final whistle. Between 09:00 and 12:59, in MT Test: "📅 *Football 9-a-side*, *<date>*, <venue>." then "Everyone who played last time is in again. Drop-out deadline: *<weekday HH:MM>*. Until then, you're in unless you say *OUT*." then "*In (n/18):*" with the names, then a last line about open places.
  That last line reads "say *IN* to take one" with first come, and "say *IN* to go on the waiting list, and the organisers will pick who plays" with organisers pick.
  Players on the waiting list at the final whistle are NOT carried over.
  Off: with rolling squad off, next week starts empty and gets the scenario 8 announcement.
  Pass if: the names match last night's squad and nobody had to say IN.

- [ ] **17. The reminder with the list** (after scenario 16)
  Proves: the normal drop-out reminder carries the squad.
  Steps: on Saturday after 13:00, set "Drop-out deadline" to today, 60 minutes from now, then "List published" to today, 90 minutes from now.
  Expected: within a minute, the "⏰" reminder from scenario 10, this time WITH the "*Confirmed (n/18):*" list of names under it. At the deadline, the summary in the admin group. At publish time, the "📋" list.
  Pass if: the reminder shows the names this time.

### Two phones: A and B

- [ ] **18. Bench offer, posted once, with the right day**
  Proves: with "First to say IN", a drop is offered to the bench in one post that names the match day.
  Steps (not on match day, between 08:00 and 21:59):
  1. "Who fills an open place" is "First to say IN". You are IN.
  2. On the match page press "Add player", choose Bilal, tick "Add to bench instead of the squad", and add.
  3. From phone A type "OUT" in MT Test.
  4. From phone B reply "IN" in MT Test.
  Expected:
  3. One post: "🎟 A slot just opened for *Football 9-a-side* on <day and date>. *First to claim it plays.*" then Bilal's tag, then "Just reply *IN* here to take it. No rush and no timeout, whoever is free first gets it and everyone else stays on the bench. 🙏" Phone B also gets a DM starting "👋 Hi Bilal, a slot just opened for Football 9-a-side on <day and date> and you're on the bench."
  4. "✅ *Bilal* is in, replacing *<your name>*. Squad *1/18* 🙌"
  Because the deadline has passed, the admin group also gets a late drop-out line about you.
  Pass if: the slot is announced once, and it says the day, not "tonight".

- [ ] **19. The organisers pick**
  Proves: nobody gets a place by saying IN. The admins choose, in the admin group.
  Steps:
  1. Set "Who fills an open place" to "The organisers pick". Add Bilal to the admin group as an ordinary member.
  2. On the match page, add Bilal again with "Add to bench instead of the squad" ticked, so he is waiting. You say "IN" from phone A.
  3. Wait for the message in the admin group.
  4. From phone B, in the admin group, type "1".
  5. From phone A, in the admin group, type a normal sentence.
  6. From phone A, in the admin group, type your own name.
  7. From phone A, in the admin group, type "1".
  Expected:
  2. Your own IN gets ✅ and goes straight in, because you are the owner. A player's IN gets 🪑 and goes on the waiting list.
  3. "There are 17 places open in *Football 9-a-side* (<day and time>), squad 1/18." then "Waiting list:" and "1. Bilal (no position, new)", then "Reply here with a number, a name or an @tag, e.g. *2*, or *2 3* for two. *NONE* leaves it open." and "If nobody picks by <time>, the place stays open."
  4 and 5. No reply. Bilal is not an admin, and chat is ignored.
  6. "*<your name>* is already in. Pick someone else?"
  7. In the admin group: "✅ Done: *Bilal* is in (picked by <your name>)." In MT Test: "✅ *Bilal* is in. Squad *2/18*." To phone B by DM: "You're in for Friday 20:30 at <venue> ⚽ Can't make it after all? Just say *OUT*."
  MatchTime sends at most one pick message an hour for a match. After the first one, reply with a name.
  Pass if: Bilal only gets in after your "1", and all three confirmations arrive.

- [ ] **20. NONE**
  Proves: an admin can leave a place open.
  Steps: while the pick from scenario 19 is still open, type "NONE" in the admin group from phone A.
  Expected: "OK, I'll leave the place open. You can still pick from the waiting list on the match page."
  If you skip this scenario, the open pick closes by itself 24 hours after its message, with the "Nobody picked" line from scenario 22.
  Pass if: that line arrives and nothing is posted in MT Test.

- [ ] **21. A dropped player takes his place back**
  Proves: a regular who says OUT by mistake does not need to be picked again.
  Steps: from phone B type "OUT" in MT Test. Wait for the tick. Type "IN".
  Expected: 👋 then ✅. Bilal is back in the squad with no pick. The admin group gets a late drop-out line about Bilal.
  Pass if: Bilal is in the squad again without any admin reply.

- [ ] **22. Nobody picks, and "tonight"** (match day, within 5 hours of kickoff)
  Proves: an unanswered pick closes by itself, and a match day bench offer says tonight.
  Steps:
  1. On the match page, add Bilal with "Add to bench instead of the squad" ticked. Do not reply to the pick message.
  2. One hour after it: check the admin group.
  3. Then set "Who fills an open place" to "First to say IN". Add Bilal to the bench again if needed. From phone A type "OUT".
  Expected:
  1. A pick message whose last line is "If nobody picks by <about one hour later>, the place stays open."
  2. "Nobody picked for *Football 9-a-side*, so the place stays open. Squad n/18."
  3. The bench offer from scenario 18, this time reading "for *Football 9-a-side* tonight".
  If no pick message arrives in step 1: a new one is only sent when something changed since the last one closed (a drop, the waiting list, or the number of places).
  Afterwards Bilal replies "IN" to take the slot and you say "IN" again, so that both of you are playing at kickoff (scenario 23 needs that).
  Pass if: the place is left open after the hour, and the offer says "tonight".

- [ ] **23. Unpaid reminder and the admin unpaid list** (timed: 10:00 two days after the match)
  Proves: the group gets a gentle count and the admins get the names.
  Steps: you and Bilal were both IN at the final whistle. Bilal votes in the payment poll. You do not. Both deadlines are set and Payment tracking is on.
  Expected at 10:00 on Sunday:
  - In MT Test: "💳 1 payment still pending for Friday's match. If you've already paid, tick your team in the payment poll to clear it 🙏"
  - In the admin group: "💷 Unpaid for *Football 9-a-side* (<day and time>): <your name>. 1 of 2 paid."
  Neither is sent if nobody at all has voted, or if everybody has.
  Pass if: the group post names nobody and the admin post names you.

### Three phones: A, B and C

- [ ] **24. Picking someone who is not on the waiting list**
  Proves: an admin can bring in any club member, after confirming.
  Steps: Callum has posted once in MT Test and has not said IN. A pick is open (add Bilal to the bench as in scenario 19). In the admin group, from phone A, type "Callum". Then type "YES".
  Expected: "*Callum* isn't on the waiting list. Bring them in anyway? Reply *YES*." Then "✅ Done: *Callum* is in (picked by <your name>)." MT Test gets "✅ *Callum* is in. Squad *n/18*." and phone C gets the "You're in for Friday 20:30" DM. The YES must come within 30 minutes.
  Pass if: Callum is only added after the YES.

---

## 4. Other things you will see

These are not Friday features, but they will appear during the week:

- A DM to the admin channel when a new number joins MT Test: "🆕 New player joined *MT Test FC* on WhatsApp."
- The morning after the match, from 08:00: rating links by DM to everyone who played, and a group post about them.
- Two days after the match at 18:00: a badge post, if anybody earned a badge.

---

## 5. Timed things

| What | When it fires | Can it be brought forward safely? |
|---|---|---|
| First match is created | Overnight run, 01:00 UK time (midnight after 25 October), for the next Friday that is not today | No. Do not use the "Generate match" button, see Known gaps, item 3 |
| Opening announcement (8) | 09:00 to 12:59, more than 24 hours before kickoff, squad empty | No |
| Learned setup (3) | Checked every 15 minutes for 3 days after approval. DM only 10:00 to 20:00 | No |
| Drop-out reminder (10, 17) | 3 hours before the deadline, never before 09:00 | Yes. Set the deadline to today, a little ahead. It is then due at once. The deadline must be 10:00 or later |
| Admin summary (10, 17) | First check after the deadline, 08:00 to 21:59 | Yes. Set the deadline to today, a few minutes ahead |
| Final list (10, 17) | First check after the publish time, 08:00 to 21:59, once per match | Yes. Set the publish time to today, a few minutes ahead |
| Daily 17:00 post (12) | 17:00 to 17:59 | No |
| "Match in trouble" (13) | 18:00 to 18:59 the day before | No |
| Match day chases (14) | 08:00, then 3 to 4 hours before, then 2 hours before | No |
| Pick message (19) | Within a minute of a free place plus somebody waiting, 08:00 to 21:59, after the deadline | Yes, it is driven by what you do |
| Pick with no answer (22) | 24 hours after the message, or 4 hours before kickoff if sooner, never less than 1 hour | Yes. Open the pick within 5 hours of kickoff and it closes after 1 hour |
| Bench offer (18, 22) | Within a minute of the drop, 08:00 to 21:59 | Yes, it is driven by what you do |
| Payment poll (15) | Kickoff plus 60 minutes | No |
| Rolling squad carry-over (16) | 08:00 the morning after the match | Yes. Once the match is finished (about 15 minutes after the poll), open NEXT Friday's match page and press "Carry over last squad". It must have nobody on it yet |
| Rolling announcement (16) | 09:00 to 12:59 after the carry-over | No |
| Unpaid reminder and admin list (23) | 10:00 two days after the match. Retried 10:00 to 20:59 for 3 days | No |
| Free month card reminders | Day 21 and day 28 after approval, by DM to you | No |
| AI allowance notice | When the club has used $2.00 of AI in one day (first 30 days), then $1.50 | No safe way. Do not try to reach it |

What the AI allowance does if reached: a plain IN or OUT is still recorded, questions go unanswered until midnight, scheduled posts carry on, and the admin group gets one message starting "⚠️ MatchTime has used today's AI allowance for *MT Test FC*." A normal test week uses a few pence.

---

## 6. Known gaps that are not test failures

1. **"Offer it to the waiting list" with many open places.** When nobody picks in time, that option opens one offer for EVERY open place. With 16 places open and one person waiting, the group gets the same "A slot just opened" post many times (three every five minutes) and the waiting player gets a DM for each. In this test keep the setting on "Leave it open". Only try the other option with exactly one place open. Reported as a finding for the real group.
2. **Two introductions after approval.** The code queues the hello and also the older one time introduction ("👋 Hi all, MatchTime bot is live for this group.") for the same moment. Reported as a finding.
3. **"Generate match" button on the Activities page.** Until the clocks change on 25 October it creates the match one hour late. Use the overnight run.
4. **A thumbs up does not claim a bench place.** MatchTime asks for a reply "IN", because it cannot read reactions at the moment.
5. **Two admins picking at the same instant, and a second player being told "someone got there first".** Both need a squad with exactly one place open, which is not practical with three phones. Both are covered by automated tests.
6. **The first week of a rolling squad is built by hand.** MatchTime has no earlier match to copy, so week one needs INs or picks. It rolls from week two.
7. **A late drop-out is only reported when rolling squad is on.** The help text on the Drop-out deadline setting says the admins are always told.
8. **A player who says nothing and does not turn up stays on the list.** He would be carried over, and counted as unpaid. Remove a no-show on the match page before 08:00.
9. **If you linked the admin group while MatchTime was already in it**, Settings shows "Linked: WhatsApp" instead of the group's name.
10. **One week's kickoff time cannot be moved.** Changing the weekly game on the Activities page only changes matches created afterwards.

---

## 7. Cleanup and handover

### Does this test touch Sutton Football Club? Checked in the code.

- Every group post, tick and scheduled message is tied to the group it happens in. Nothing in MT Test or the admin group can reach Sutton's group.
- Every setting on the website is saved for the club shown at the top of the side menu. Rule 3 in section 1 is the only risk.
- DMs from phone A are the one path that can reach Sutton. Rules 1 and 2 in section 1 close it.
- Sutton cannot be switched off, rejected or left from the Clubs page. It CAN be deleted from the Organisations page, see below.

### Does this test touch real money? Checked in the code.

- **Match fees:** none. "Collect match fees (Stripe)" stays off and the test club has no bank connected. Payment tracking only posts a poll and counts votes.
- **Club fee:** approval starts a free month of 30 days. You get card reminders by DM on day 21 and day 28. With no card saved, day 30 starts 7 days of grace, and on day 37 the club is paused: MatchTime goes quiet in MT Test. Nothing is charged at any point, because a charge needs a saved card and a month with no card is closed as "no card" with no invoice.
- The only way to be charged is to press "Add a card" on the club fee page and save a real card. Do not.
- If you will keep the club for more than three weeks: on matchtime.ai/admin/clubs set its plan to "Free". It is then never billed, never reminded and never paused.

### After this test: the monthly script prefers a fresh club

The monthly squad script (`MDs/vets-monthly-test-scenarios-2026-10-06.md`) recommends deleting this club and creating a new one for MT Test, because the Friday settings and old Friday games get in the way of a Monday monthly setup. So the usual path is "delete the club and start again" below. Keeping the club is the fallback.

### Fallback: keep the club for the monthly test

Leave in place:
- the club, approved and attached to MT Test
- the admin group, linked (do not press "Unlink": MatchTime leaves the group when you do)
- the players, and MatchTime in both groups

Reset before handing over:
- "Who fills an open place": "First to say IN"
- "If nobody picks in time": "Offer it to the waiting list"
- "Drop-out deadline" and "List published": press "Clear" on both
- Rolling squad and Payment tracking: leave as they are and tell whoever runs the monthly test, so they set them as their script says
- Take phone B out of the admin group
- Note for the next tester: next Friday's match already exists and has the carried-over squad on it

### Or: delete the club and start again

1. Open matchtime.ai/admin/organisations.
2. On the TEST club's row press "Delete", type its web address name (shown under the club name), and press "Delete forever".
3. **Sutton Football Club is on the same page with the same button. Read the name twice.**

After deleting, MatchTime is still a member of MT Test and of the admin group, attached to nothing, and says nothing. A new club then has to follow Step 1 to Step 3 again, including removing MatchTime and adding it back.

Do not use "Turn off" on the Clubs page for cleanup: MatchTime leaves MT Test when you do.

---

## 8. Not confirmed

1. What chat WhatsApp hands over when MatchTime is added back to MT Test, so which of the three outcomes in scenario 3 you get.
2. Whether MatchTime is in your admin group today.
3. What a plain "IN" does in the hours after approval, before the first match exists. Wait for the match.
4. That both introductions in Known gaps item 2 really arrive. Traced in the code, not seen live.
5. That "Generate match" is one hour out. Traced in the code, not run.
6. The repeated posts in Known gaps item 1. Traced in the code, not run.
7. That "Delete forever" completes for a club that has used every new feature. The database rules were read, the delete was not run.
8. What a number reply does when the waiting list has changed since the last pick message. Use names.
9. Whether a second late drop-out by the same player in the same week is reported again (scenarios 18 and 21 may or may not produce the line).
10. The exact words of any reply written by the AI (questions, and match day chases with rolling squad off).
11. A full run where the organiser signs up on a borrowed phone and you only approve. The steps are the same, but that route was not traced end to end.

---

## Appendix: where each fact was read

| Area | Files |
|---|---|
| Plan | `MDs/friday-group-features-plan-2026-09-30.md`, `MDs/self-join-and-approval-plan-2026-09-28.md`, `MDs/club-fee-billing-plan-2026-10-01.md`, `MDs/session-handoff-2026-10-05.md` |
| Club creation, connect, add | `src/lib/self-join-club.ts`, `src/lib/club-connect.ts`, `src/lib/connect-dm.ts`, `src/lib/group-add.ts`, `src/lib/group-add-rules.ts`, `src/app/api/whatsapp/bot-added/route.ts`, `whatsapp-bot/src/bot-added.ts` |
| Approval, hello | `src/lib/club-approval.ts`, `src/lib/club-decision-rules.ts`, `e2e/api/self-join-decisions.spec.ts`, `e2e/web/admin-clubs.spec.ts` |
| Learned setup | `src/lib/setup-learning/run.ts`, `rules.ts`, `dm.ts`, `view.ts` |
| Admin group | `src/lib/admin-group-link.ts`, `src/lib/admin-group.ts`, `src/lib/admin-channel-rules.ts`, `whatsapp-bot/src/index.ts`, `e2e/api/admin-group.spec.ts` |
| Rolling squad, deadlines | `src/lib/rolling-squad.ts`, `src/lib/rolling-squad-rules.ts`, `src/lib/weekly-deadlines.ts`, `src/lib/deadline-summary.ts`, `src/lib/attendance.ts` |
| Organisers pick | `src/lib/organiser-pick.ts`, `src/lib/organiser-pick-rules.ts`, `src/lib/squad-capacity.ts`, `e2e/api/organiser-pick.spec.ts` |
| Scheduled posts, bench, payments | `src/lib/bot-scheduler.ts`, `src/lib/roster-shown.ts`, `src/lib/unpaid-rules.ts`, `src/lib/unpaid-list.ts`, `src/lib/dispatch-claim.ts`, `whatsapp-bot/src/smart-analysis.ts` |
| Help, DMs from your number | `src/lib/dm-help.ts`, `src/lib/dm-qa.ts`, `src/lib/dm-registration-target.ts`, `src/app/api/whatsapp/dm-reply/route.ts` |
| Money and AI | `src/lib/club-billing-rules.ts`, `src/lib/club-billing-months.ts`, `src/lib/ai-cap-notice.ts`, `src/lib/ai-budget.ts` |
| Wording | `src/lib/i18n/strings.en.ts` |
| Cleanup | `src/lib/wipe-org.ts`, `scripts/wipe-org.ts`, `src/app/actions/org.ts`, `src/app/actions/activities.ts` |
