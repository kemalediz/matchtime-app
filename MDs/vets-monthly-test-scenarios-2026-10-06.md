# Monthly squad: manual test script for the Vets style group

Written 2026-10-06 for Kemal. Test group: "MT Test". Game: Monday, 7 a side, 20:00.

Every expected result below was traced in the code or in an automated test. Where a result could not be traced, it is in "Not confirmed" at the end, not in a scenario.

Wording marked **exact** is copied from the English copy in the code. Wording marked **shape** is built from live data (names, dates, amounts), so yours will differ in those parts only.

Dates assume you start on Tue 6 or Wed 7 Oct 2026. October 2026 has four Mondays (5, 12, 19, 26). November has five (2, 9, 16, 23, 30).

---

## 0. Read this first

### Three safety rules

1. **Never send IN, OUT, yes or a thumbs up to MatchTime by direct message from your own phone during this test.** You are in Sutton Football Club too. A direct message like that goes to whichever of your clubs has the soonest game, so it can change your place in the real Sutton game. Typing in the MT Test **group** is always safe. This script asks you for only two kinds of direct message from your own phone: ones that start with the word PAID, which only a monthly club reads, and the single `yes` in scenario 22, which is safe there because a fee question is waiting and is answered first.
2. **Borrowed phones must not belong to Sutton players.** The same rule applies to them, and a player record is shared between clubs.
3. **Check the club name under the "Admin" heading before you press anything.** As the platform owner you can act on any club. A link in a MatchTime message for Sutton, or a new browser, quietly switches you back to Sutton. Switch back with the club switcher in the sidebar.

### How MatchTime's clock works

| Thing | When |
|---|---|
| Group posts and direct messages | Only 08:00 to 21:59 London time. Anything due at night waits for 08:00. |
| How fast a post appears | The Pi asks for work about every 30 seconds. Allow a minute or two. |
| Direct messages | One a minute across everyone. Five messages can take five minutes. |
| The list after a change | Not within 30 minutes of the last list MatchTime posted. Changes inside that time are posted together. |
| The collector's "who says paid" message | Once a day, from 10:00. A claim made after today's message waits for tomorrow's. |
| Regulars put on next week's game | 08:00 the morning after a game. |
| Month close | The morning after the month's last game, from 08:00. |

### People in this script

All invented. Add the fifteen name only players on the Players page with a **name only** (no phone). They never answer, which is fine.

- Name only: Alex Stone, Chris Vale, Dan Ford, Ed Marsh, Finn Cole, Gus Hale, Hal Brook, Ian Moss, Jake Dunn, Luke Shaw, Noah Pike, Pete Lyle, Quin Ash, Rob Dale, Tom Reeve.
- **You**: owner, organiser and money collector. The script calls you "Kemal".
- **Ben**: borrowed phone 1. **Omar**: borrowed phone 2. Do not rename them. Use the names the Players page shows for those two phones wherever this script says Ben or Omar.
- Every first name must be different. A pasted list matches by whole name, known nickname or first name, and a first name shared by two players matches nobody.

### Phones

- Scenarios 1 to 15: your phone only.
- Scenarios 16 to 19: one borrowed phone (Ben).
- Scenario 20: two borrowed phones (Ben and Omar).
- Scenarios 21 to 24 happen on set days. Phones are noted on each.

---

## 1. Setup

By the time you get here MT Test is attached to an approved test club from the Friday group test, with an admin WhatsApp group linked. There are two ways to continue.

**Recommended: Route A, delete that club and make a fresh one.** Reasons:

- The Friday test leaves rolling squad, organisers pick, weekly deadlines and old games behind. Changing the game day on an existing game also moves its old games onto the new day, so the month can attach to the wrong game.
- Learned setup reads the chat once per club, ever. Only a fresh club can show you what it does with a monthly list (scenario 15).
- With no admin group linked, every organiser message comes to you by direct message, which is the path the automated tests cover.

Use Route B only if the existing test club already plays Monday at 20:00, 7 a side, and you do not need scenario 15.

### Route A: fresh club (about 20 minutes, plus one overnight wait)

1. **Optional, for scenario 15.** While MatchTime is still in MT Test, post at least 20 messages there from at least 3 different phones. Include two or three posts that begin "List for October:" with numbered names, and lines like "paid for the month", "PAYG £8" and "one game in credit". Do not restart the Pi between this step and step 6.
2. On matchtime.ai/admin/organisations, delete the old test club (you type its slug to confirm). If the delete fails, tell the engineering session; do not retry.
3. Open **matchtime.ai/create-org**. Fill in: Club name "MT Vets Test", Day Monday, Kick-off time 20:00, any Venue, Players per side 7. Press "Create club". Check the heading shows the new club.
4. On the admin home page press "Add MatchTime to WhatsApp" and send the message that opens, from your own phone. Wait for the reply that begins "Hi Kemal, got it: MT Vets Test is connected to this chat." (**exact** start).
5. In MT Test, remove MatchTime from the group.
6. Add MatchTime back, from the same phone. You get "Thanks, I'm in "MT Test"." and, as the approver, "New club waiting: *MT Vets Test* (ref XXXX)" (**exact** starts).
7. Reply `APPROVE XXXX`, or press "Approve MT Vets Test" on matchtime.ai/admin/clubs. The hello appears in the group within about 6 minutes: "👋 Hi everyone, I'm *MatchTime*." (**exact** start).
8. Add the borrowed phones to MT Test now if you have them, so they become players.
9. Carry on at "Both routes" below.

### Route B: reuse the existing test club

On Settings (matchtime.ai/admin/settings):

1. "Who fills an open place": choose "First to say IN". With "The organisers pick", open places are never offered to pay-as-you-go players and the list says the organisers will pick.
2. "Drop-out deadline" and "List published": press "Clear" on both, to keep the test simple. (Since 6 Oct a month's game no longer gets the weekly style reminder and list even when they are set.)
3. Rolling squad: leave it. Switching to Monthly turns it off for you (scenario 1).
4. Admin group: you can leave it linked. Organiser messages then go to that group, not to you by direct message. The collector's message still comes to you directly once you are the collector.
5. On Activities, check the game is Monday 20:00, 7 a side. If it is not, use Route A.

### Both routes

1. **Players.** On the Players page, press "Add player" and add the fifteen name only players. Check Ben and Omar appear with their phone numbers.
2. **Payments, with no Stripe.** On Settings, under "Bot features":
   - switch on "Collect match fees (Stripe)";
   - switch off "↳ Pay by Bank" and "↳ Card / Apple Pay";
   - leave "↳ Pay organiser directly" on;
   - under "Money collector's bank", choose yourself as "Money collector";
   - **do not press "Connect bank".** Without it no card or bank payment can be offered at all.
3. **The first game.** A game for Mon 12 Oct must exist. MatchTime creates it overnight (about 01:00). If you set up in the evening and test the next day, it is there. The "Generate match" button on Activities also makes it (its summer time fault was fixed on 6 Oct; check the kick-off shows 20:00).
4. **Club fee.** A newly approved club starts a free month of 30 days. Nothing is charged, no card is asked for and nothing is created in Stripe during it. The first message about the fee comes on day 21. To silence it, set the plan to "Free" on matchtime.ai/admin/clubs. Delete the club before day 21 and you will never see it.

---

## 2. Scenarios you can do alone, today

Do them in order. Each one builds on the one before.

### - [ ] 1. Switch the club to Monthly

**Proves:** the mode is off until you switch it on, and switching turns rolling squad off.

1. Settings, section "Monthly squad". "How your squad works" reads "Weekly (who said IN)".
2. Choose "Monthly (regulars pay for the month)".
3. Set "PAYG price per game (£)" to 8 and "Payment instructions" to "Bank details are in the group description". Leave "Credits" on "Every game a paid regular misses". Press "Save".

**Expected (exact):** a toast "Monthly squad is on. Rolling squad is off." A note appears: "Rolling squad is switched off while your squad is monthly: the month's regulars take its place." The Rolling squad row disappears from "Weekly routine". A "Months" page appears in the admin pages. Nothing is posted in the group.

**Pass if:** the toast shows and matchtime.ai/admin/months opens.

### - [ ] 2. Start October part way through, from a pasted list

**Proves:** a paid mark on a list is only ever "Says paid", names under "Paid but can't play" are read as paid regulars and not as extra playing names, an unknown name creates nobody.

1. On Months you see "October 2026 hasn't been started yet". Paste this into "Paste your current list", with your own first name on line 1, and press "Read the list":

```
List for October:

1. Kemal (paid £30)
2. Alex (Paid £30)
3. Chris paid
4. Dan (paid 22.50)
5. Ed
6. Finn (paid)
7. Gus (paid)
8. Hal (paid)
9. Ian (paid)
10. Noah (PAYG)
11.
12. Zed

Paid but can't play
1. Jake
2. Luke
```

2. Check what was read, then change three things in the table: set Alex to "Paid, confirmed", type 1 in "Credits carried in" for Dan, and type 7.50 in "Regular's share per game (£)". "Games this month" should read 4 and "Already played" 1.
3. Press "Start October 2026".

**Expected (exact):** after step 1, "Players read from your list: 12. Check them below before you start the month." and "Not matched to a player: Zed. Tick them below yourself, or add them on your Players page first." The count reads "On the list: 11 regulars, 1 PAYG". Everybody with a paid mark shows "Says paid", Jake and Luke included. Ed shows "Not paid". Noah shows PAYG.

After step 3: a toast "October 2026 is started", the status "Running", and "Started part-way through the month. Games already played then: 1." Dan is due £22.50 (4 games less 1 credit). Ed is due £30. Zed is not on the Players page.

**Pass if:** nobody except Alex reads "Paid, confirmed", and no player called Zed exists.

### - [ ] 3. The week's list appears, regulars in by default

**Proves:** the regulars are put on Monday's game without saying IN.

1. Wait a minute or two (between 08:00 and 21:59). Do nothing.

**Expected (shape):** one group message in the group's own format.

```
📋 List for October: Mon 12 Oct, 20:00

1. Kemal (paid)
2. Alex Stone (paid)
3. Chris Vale (paid)
4. Dan Ford (paid)
5. Ed Marsh
...
10.
11. Jake Dunn (paid)
12. Luke Shaw (paid)
13.
14.

3 places open, £8 PAYG: say *IN* to take one.
```

Names are as the Players page writes them. Ed has no "(paid)". Noah is not on it: a pay-as-you-go player with no dates plays only when he says so. Jake and Luke take the next free numbers. No "Say IN to join" announcement and no 17:00 squad post follow.

**Pass if:** eleven names are on the list and you typed nothing.

### - [ ] 4. The collector's daily message, and words that must not confirm money

**Proves:** only "PAID" and numbers confirm; a stray word or a wrong number confirms nobody.

1. Wait for a direct message from MatchTime. It comes at 10:00, or within minutes if it is already after 10:00.
2. Reply `all`. Then reply `1 3`.
3. Reply `PAID 3 5`.
4. Reply `PAID 3`.

**Expected:** the message (**shape**): "💷 9 say they've paid for October:" then one line each, such as "3. Chris Vale £30", then (**exact**) "Reply *PAID ALL*, or *PAID* and the numbers that arrived (PAID 1 3), or *PAID NONE*." Alex is not on it (already confirmed). Ed is not on it (has not said paid).

After step 2 nobody is confirmed. After step 3 (**exact**): "I have no "says paid" at number 5 on the October list, so I marked nobody. Reply *PAID* and the numbers from my last message." Chris is still "Says paid". After step 4 (**exact**): "✅ Marked as paid for October: Chris Vale."

**Pass if:** the Months page shows Chris as "Paid, confirmed" only after step 4.

### - [ ] 5. A regular drops out for one week, then comes back

**Proves:** a paid regular who is out earns one game of credit, is listed under "Paid but can't play", and loses the credit again if he plays after all.

1. In the group, type `OUT`.
2. Wait for the next list (it may wait until 30 minutes after the last one).
3. Open Months, then "Credits ledger".
4. In the group, type `IN`. Check the ledger again.

**Expected:** the new list has line 1 blank, a section "Paid but can't play" with "1. Kemal" under it, and "4 places open, £8 PAYG: say *IN* to take one." (**exact** wording). The ledger shows you with "1 game available" and the reason "Paid, could not play". After step 4 you are back at number 1 and the credit reads "Taken back: they played after all, or the game was back on".

**Pass if:** one credit appears, then is taken back, and you kept number 1.

### - [ ] 6. The organiser pastes the list back with changes

**Proves:** a pasted list changes the squad by name, a "(paid)" written for somebody else is a claim only, and MatchTime reads it without replying.

1. Copy MatchTime's latest list from the group. Edit it:
   - cut "Gus Hale (paid)" from line 7, leave "7." blank, and add a section at the bottom: `Paid but can't play` then `1. Gus Hale`;
   - blank line 8 (Hal) and put his name nowhere;
   - add `(paid)` after Ed Marsh.
2. Paste it in the group with its title line.

**Expected:** MatchTime ticks your message with ✅ and says nothing. Months shows Ed as "Says paid". The next list has 7 and 8 blank and both Gus Hale and Hal Brook under "Paid but can't play". Each has one credit in the ledger. Gus and Hal get no message because they have no phone (scenario 18 shows that message).

Blanking somebody else's line works here because you are an organiser. From an ordinary player it is ignored.

**Pass if:** Gus and Hal are out, Ed says paid, and nobody was confirmed as paid.

### - [ ] 7. "PAID ALL" must not confirm a claim you were not shown

**Proves:** the reply only ever confirms the people listed in the last daily message.

This only works if you did scenario 6 after today's message had arrived, so that Ed's claim is newer than the message. If you did scenario 6 first, Ed is on the message and is confirmed with the rest: wait a day and repeat with another name.

1. Reply to MatchTime: `PAID ALL`.

**Expected (shape):** "✅ Marked as paid for October: Kemal, Dan Ford, Finn Cole, ..." naming the people from this morning's message who were still waiting. **Ed Marsh is not in it** and still reads "Says paid". He is on tomorrow's 10:00 message. If you then answer that one with `PAID NONE` you get (**exact**): "Noted: nothing has arrived yet for October from Ed Marsh. I won't ask about these again. Confirm them on the Months page when the money arrives."

**Pass if:** Ed is still "Says paid" after PAID ALL.

### - [ ] 8. An old copy of the list cannot undo the week

**Proves:** a paste never brings back a player who dropped out.

1. Scroll up to the first list MatchTime posted (scenario 3), copy it and paste it in the group unchanged.

**Expected:** no ✅ and nothing changes: Gus and Hal stay out. The organisers get one note, at most once a day (**shape**): "📋 Kemal pasted an older copy of the list for Mon 12 Oct, 20:00. I left Gus Hale, Hal Brook as they were: a pasted list cannot bring back a player who dropped out, or take out somebody else by blanking their line. If the change is right, the player can say so, or you can make it on the match page."

**Pass if:** Gus and Hal are still under "Paid but can't play".

### - [ ] 9. A numbered list that is not the squad list creates nobody

**Proves:** the phantom player bug is closed.

1. Paste this in the group:

```
Kit for Monday:
1. Bibs
2. Two balls
3. Cones
4. Pump
5. First aid bag
```

2. Copy the latest squad list, add a line `13. Zed` and paste it.

**Expected:** after step 1 the squad is unchanged and the Players page has nobody called Bibs, Cones or Pump. You get one direct message, once a day (**exact**): "📋 I couldn't read the list you posted as the squad list for October, so I changed nothing. If it was the squad list, paste it with its title line ("List for October")."

After step 2 nobody is added. You get (**shape**): "📋 Kemal pasted the list for Mon 12 Oct, 20:00 with Zed on it. I could not match that to a player on this month's list, so I added nobody. A player can say *IN* in the group themselves, or you can add them on the match page."

**Pass if:** the Players page has no new names.

### - [ ] 10. The credits page

**Proves:** credits are added and removed with a reason and nothing is ever deleted.

1. Months, "Credits ledger", "Add credit": Player Finn Cole, Games 1, Reason "missed 5 Oct, before we started here". Press "Add credit".
2. Add one for Ian Moss the same way. Then press "Remove credit" on it, type a reason, press "Remove".
3. Try to add a credit with the reason "x".

**Expected (exact):** Finn shows "1 game available", reason "Added by an organiser", state "Available". Ian's credit stays on the page as "Removed by an organiser" with your reason. Step 3 is refused with "Give a reason of 3 to 200 characters."

**Pass if:** Ian's removed credit is still visible and Finn's is available.

### - [ ] 11. Open November's list early

**Proves:** the month's list is posted with this month's regulars already on it. Normally it opens 7 days before the month's first game (Mon 26 Oct, 10:00).

1. Settings, "Monthly squad", "List opens": type 28, press "Save".
2. Wait a minute or two.

**Expected (shape, footer exact):**

```
📋 List for November (5 Mondays: 2, 9, 16, 23, 30)

1. Kemal
2. Alex Stone
...
12.
13.
14.

Regulars from October are on already. Not in for November? Say *OUT FOR NOVEMBER*.
Want a place for November? Copy the list and add your name, or say *IN FOR NOVEMBER*.
Playing some weeks only? Add your name with (PAYG), or (PAYG 9 only).
Or sign up here: (link to the month page)
Names in by Sat 31 Oct, 20:00. Price and payment details follow once numbers are in.
```

October's eleven regulars are on it, numbered again from 1. Gus and Hal are on it (they are only out this week). Noah is not: pay-as-you-go players are not carried over. Months shows a second card, "Next month: November 2026", status "Sign-up open". Put "List opens" back to 7 afterwards; it does not close the list.

**Pass if:** the list arrives with eleven names and nobody typed anything.

### - [ ] 12. Join and leave November, in the group and on the page

**Proves:** the typed phrases and the page both change the month, and a plain IN does not.

1. In the group type `OUT FOR NOVEMBER`. Then `IN FOR NOVEMBER`.
2. Open matchtime.ai/month in your browser. On the November card press "Not this month", then "Pay as you go" with the 9th and 23rd ticked, then "I'm in for the month".

**Expected:** each typed phrase gets a ✅ and no reply. The list is posted again when it has changed (30 minute rule), without you after the first and with you after the second. On the page the line reads in turn (**exact**): "You are not on this month's list.", "You are pay-as-you-go on 9, 23.", "You are in for the month, number 1 on the list." (your number may differ if 1 was taken meanwhile).

The page shows "not found" if your browser is on Sutton. Switch club first.

**Pass if:** Months shows you as a Regular for November at the end.

### - [ ] 13. Set November's price, with a credit taken off

**Proves:** the suggested price, each regular's amount, credits used once, and credits earned after pricing waiting for the month after.

1. On the November card, "Price for the month": type 80 in "Venue cost per game (£), optional".
2. Type 7.50 in "Share per game (£)". Leave "Pay by (London time)" as offered (Fri 30 Oct, 21:00). Press "Set the price".
3. Go to the ledger and add one more credit for Finn. Come back, move the pay-by time by a minute and press "Update the price".

**Expected:** after step 1 (**exact**): "Suggested: £7.50 a game (the venue cost over your regulars, rounded up to 50p)." If the club is not on the Free plan, a tip under the form (**shape**): "MatchTime charges the club up to £9.99 a month, only for games played. For 11 regulars and 5 games, adding 20p a game (£1 for the month) to each regular's share covers it."

After step 2 every regular shows Games 5 and Due £37.50, except Finn: Credits used 1, Due £30. Your own credit from scenario 5 was taken back, so it is not used. The group gets one message (**shape**):

```
📋 List for November: £7.50 a game, pay Kemal by Fri 30 Oct, 21:00
(5 games = £37.50. Credits are already taken off.)

1. Kemal (£37.50)
...
6. Finn Cole (£30)
...

Payment: Bank details are in the group description.
Paid? Add (paid) after your name and paste the list, or DM me "paid".
```

After step 3 Finn is still due £30. The second credit stays "Available" for December. Because the pay-by time changed, the priced list is posted once more.

**Pass if:** Finn is due £30 before and after step 3.

### - [ ] 14. Say paid on the page and by pasted list, then confirm on the pages

**Proves:** every "paid" is a claim, only the collector confirms, and the share locks once somebody has paid.

1. On matchtime.ai/month, November card, press "I've paid".
2. Copy the priced list from the group, add `(paid)` after Jake Dunn and Luke Shaw, paste it.
3. On Months, press "Confirm paid" on your own November row. Then "Undo". Then "Confirm paid" again.
4. Open matchtime.ai/month/collect and press "Confirm paid" for Jake.
5. On the November price form, try to change the share.

**Expected (exact):** the page shows "£37.50 for 5 games." and "Pay Kemal by bank transfer by Fri 30 Oct, 21:00.", then after the button "You have said you paid. The collector confirms when it arrives." The paste gets a ✅ and Jake and Luke read "Says paid". This paste does not change who plays this week. "Confirm paid" turns a row to "Paid, confirmed (£37.50)" and "Undo" returns it to "Says paid". The collector page is titled "Payments to confirm". The share field is locked with "Somebody has paid, or says so, so the share is locked. You can still move the pay-by date." Under it is "Change the share after payments", which needs a tick before it works.

Luke's claim goes on the next daily message. If October also has one waiting, name the month in your reply: `PAID NOVEMBER ALL`.

**Pass if:** Luke reads "Says paid" and never "Paid, confirmed" until you confirm him.

### - [ ] 15. What learned setup did when the club was approved

**Proves:** reading the chat never switches a club to Monthly by itself.

Only on a club made by Route A with step 1 done. It ran once, within 15 minutes of approval, before you did scenario 1.

1. Find the direct message that begins "I read the recent messages in "MT Test" to see how it runs" (it is sent between 10:00 and 20:00).
2. Open Settings and look at the panel "Set up from your group chat".
3. Open matchtime.ai/admin/clubs and find the line "Learned setup" for the club.

**Expected (exact):** if it saw the monthly lists, the message contains "📋 I also noticed a monthly list:" followed by what it saw, then "MatchTime has a monthly squad mode for groups like this. I haven't switched it on: you can do that in Settings, under Monthly squad, if you want it. Until you do, nothing changed for it". The Settings panel lists it under "Noticed, left for you to decide" as "Monthly list". **It did not switch the club to Monthly**: before scenario 1 the setting read "Weekly (who said IN)". With a strong monthly signal it switches nothing else on either.

If the chat had under 20 messages or under 3 writers, there is no message and no panel, and the clubs page reads "Chat not read: too-short". That is a pass too.

**Pass if:** the club was still Weekly until you switched it yourself.

---

## 3. Scenarios with one borrowed phone (Ben)

### - [ ] 16. A player joins October part way through

**Proves:** a late joiner is a regular from the next game and pays only for the games left.

1. From Ben's phone, in the group, type `IN FOR OCTOBER`.

**Expected:** a ✅. Ben gets a direct message (**shape**): "👋 Ben, you are in for the rest of October: 3 games, £22.50. Pay Kemal by bank transfer, then DM me "paid"." You get (**shape**): "📋 Ben joined October part-way: 3 games, £22.50 to pay." with a link. Months shows Ben as Regular, Games 3, Due £22.50, at the lowest free number. He is on the next list for Mon 12 Oct with no "(paid)".

**Pass if:** Ben is charged for 3 games, not 4.

### - [ ] 17. "paid" by direct message, and a paid player cannot move himself

**Proves:** the DM is a claim, and somebody who says he has paid cannot change his own place.

1. From Ben's phone, in the group, type `IN FOR NOVEMBER`.
2. From Ben's phone, send MatchTime a direct message: `paid`.
3. From Ben's phone, in the group, type `OUT FOR NOVEMBER`.

**Expected:** step 1 gets a ✅ and Ben is due £37.50 for November. Step 2 is answered (**shape**): "✅ Ben, noted: you say you have paid £37.50 for November. Kemal will confirm when it arrives." Months shows "Says paid". Step 3 gets no ✅ and Ben stays on the list. He is told (**exact**): "📋 You have told me you paid for November, so I have not changed your place. Ask an organiser if it needs changing."

A `paid` direct message for October (a month started part way) is also read as "Says paid" since the fix of 6 Oct.

**Pass if:** Ben is still a November regular, reading "Says paid".

### - [ ] 18. The undo message when somebody else changes your line

**Proves:** a player moved by another person's paste is told, with one word to undo it.

1. From your phone, copy the latest October list, blank Ben's line, add him under a section `Can't play`, and paste it.
2. Read Ben's phone. Reply `IN` from Ben's phone, by direct message.

**Expected:** a ✅ on your paste. Ben gets (**shape**): "📋 Kemal took you off the list for *Football 7-a-side* on Mon 12 Oct, 20:00." then (**exact**) "Wrong? Reply *IN* and I'll put you back." The list shows Ben under "Can't play", not "Paid but can't play", because he has not paid for October. After his IN he is back at his own number.

If Ben had said paid for October, the message would read "moved you to "Paid but can't play"" in place of "took you off the list".

**Pass if:** Ben gets the message and one word puts him back.

### - [ ] 19. A leaver is owed the games left, counted once

**Proves:** a paid regular who leaves is owed one game for each game left, and a game he already has a credit for is not counted twice.

Do this before Mon 12 Oct, 20:00. Alex is "Paid, confirmed (£30)".

1. Paste the October list with Alex moved under "Paid but can't play". Check the ledger: Alex has 1 credit.
2. On Months, October card, press "Remove for the month" on Alex.
3. Look at "Left part-way through" and at Alex in the ledger.
4. In "Refunded (£)" type 40 and press "Record refund". Then type 22.50 and press it again.

**Expected (exact):** "Left part-way through" lists "Alex Stone" with "Owed: 3 games (£22.50)". The ledger shows three available credits for him: one "Paid, could not play" and two "Left part-way". **Not four.** The 40 is refused with "A refund cannot be more than they paid for the month." The 22.50 is accepted: Alex reads "Nothing owed" and "Refunded £22.50", and his three credits read "Refunded". No message goes to Alex and no money moves.

You are not sent a notice for this one, because you pressed the button yourself. A notice goes out only when somebody leaves the WhatsApp group by himself.

**Pass if:** Alex is owed 3 games, never 4.

---

## 4. Scenario with two borrowed phones

### - [ ] 20. A pay-as-you-go player takes a place, then the waiting list

**Proves:** open places go to pay-as-you-go players at £8, they take a regular's empty number, and when the squad is full the next person waits.

1. On Months, October card, "Add a player": add Omar with "Add as PAYG".
2. Wait a few minutes and read Omar's phone.
3. From Omar's phone, in the group, type `IN`.
4. Fill the remaining places. On Months add Pete Lyle, Quin Ash, Rob Dale and Tom Reeve with "Add as PAYG". Then paste the latest list with Noah Pike, Pete Lyle and as many of the others as it takes typed into empty numbers, until the list shows no "places open" line. Keep one of them spare.
5. From Ben's phone, type `OUT`. Paste the list again with the spare name typed into Ben's empty number. Then from Ben's phone type `IN`.
6. From your phone, in the group, type `OUT`.

**Expected:** after step 2 Omar has one message (**shape**): "👋 Omar, a place has opened for *Football 7-a-side* on Mon 12 Oct, 20:00, £8 pay-as-you-go." then (**exact**) "Want it? Reply *IN*. The first to say so plays. Not this time? No need to reply." He gets it once per game, however many places are open.

After step 3 Omar is on the list at the lowest empty number, marked "(PAYG)". The names you write in at step 4 are accepted because they are on the month's list as pay-as-you-go.

After step 5 Ben is on the waiting list: his place was taken while he was out and the squad is full, so the list shows him under "Reserves". After step 6 your place is offered to the waiting list first, not to the pay-as-you-go players: the group gets (**exact** start) "🎟 A slot just opened" with Ben tagged, and Ben gets a direct message that begins "👋 Hi Ben, a slot just opened". When Ben says IN he plays.

**Pass if:** Omar shows "(PAYG)" in a numbered place, and Ben is offered your place before anybody else.

---

## 5. Scenarios that happen on a set day

There is no safe way to bring any of these forward. The clock can only be moved in the test harness, not in production.

### - [ ] 21. The same list is not posted twice (any day; your phone)

**Proves:** when somebody asks who is playing, MatchTime answers with the month's list and does not post the same list again by itself.

1. In the group, tag MatchTime and ask `who's in?`.
2. Watch the group for an hour without changing anything.

**Expected:** the answer is the month's list in the "📋 List for October" format, not the weekly "Confirmed" roster. No second copy follows. The list is posted again only when it changes, and once on match morning between 08:00 and 12:00 (later that morning if the group saw the same list in the three hours before).

The "not twice within 3 hours" fix itself covers the weekly style posts (the 17:00 post and the morning chase). A monthly club's running month does not send those, so it cannot be seen on this club. It is covered by automated tests.

**Pass if:** you see the list once.

### - [ ] 22. After Monday's game: the £8 for pay-as-you-go players (Mon 12 Oct, from about 21:00; two phones)

**Proves:** regulars are never asked to pay per game; only the pay-as-you-go players are.

Needs Omar (or another pay-as-you-go player with a phone) on the squad at kick-off.

1. Do nothing until the game has ended. Read your direct messages.
2. Reply `yes`.

**Expected:** no payment poll in the group. You get the fee question as a direct message. It names £8 per player and the number of pay-as-you-go players only, for example "1 player to charge", and ends (**exact**) "Reply *✅* (or "yes") to send everyone their pay link, or send a different amount to change it." After `yes` (**shape**): "✅ Done, sent 1 pay link at *£8* each for *Football 7-a-side*." Omar gets (**shape**): "💷 Omar, match fee for *Football 7-a-side* is *£8*." with a link. His pay page offers only paying the organiser directly, because no bank is connected. No regular gets a link.

**About a stray "ok".** Before this question arrives, a stray `ok` releases nothing: there is no amount waiting. Once the question has arrived, `ok` **is** a yes and sends the links. That is by design. The case the review fixed (an `ok` meant for another message, when the question was never delivered) cannot be produced by hand. It is covered by automated tests.

**Pass if:** only Omar gets a pay link.

### - [ ] 23. The next week is set up by itself (Tue 13 Oct, 08:00; your phone)

**Proves:** the regulars roll on to the next game, and a credit becomes real once the game is played.

1. After 08:00 on Tuesday, read the group.
2. Open the ledger.

**Expected:** a new list titled "📋 List for October: Mon 19 Oct, 20:00" with every regular back in, Gus and Hal included. Their credits for 12 Oct stay "Available": they did miss that game.

**Pass if:** the list for 19 Oct arrives without anybody typing.

### - [ ] 24. A cancelled game (any day after scenario 13; your phone)

**Proves:** a called off game gives every regular one credit, once, and restoring it takes the credit back.

1. Block bookings, "Bulk cancel / restore". Choose "Cancel matches". Set From and To to 30 Nov 2026, press "Find matches", tick "Announce to the group", confirm.
2. Look at the November card and the ledger.
3. Go back and choose "Restore cancelled matches" for the same date.

**Expected:** one cancellation message in the group that ends (**exact**) "Regulars get 1 game credit for it." A regular who has not paid has it taken off straight away: Due falls from £37.50 to £30 and Credits used rises by 1. A regular who has paid or says so keeps one "Available" credit with the reason "Game called off". After the restore, which posts nothing, the credits read "Taken back" and the amounts return to £37.50.

**Pass if:** each regular has exactly one credit for 30 Nov, and none after the restore.

### - [ ] 25. Sign up ends and the month closes (Sat 31 Oct and Tue 27 Oct; your phone)

**Proves:** the month closes once and the collector gets one summary.

- **Tue 27 Oct, from 08:00** (the morning after October's last game). October's status becomes "Closed". The organisers get one message (**shape**): "📒 October summary (4 games played)", then "Regulars: N. Paid and confirmed: N (£X).", lines for says paid, not paid, pay-as-you-go games, "Left part-way and owed", "Credits carried to a later month: N games (names)." and "Credits used this month: N games." The same lines are on the Months page under "Month summary". From November's page the link "Earlier: October 2026" opens it. You can still press "Confirm paid" on the closed month.
- If you answer October's last daily message after the close (**exact**): "October is closed, so I marked nobody. Confirm a payment that arrived late here:" with a link.
- **Sat 31 Oct, 20:00.** November's status changes from "Sign-up open" to "Running". The regulars are put on Mon 2 Nov and the week's list is posted.

**Pass if:** one summary arrives and the numbers match the Months page.

---

## 6. Known gaps: do not report these as bugs

- **A bare "IN" replying to the month's list does nothing for the month.** It counts as IN for this week's game. Type the full phrase, "IN FOR NOVEMBER". Fixing this needs a change on the Pi.
- **No card payment for the month.** Bank transfer only. No message about the month carries a pay link. This is the unbuilt slice 7.
- **Edited WhatsApp messages are not read.** Paste the list again.
- **"Can't make the next two Mondays" in free text** only drops this week. Use "Games I can't make" on matchtime.ai/month, which works for games the regulars are not on yet.
- **Month reminders need phones.** The name only players get no direct messages. The group count ("💷 N still to pay for November, by ...") goes out once, in the last 24 hours before the pay-by date.
- **Somebody who says paid, leaves and was never confirmed** can only be refunded up to an amount he wrote himself. Confirm the payment first.

---

## 7. Cleanup

1. On matchtime.ai/admin/organisations, find "MT Vets Test" and press its delete button. Type the club's slug to confirm. Read the name twice: this page lists Sutton Football Club too.
2. The engineering session can do the same with the wipe script (a dry run first, then with the apply flag). It takes the club's slug and has no built in protection, so the slug must be the test club's.
3. If the delete fails, nothing was deleted. One suspected cause, not confirmed, is a club with a block booking. Tell the engineering session.
4. Afterwards your browser falls back to Sutton. MatchTime stays in MT Test and ignores it, exactly as today.

What the delete removes: the club, its games, attendance, months, month members, credits, nicknames and the name only players. Real people (anybody with a phone who is in another club) are kept. Borrowed phone players who are in no other club are removed with it. A few log rows with no owner stay behind (attendance history, AI usage counts, health alerts); they are harmless.

### Does anything here touch Sutton or real money? Checked against the code

- **Sutton Football Club.** Group messages are handled per group, so nothing typed in MT Test reaches Sutton. Months, credits, nicknames, ratings and settings are stored per club. Every monthly branch runs only for a club set to Monthly, and Sutton is Weekly. The one crossing point is direct messages from a person in both clubs, which is why the three safety rules at the top exist.
- **Stripe, player payments.** A card or bank payment can only be offered when the collector has completed "Connect bank". You never press it, so the only method is "pay the organiser directly", which moves no money. The month itself has no card payment at all.
- **Stripe, the club fee.** During the 30 day free month nothing is charged, no card is requested and nothing is created in Stripe. A Stripe customer is created only if somebody presses "Add a card". Do not press it. The first charge could not happen before about day 61, and a club with no card is paused on day 37.
- **Real money.** MatchTime never moves money for the month. "Confirm paid", "Record refund" and credits are records only.

---

## 8. Not confirmed

These were not traced to the end. Treat what you see as information, not as a pass or a fail.

- Whether MatchTime posts a line in the group when you switch on "Collect match fees (Stripe)".
- What MatchTime replies, if anything, to a stray word such as `all` sent by direct message, and whether it answers the kit list (scenario 9) in the group. Only "nobody is marked paid" and "nobody is added" are confirmed.
- The exact wording of the answer to "who's in?" around the list (scenario 21). The list inside it is confirmed.
- How a borrowed phone signs in to matchtime.ai/month. The page itself is confirmed.
- Whether the Pi kept the group's chat for learned setup. It holds messages in memory only since it last started.
- The collector's "PAID" reply typed in an admin WhatsApp group uses the same code as the direct message but has no end to end test.
- The date written beside a credit's reason in the ledger.

---

## Appendix: where each part lives

| Part | Files |
|---|---|
| Reading a pasted list | `src/lib/monthly-list.ts`, `src/lib/pasted-roster.ts` |
| Starting a month, the Months page | `src/lib/squad-month.ts`, `src/lib/squad-month-rules.ts`, `src/app/admin/months/` |
| The week: regulars, credits, open places | `src/lib/monthly-week.ts`, `src/lib/monthly-week-rules.ts`, `src/lib/monthly-paste.ts` |
| Sign up | `src/lib/month-signup.ts`, `src/lib/month-signup-rules.ts`, `src/app/month/` |
| Price, paid, the collector | `src/lib/month-payment.ts`, `src/lib/month-payment-rules.ts`, `src/app/month/collect/` |
| Cancelled games, leavers, close | `src/lib/month-close.ts`, `src/lib/month-close-rules.ts` |
| All wording | `src/lib/i18n/strings.en.ts` |
| Same list not posted twice | `src/lib/roster-shown.ts`, `src/lib/bot-scheduler.ts` |
| Learned setup | `src/lib/setup-learning/` |
| Automated tests used as proof | `e2e/web/monthly-squad.spec.ts`, `month-signup.spec.ts`, `month-payment.spec.ts`, `month-close.spec.ts` |
| Plan | `MDs/monthly-squad-plan-2026-10-05.md` |
