# WhatsApp Cloud API for first contact: plan (4 Nov 2026)

Research and plan only. No product code was changed. No model calls were made ($0). Production
was read once, read only (`BEGIN READ ONLY`, no `SET`), and nothing was sent.

## 0. The decision, and the words used here

Kemal, 4 Nov 2026: **keep Baileys on the Pi** for the club groups, HQ and DMs to club members
(people who added MatchTime). **Move to the official WhatsApp Business Platform (Cloud API)**
everything that reaches people who do not know us yet, plus sign-up and login codes.

Why: Baileys is an unofficial client, outside WhatsApp's terms. Reports and blocks from people
who never asked to hear from a number are the main ban trigger, and one ban takes down every
club at once. A second, official number for strangers keeps the club number quiet and low risk.

- **The club number**: today's Baileys number on the Pi.
- **The official number**: the new Cloud API number.
- **Window**: Meta's 24 hour customer service window.
- **Template**: a message template Meta has approved.
- **Business initiated**: we write first, or the window is closed. Needs a template.

**Where Meta's docs are.** Meta moved the WhatsApp docs from
`developers.facebook.com/docs/whatsapp/...` to
`developers.facebook.com/documentation/business-messaging/whatsapp/...`; the old links redirect.
Every Meta fact below was read on 4 Nov 2026 and cites its page. Anything not confirmed is
marked **UNVERIFIED**. Shorthand used in citations: `WA` means
`https://developers.facebook.com/documentation/business-messaging/whatsapp`.

## 1. The Meta facts this plan rests on

| Fact | Source |
| --- | --- |
| Per message pricing since 1 July 2025. Meta charges only for messages from the business, and only when delivered. Messages from users cost nothing. | `WA/pricing` |
| Since **1 October 2026** service messages (free form replies inside the window) are charged again, after **1,000 free per business phone number per month**; utility messages inside the window are charged too (they were free from July 2025). | `WA/pricing` |
| Without a payment method Meta delivers service messages within the free tier but not after it. | `WA/pricing` |
| Prices can change only on 1 Jan, 1 Apr, 1 Jul or 1 Oct. | `WA/pricing` |
| UK rates, GBP list rate sheet "effective October 1, 2026" (linked from the pricing page): marketing **£0.0458**, utility **£0.0159**, authentication **£0.0159**, authentication international n/a, service **£0.0159**. USD sheet: $0.0635, $0.022, $0.022, n/a, $0.022. Read from Meta's own sheet, not a summary. | `WA/pricing`, rate card download "GBP list rates" |
| Volume tiers apply to utility and authentication only; UK utility stays at £0.0159 up to 100,000 a month, authentication up to 300,000. | `WA/pricing`, "GBP volume tiers" sheet |
| **Cloud API stops supporting marketing messages on 13 October 2027.** Accounts created on or after 13 April 2027 cannot send marketing through Cloud API. Successor: the Marketing Messages API for WhatsApp ("most integrations may take about two weeks"). Service, authentication and utility stay on Cloud API. | `WA/marketing-messages/overview` |
| Window: "When a WhatsApp user messages you or calls you, a 24-hour timer called a customer service window starts", reset by each new message. Inside it any free form message; outside it, templates only. | `WA/messages/send-messages` |
| Categories. Utility must be **non promotional** AND either specific to or requested by the user, or essential to the user. Mixed or unclear content is marketing. If Meta decides a template submitted as utility is marketing, "the template is approved as MARKETING". Approved templates can be re-categorised later, instantly after a misuse warning; a `template_category_update` webhook fires and a review can be asked within 60 days. | `WA/templates/template-categorization` |
| Authentication templates have **fixed text**: "&lt;VERIFICATION_CODE&gt; is your verification code.", optional "For your security, do not share this code.", optional "This code expires in &lt;NUM_MINUTES&gt; minutes." Buttons: copy code, one tap autofill (needs an Android app) or zero tap (Android app only). No URLs, media or emojis. Only authentication templates may carry a one time code. English and Turkish are supported languages. Delivered only to the user's primary device. | `WA/templates/authentication-templates/authentication-templates`, `WA/templates/supported-languages` |
| Opt-in: we may contact people if they gave us their number AND opted in to messages from **a named business**; the opt-in "can be general and not specifically for WhatsApp"; a website is an accepted method. | `WA/getting-opt-in` |
| Policy: "You may only initiate conversations using an approved Message Template." A number passed to us by a third party satisfies neither condition for that person. | `https://whatsappbusiness.com/policy/` (last updated 23 Sept 2026) |
| Messaging limit: unique people reached **outside a window** per moving 24 hours, per business portfolio. New portfolios: **250**. To 2,000: verify the business, or deliver 2,000 template messages outside windows in 30 days at high quality. Then 10,000, 100,000, unlimited automatically. Messages inside a window do not count. | `WA/messaging-limits` |
| New portfolios may register two phone numbers (20 once verified or at 2,000). Unverified portfolios are also limited in templates. | `WA/messaging-limits`, `WA/business-phone-numbers/phone-numbers` |
| Number: must not be in use on WhatsApp or WhatsApp Business app (delete it there first), must have a country code, must receive SMS or a voice call (a landline works by voice). Registration needs a 6 digit two step PIN. | `WA/business-phone-numbers/phone-numbers`, `WA/account-model-evolution` |
| Display name must have "a clear relationship with the business's legal name" or branding consistent with the website. Refused: generic words, "Official", "Verified", promotional language, URLs. It is reviewed when the number moves up a messaging limit; 10 changes per 30 days. | `https://www.facebook.com/business/help/757569725593362`, `WA/display-names` |
| Business verification: Security Centre, Start verification, legal name, address, phone and an https website matching the legal entity; documents "such as a business licence or articles of incorporation" if no record matches; connection confirmed by email, phone, text, WhatsApp or domain; "may take up to 14 working days". | `https://www.facebook.com/business/help/2058515294227817` |
| Quality rating green, yellow, red; block reasons offered to users include "Didn't sign up" and "Spam". A red template is paused 3 hours, then 6 hours, then disabled. Policy breaches: 1 or 3 day block on templates, then 5, 7 or 30 days, then account lock. | `https://www.facebook.com/business/help/896873687365001`, `WA/templates/template-pausing`, `WA/policy-enforcement` |
| Webhook handshake: GET with `hub.mode=subscribe`, `hub.verify_token`, `hub.challenge`; answer 200 with the challenge. Every POST carries `X-Hub-Signature-256: sha256=...`, an HMAC SHA256 of the raw payload keyed with the **app secret**. Meta retries for **up to 7 days** and duplicates can arrive, so we must dedupe. Up to 1,000 updates per POST. | `WA/webhooks/create-webhook-endpoint`, `WA/webhooks/overview` |
| Inbound shape: `entry[].changes[].value.messages[]` with `from`, `id` (the wamid), `timestamp`, `type`, `text.body`, `context.id` when quoting; `contacts[].profile.name`; status updates in `statuses[]` (`sent`, `delivered`, `read`, `failed`) with `errors[]` and `pricing`. | `WA/webhooks/create-webhook-endpoint`, `WA/webhooks/reference/messages/status` |
| Users who adopt a WhatsApp **username** may arrive with no phone number unless we interacted in the last 30 days; every webhook carries a business scoped user id `user_id`. Copy code authentication templates still need a phone number. | `WA/business-scoped-user-ids` |
| Send: `POST /<PHONE_NUMBER_ID>/messages`; the reply only means "accepted", not delivered. Current Graph version v26.0. | `WA/messages/send-messages`, `https://developers.facebook.com/docs/graph-api/changelog/versions` |
| Errors we handle: 131047 window closed, 131026 undeliverable, 130429 throughput, 131056 pair rate limit (1 message per 6 seconds to the same person, bursts of 45 allowed), 131048 spam rate, 131049 held for ecosystem health, 131050 user stopped marketing, 132015 template paused, 132016 template disabled, 132001 template missing. | `WA/support/error-codes`, `WA/about-the-platform` |
| A test WABA and **test phone number** are created with the app; "relaxed messaging limits" and no payment method needed for template sends from it. | `WA/get-started`, `WA/about-the-platform` |
| System user token: Business Settings, System users, Add, assign the app and the WhatsApp account (full control), Generate token, choose expiry, permissions `business_management`, `whatsapp_business_messaging`, `whatsapp_business_management`. | `WA/access-tokens`, `WA/get-started` |
| Automated replies are allowed inside the window if a clear path to a person exists. | `https://whatsappbusiness.com/policy/` |
| Marketing templates are not delivered to US numbers. | `WA/messages/per-user-limits` (from the docs research, not rechecked; not needed by us) |

**UNVERIFIED** (could not be confirmed on Meta's pages):
1. Which documents Meta accepts from a UK limited company. Only "business licence or articles of
   incorporation" is stated. Have ready: Companies House certificate of incorporation, a recent
   bank statement or utility bill in the company name at the registered office.
2. A "never expires" choice for the system user token (the docs say "choose a token expiration
   preference").
3. How many recipients the test number may message, and whether its sends are free.
4. Any idempotency key on the send API (none found; `biz_opaque_callback_data` is echoed in
   status webhooks).
5. How long display name review takes, and whether "MatchTime" will pass.
6. Whether a pool offer is utility or marketing (Meta has no matching example).
7. Any STOP keyword handled by Meta (none documented; the policy only says we must honour
   opt-outs made on or off WhatsApp).
8. Whether a web only login with a copy code button is explicitly endorsed (the mechanism is
   documented; the framing is app based).
9. Whether the app must also be subscribed to the WABA with `POST /<WABA_ID>/subscribed_apps`
   for webhooks to arrive. Check during setup (step 12 below).
10. Whether Vercel crons on our plan may run every minute (needed for the dispatcher sweep).

## 2. Kemal's setup checklist (you do every account and credential step)

We never type your passwords or tokens. You paste the values into Vercel yourself (step 14).
Do steps 1 to 3 first: verification can take up to 14 working days and the rest can run alongside.

1. **Meta Business portfolio.** business.facebook.com, sign in, Create a business portfolio (or
   use an existing Cressoft one). Business name exactly **Cressoft Consultancy Limited**, your name,
   a business email (admin@cressoft.io). Do not add the club number anywhere in this portfolio.
2. **Business details.** Business settings, Business info: legal name Cressoft Consultancy
   Limited, address 167-169 Great Portland Street, London, W1W 5PF, a phone you answer, website
   **https://matchtime.ai** (its privacy page already names Cressoft Consultancy Limited and
   company number 07628636, which helps the match).
3. **Business verification.** Security Centre, Start verification. Pick the company from the list
   if found; otherwise upload documents (see UNVERIFIED item 1). Choose **domain verification**
   for matchtime.ai if offered: Meta gives a DNS TXT record; send it to us and we add it in DNS,
   or add it yourself. Wait for the decision (up to 14 working days).
4. **A new phone number.** A UK mobile SIM that has never been on WhatsApp (a cheap pay as you go
   SIM is fine), or a number you delete from WhatsApp first. It must receive SMS or a voice call.
   Keep the SIM safe: it is needed if the number ever has to be verified again.
5. **Create the app.** developers.facebook.com, My Apps, Create app, use case "Connect with
   customers through WhatsApp" (type Business), app name "MatchTime", link it to the portfolio
   from step 1. This also creates a test WhatsApp account and a test number.
6. **Try the test number (free, optional).** App dashboard, WhatsApp, API Setup: add your own
   mobile as a "To" number and press Send message. This proves the app works before the real
   number exists.
7. **Add the real number.** WhatsApp Manager (or API Setup, Add phone number): display name
   **MatchTime**, the closest business category offered (the list was not checked), a short "About" with no mention of automation,
   e.g. "Football games near you, from MatchTime." Verify by SMS or voice call.
8. **Two step PIN.** Choose a 6 digit PIN and keep it in your password manager. Registration of
   the number (`POST /<PHONE_NUMBER_ID>/register` with that PIN) is an API call: we give you the
   exact command to run once the token exists, or WhatsApp Manager may do it for you.
9. **Payment method.** WhatsApp Manager, Payment settings, add a card for the portfolio. Without
   it, paid messages (every template, and service replies past 1,000 a month) are not delivered.
10. **System user and permanent token.** Business settings, Users, System users, Add, name
    "matchtime-server", role Admin. Assign assets: the app (full control) and the WhatsApp account
    (full control). Generate token: pick the app, the longest expiry offered ("Never" if listed),
    permissions `business_management`, `whatsapp_business_messaging`,
    `whatsapp_business_management`. Copy the token once; it is not shown again.
11. **App secret.** App dashboard, App settings, Basic, App secret, Show. Copy it.
12. **Webhook.** After we deploy the webhook route (PR C5 below, it is off by default and only
    answers the handshake): App dashboard, WhatsApp, Configuration, Callback URL
    `https://matchtime.ai/api/whatsapp/cloud/webhook`, Verify token: a long random string you make
    up (keep it). Verify and save. Then subscribe to the fields `messages`,
    `message_template_status_update`, `template_category_update`, `phone_number_quality_update`,
    `account_update` and `user_preferences`. If no test message arrives, the app may also need
    subscribing to the WhatsApp account (UNVERIFIED item 9); we give you the command.
13. **Values we need back** (names only travel to us; the secret ones go straight into Vercel):

    | Value | Where you find it | Vercel env name (proposed) | Secret? |
    | --- | --- | --- | --- |
    | Phone number id | API Setup, under the number | `WA_CLOUD_PHONE_NUMBER_ID` | no |
    | WhatsApp Business Account id | API Setup, or WhatsApp Manager | `WA_CLOUD_WABA_ID` | no |
    | App id | App dashboard header | `WA_CLOUD_APP_ID` | no |
    | The number itself, digits | the SIM | `WA_CLOUD_NUMBER` | no |
    | System user token | step 10 | `WA_CLOUD_ACCESS_TOKEN` | **yes** |
    | App secret | step 11 | `WA_CLOUD_APP_SECRET` | **yes** |
    | Verify token | step 12 | `WA_CLOUD_VERIFY_TOKEN` | **yes** |
    | Graph version | fixed by us | `WA_CLOUD_GRAPH_VERSION` = `v26.0` | no |

14. **Paste into Vercel yourself.** Vercel, matchtime project, Settings, Environment Variables,
    Production only, one per row above. Do not paste them into chat. The feature flags
    (`CLOUD_API_ENABLED`, `CLOUD_API_PURPOSES`) stay unset (off) until each flow is switched on.
15. **Templates.** We prepare them in code (section 5.6). A script submits them with your token
    once you say go; you can also watch approval in WhatsApp Manager, Message templates.

## 3. Flow by flow

**What moves.** Columns: today's path, who starts it, what the official number sends, and what
happens to the reply. All replies arrive at the webhook (section 5.2) and go into **the same DM
pipeline as Baileys DMs** (section 5.3): one handler, one DM reader, no second code path and no
phrase matching.

### 3.1 Login codes and sign-up codes (moves)

- **Today.** "Get a sign-in code on WhatsApp" (`src/app/(auth)/login/page.tsx:202`) calls
  `startPhoneSignIn` (`src/app/actions/phone-signup.ts:265`); sign-up codes come from
  `startPhoneSignup` (`phone-signup.ts:159`), both through `issueCode` (`phone-signup.ts:84`) to
  `queuePlatformDm` purpose `otp` (`phone-signup.ts:126`); the account claim code from
  `src/app/actions/claim.ts:81`. The Pi claims them at `GET /api/whatsapp/platform-jobs`
  (`src/lib/platform-jobs.ts:605`, codes ranked first at `:595`, dropped after 10 minutes at `:555`).
- **Who starts it.** We do (the person typed a number on the web; he has not written to us).
  Business initiated: **authentication template**.
- **Template.** `mt_code`, authentication, copy code button, security line on, expiry 10 minutes,
  languages `en_GB` and `tr`. The body is Meta's fixed text in each language, so today's "Welcome
  to MatchTime, Sam" and "claim your account" wording cannot be kept: all three uses send the same
  template, and the web page around the form says which it is for.
- **Replies.** None expected. Anything he writes opens a window and goes through the DM pipeline
  like any other DM.
- **Cheaper alternative (free), for you to choose.** Reverse the direction, as `/play` already
  does: the login page shows "Send this message on WhatsApp" with a prefilled code; his own
  message proves the number, and our "you're signed in" answer is a free service reply. It costs
  nothing and needs no template, but it is one more step for the person.

### 3.2 Pool sign-up confirmation (moves)

- **Today.** `/play` posts to `POST /api/play/signup`, which builds the wa.me link from
  `matchtimeWaNumber()` (`src/app/api/play/signup/route.ts:42`, `src/lib/club-connect.ts:34`);
  members use the same step from `src/app/actions/pool-member.ts:45`. His prefilled message
  reaches the club number, `dm-reply` runs `handlePoolConfirmDm` first
  (`src/app/api/whatsapp/dm-reply/route.ts:214`), and `src/lib/pool/confirm.ts` answers:
  welcome `pool-welcome` (`confirm.ts:233`), claim (`confirm.ts:205`), wrong code
  `pool-code-reply` (`confirm.ts:372`).
- **Who starts it.** He does: the wa.me link now points at the official number. Every answer is
  inside the window: **free form service message, no template**, free within 1,000 a month.
- **Replies.** His times and formats answer to the welcome's question go to the pool's one DM
  reader (`src/lib/pool/reply.ts`, via `dm-reply/route.ts:1568`), as today.
- **Joining on the web with no message** (a member's "Join" on his profile, the partner pool
  invite page): there is no window, so the one welcome he gets is the utility template
  `mt_pool_joined` below (Meta's own example of utility is an opt-in confirmation).

### 3.3 Pool offers and what follows them (moves)

- **Today.** `src/lib/pool/round.ts:257` queues purpose `pool-offer`, admitted under the platform
  lock at dispatch (`src/lib/pool/dispatch.ts`, called from `platform-jobs.ts:636`). Then
  `pool-placed` (`src/lib/pool/accept.ts:272`), replies in words `pool-reply`
  (`src/lib/pool/reply.ts:375`), pauses `pool-paused` (`round.ts:348`, `no-shows.ts:244`,
  `safety.ts:200`), plan changes `pool-removed` (`src/lib/pool/removal.ts:54`), the one later
  question `pool-details-ask` (`src/lib/pool/details.ts:108`).
- **Who starts it.** We do, except `pool-reply` (an answer to his DM, inside the window, free form).
  Everything else is a template unless he wrote to us in the last 24 hours, in which case the
  same text goes free form (section 5.4 decides).
- **Category.** Offers: **submit as utility** (he asked for "game messages near me", each offer is
  one specific match, the text is facts only, no promotional words), **expect Meta may approve it
  as marketing** (UNVERIFIED item 6). Placed, paused, removed: utility (a change to something he
  holds). Details question: utility is arguable (it improves his own settings) but it is
  unrequested, so it may well become marketing.
- **Replies.** A tap on a URL button opens the existing offer page (`/play/offer/<id>.<hmac>`;
  opening never accepts). A quick reply button or typed words arrive as an inbound message and go
  through the DM pipeline: the quoted wamid in `context.id` finds the offer as a swipe-reply does
  today.

### 3.4 Club invitations (moves)

- **Today.** `src/lib/pool/club-invitation.ts`: the organiser's ask `club-invite-ask` (`:250`),
  the after game ask (`:686`), the group link `club-invite-link` (`:309`), the club said no
  `club-invite-closed` (`:457`). Prod has had 0 in the last 30 days.
- **Who starts it.** We do. Asks: likely **marketing** (inviting him to something new). Link and
  closed: **utility** (the answer to his own yes on the My invitations page).
- **Replies.** The buttons open My invitations; words go through the DM pipeline.

### 3.5 Friend links (the friend's side moves; the member's side stays)

- **Today.** The member gets his link by DM from the club number
  (`src/lib/friend-link/issue.ts:93`, a BotJob): **stays on Baileys**, he is a member. The friend
  opens `/play/f/...`, which uses the same sign-up route (`route.ts:42`) and wa.me link, so his
  code message will reach the official number. Then `friend-booked`
  (`src/lib/friend-link/book.ts:133`) and `friend-not-booked` (`book.ts:88`) answer his own
  message: free form, free. `friend-out` (`src/lib/friend-link/withdraw.ts:57`) and
  `friend-removed` (`src/lib/pool/removal.ts:54`) come later: utility templates.
- **Replies.** Through the DM pipeline (`src/lib/pool/reply.ts:476` handles the friend's words today).

### 3.6 Partner club asks (recommend: stay on Baileys; your call)

- **Today.** The approval question goes to the partner club's organisers through that club's own
  admin channel (`src/lib/partner-ask.ts:431` calling `sendAdminNotice`,
  `src/lib/admin-channel.ts:219`): a post in its HQ group, or BotJob DMs to its admins
  (`admin-channel.ts:249`). The ask itself is a post in the partner's players' group
  (`partner-ask.ts:489`) with a wa.me link to the club number (`partner-ask.ts:485`). Partnership
  requests go the same way (`src/lib/club-partnership.ts:725`).
- **Why stay.** Every recipient is an organiser or member of a club that added MatchTime: not a
  stranger. HQ and players' group posts cannot move (Cloud API does not post into these groups),
  and splitting one ask across two numbers would break the swipe-reply and the "IN (ref K7Q2)"
  DM that volunteers send to the club number. Moving only the DM fallback would give an
  organiser two MatchTime numbers for one conversation.
- **If you still want it moved:** only the DM fallback branch can move, as a utility template
  `mt_partner_ask`, and volunteers would keep writing to the club number.

### 3.7 Recruit messages (nothing to move)

`src/lib/recruit.ts:494` DMs recent players of the club, and **already skips guests** (pool and
partner guests are excluded at `recruit.ts:426`), so every recipient is a member: stays on
Baileys. Recruiting non-members today means pool offers (3.3, which L10's "ask the pool in words"
reuses) and partner asks (3.6). Prod: 38 recruit DMs in 30 days, all to members.

### 3.8 Other first contact found in the code

| Purpose | Today | Recommendation |
| --- | --- | --- |
| `pool-partner-invite`, a partner club's player after he played for another club | `src/lib/pool/partner-invite.ts:155` | He is a member of a MatchTime club, so by your rule it stays; but it promotes a new service and would be marketing on the official number. **Your call**; my recommendation is keep it on the club number. If he joins, his pool messages then come from the official number (welcome `mt_pool_joined`). |
| Self-join connect (a new organiser's "Connect Riverside FC, code 7KQ2") | `src/app/actions/club-connect.ts:50`, `src/lib/connect-dm.ts:321` | Stays: he writes first (low risk) and his next step is adding **that same number** to his group. |
| `owner-*` to you, `billing`, `setup-*`, `organiser-decision` | `platform-jobs.ts:134` list | Stay: members, organisers or you. |

### 3.9 Proposed templates (EN and TR)

House rules hold in every line: no em or en dashes, never "bot", no slashes as separators,
"bench" and "yedek", no time of day greeting. `{{n}}` are Meta's variables. Wording follows the
copy already shipped (`src/lib/i18n/pool-offer.*.ts`, `pool-invite.*.ts`, `friend-link.*.ts`,
`pool-safety.*.ts`, `pool-details.*.ts`). Long variable values (venue lines, the club line) are
filled by the existing copy functions, so one copy home stays. Our own rule (not Meta's): no template
starts or ends with a variable, so no message is unclear on its own.

| Name | Category | EN | TR | Buttons |
| --- | --- | --- | --- | --- |
| `mt_code` | authentication | Meta's fixed text | Meta's fixed text | copy code |
| `mt_pool_offer` | utility (may become marketing) | ⚽ *{{1}}* needs {{2}} for a {{3}} on *{{4}}*.<br>Venue: {{5}}, {{6}} from you.<br>{{7}}<br>Fee: {{8}}<br><br>You get this because you joined the MatchTime player pool. Would you like the place? Tap Answer, or reply here. | ⚽ *{{1}}*, *{{4}}* günü {{3}} için {{2}} arıyor.<br>Yer: {{5}}, sana {{6}}.<br>{{7}}<br>Ücret: {{8}}<br><br>Bu mesajı MatchTime oyuncu havuzuna katıldığın için alıyorsun. Yeri ister misin? Cevap'a dokun ya da buraya yaz. | URL "Answer" (TR "Cevap") `https://matchtime.ai/play/offer/{{1}}`; URL "Settings" (TR "Ayarlar") to his manage link; quick reply "Stop game offers" (TR "Teklifleri durdur") |
| `mt_pool_placed_in` | utility | ✅ You're in: *{{1}}*, {{2}}, {{3}}. {{4}}<br>Can't make it after all? Tap below to give the place back. | ✅ Yerin hazır: *{{1}}*, {{2}}, {{3}}. {{4}}<br>Gelemeyecek misin? Yeri geri bırakmak için aşağıya dokun. | URL give back |
| `mt_pool_placed_bench` | utility | 📝 You're on the bench for *{{1}}*, {{2}}, {{3}}. The organisers pick from the bench, and you'll hear if you play. | 📝 *{{1}}* maçında yedektesin: {{2}}, {{3}}. Organizatörler yedekten seçiyor, oynarsan haber vereceğim. | URL give back |
| `mt_pool_paused` | utility | I've paused game offers because the last {{1}} went unanswered. Want them again? Tap below. | Son {{1}} teklif cevapsız kaldığı için maç tekliflerini durdurdum. Yeniden istersen aşağıya dokun. | URL settings |
| `mt_pool_paused_review` | utility | I've paused game offers while the MatchTime team looks at your profile. You can ask about it by replying here. | MatchTime ekibi profiline bakarken maç tekliflerini durdurdum. Sormak istediğin bir şey olursa buraya yazabilirsin. | none |
| `mt_game_plan_changed` | utility | Plans changed for *{{1}}* on {{2}}: they don't need a player for that game any more. Nothing for you to do. | *{{1}}* için {{2}} maçında plan değişti: o maç için artık oyuncuya ihtiyaçları yok. Senin bir şey yapmana gerek yok. | none |
| `mt_taken_out` | utility | The organisers of *{{1}}* took you out of the game on {{2}}. You stay in the MatchTime player pool and will keep hearing about new games near you. | *{{1}}* organizatörleri seni {{2}} maçından çıkardı. MatchTime oyuncu havuzunda kalıyorsun ve yakınındaki yeni maçlardan haberin olmaya devam edecek. | none |
| `mt_place_given_back` | utility | You've given your place back for *{{1}}* on {{2}}. You stay in the MatchTime player pool. | *{{1}}* ile {{2}} maçındaki yerini geri verdin. MatchTime oyuncu havuzunda kalıyorsun. | URL settings |
| `mt_pool_joined` | utility | ✅ You're in the MatchTime player pool. When a club near you needs a player at a time you can play, I'll message you here with the game, and you decide. At most {{1}} a week. | ✅ MatchTime oyuncu havuzundasın. Yakınında bir kulübe oynayabileceğin bir saatte oyuncu lazım olunca maçı buradan yazarım, karar senin. Haftada en fazla {{1}}. | URL settings |
| `mt_pool_details_ask` | utility (may become marketing) | One quick question so I only send you games that suit you: what times can you play on {{1}}, and which formats do you play? Reply here in your own words. No need to reply if any time and any format are fine. | Sana uygun maçları göndermem için kısa bir soru: {{1}} günleri hangi saatlerde oynayabilirsin, hangi formatlarda oynuyorsun? Buraya kendi cümlelerinle yaz. Her saat ve her format uygunsa cevap vermene gerek yok. | URL settings |
| `mt_club_invite_after_game` | marketing (expected) | Enjoyed the game with *{{1}}* on {{2}}? If you'd like to join their group for future games, tap below to answer. | {{2}} günü *{{1}}* ile oynadığın maç güzel geçti mi? Sonraki maçlar için gruplarına katılmak istersen yanıtlamak için aşağıya dokun. | URL My invitations |
| `mt_club_invite_organiser` | marketing (expected) | From MatchTime: *{{1}}* would like you to join their group for future games. Tap below to answer. | MatchTime'tan: *{{1}}* sonraki maçlar için seni gruplarında görmek istiyor. Yanıtlamak için aşağıya dokun. | URL My invitations |
| `mt_club_invite_link` | utility | 🎉 Welcome to *{{1}}*. Tap below to join their WhatsApp group. | 🎉 *{{1}}* grubuna hoş geldin. WhatsApp grubuna katılmak için aşağıya dokun. | URL `https://chat.whatsapp.com/{{1}}` |
| `mt_club_invite_closed` | utility | Thanks for saying yes. *{{1}}* is not adding new players to their group right now. You can still get games near you through MatchTime. | Evet dediğin için teşekkürler. *{{1}}* şu anda gruplarına yeni oyuncu almıyor. Yakınındaki maçları MatchTime üzerinden almaya devam edebilirsin. | none |

The Turkish lines should be read by you before submission, as
the Turkish copy files ask. `{{2}}` in `mt_pool_offer` carries "1 player" or "2 players" from the
existing plural helper. If Meta rejects the offer for having too many variables, the fallback is
two templates (`mt_pool_offer_fee` and `mt_pool_offer_free`) with the club line dropped.

## 4. Cost

### 4.1 Prices (UK, from Meta's GBP rate sheet effective 1 Oct 2026)

| Category | Per delivered message | Used for |
| --- | --- | --- |
| Authentication | £0.0159 | login, sign-up and claim codes |
| Utility | £0.0159 | placed, paused, plan changed, given back, joined, invitation link |
| Marketing | £0.0458 | invitations to join a group; pool offers if Meta re-categorises them |
| Service (free form in the window) | first 1,000 a month per number free, then £0.0159 | sign-up welcome, wrong code, replies to his words, friend booked |
| Messages he sends us | free | everything inbound |

### 4.2 Our real volumes, last 30 days (5 Oct to 4 Nov 2026, production, read only)

| What would move | Count | Notes |
| --- | --- | --- |
| Codes (`otp`) | **20** | 14 sign-in codes to 7 numbers, 6 sign-up codes to 3 numbers, 0 claim codes |
| Pool sign-up confirmations (`pool-welcome`) | **6** | all answers to his own message: free |
| Wrong code replies (`pool-code-reply`) | 0 | |
| Pool offers (`pool-offer`) | **5 delivered** | 7 queued, 2 cancelled before sending when the organiser cancelled the ask; outcomes: 2 accepted, 3 ignored |
| Placed (`pool-placed`) | **2** | |
| Paused, plan changed, details question, replies in words | 0 | the details question only started today |
| Club invitations (`club-invite-*`) | 0 | 0 `ClubInvitation` rows |
| Friend messages (`friend-*`) | 0 | 1 friend link issued, unused |
| Partner pool invite | 0 | |
| Partner asks (stay, for reference) | 6 asks, 5 partnership requests | all to MatchTime clubs' organisers |
| Recruit DMs (stay, for reference) | 38 | all to members |
| Everything else on Baileys (stays) | 186 club DMs, 52 HQ posts, 43 group posts | BotJob |

Pool state today: 9 active pool profiles and 1 waiting, all created in the last 30 days. Platform
jobs began on 9 Oct 2026, so the window above is fully covered.

### 4.3 Monthly estimate

| Scenario | Codes | Offers | Other utility | Service | Total if offers are utility | Total if offers are marketing |
| --- | --- | --- | --- | --- | --- | --- |
| **Today's real volume** | 20 x £0.0159 = £0.32 | 5 | 2 placed = £0.03 | 6, free | **about £0.43 a month** | **about £0.58 a month** |
| One town open (assumed: 200 players, 400 offers, 80 placed, 150 codes, 30 other) | £2.39 | 400 | 110 = £1.75 | under 1,000, free | **£10.49** | **£22.45** |
| Busy (assumed: 1,000 players, 2,000 offers, 400 placed, 500 codes, 150 other, 1,500 service) | £7.95 | 2,000 | 550 = £8.75 | 500 over the free 1,000 = £7.95 | **£56.45** | **£116.25** |

Offers dominate. Today the whole move costs well under £1 a month. The reverse login (3.1)
would remove the code line. The cap of 2 offers a week per player already bounds the busy case.

## 5. Engineering design

### 5.1 One place decides the channel

A pure module `src/lib/send-channel.ts`, no I/O:

```
channelFor({ purpose, replyTo, env }) -> "baileys" | "cloud"
```

- Off unless `CLOUD_API_ENABLED` is on; then only the purposes listed in `CLOUD_API_PURPOSES`
  (comma list) go to `cloud`, so each flow is switched on alone.
- Business initiated purposes (codes, pool, invitations, friend) map to `cloud`.
- Reply purposes (`pool-reply`, `pool-code-reply`, `setup-reply`, `friend-booked`,
  `friend-not-booked`) take **the channel he last wrote on** (`replyTo`, read from the inbound
  log), so an answer always lands in the chat he is looking at, inside its window, for free.
- `BotJob` (club DMs, HQ, groups) never asks: always Baileys. Only `PlatformJob` purposes can move.
- `queuePlatformDm` (`platform-jobs.ts:310`) calls `channelFor` once and stores the answer on the
  job. A source guard test (like `platform-jobs-source-guard.test.ts`) proves nothing else picks a
  channel.
- `waNumberFor(channel)` replaces bare `matchtimeWaNumber()` (`club-connect.ts:34`): the pool
  sign-up, member pool step and friend link use the official number (`WA_CLOUD_NUMBER`) when the
  pool purposes are on; self-join and partner asks keep the club number. The server only rule of
  `wa-number-server-only.test.ts` covers both numbers.
- **No automatic fallback to Baileys** for first contact purposes when the official number fails:
  falling back would put strangers back on the risky number. Codes, and only codes, fall back to
  the club number (decided, section 6 item 5): `fallbackWhenCloudDown("otp")` answers `baileys`,
  every other purpose `null`. With the master flag off nothing is on the official number, so
  there is nothing to fall back from, and the separate `CLOUD_OTP_FALLBACK_BAILEYS` flag is
  dropped.

### 5.2 The inbound webhook

`src/app/api/whatsapp/cloud/webhook/route.ts`, thin:

- `GET`: answer `hub.challenge` with 200 only when `hub.mode=subscribe` and `hub.verify_token`
  equals `WA_CLOUD_VERIFY_TOKEN` (timing safe); 403 otherwise.
- `POST`: read the **raw body**, check `X-Hub-Signature-256` with HMAC SHA256 keyed by
  `WA_CLOUD_APP_SECRET`, timing safe compare; 401 on a missing or wrong signature, before parsing.
  Then a pure parser (`src/lib/cloud-api/inbound.ts`) turns the payload into messages and statuses.
- Every message is written once to a new table `WaInbound` (channel, wamid unique, phone, user id
  `user_id` when given, received at, processed at, result). A duplicate wamid writes nothing
  (Meta retries for 7 days). Answer 200 at once, then process in `after()`; a sweep (5.5) picks up
  rows never processed, so a crash mid way is retried, never lost and never doubled.
- Statuses update the `PlatformJob` by wamid (or by `biz_opaque_callback_data`, which we set to the
  job id): `delivered`, `read`, `failed` with the error code. A `failed` pool offer calls the
  existing `onPoolOfferJobFailed`.
- `user_preferences` (he stopped marketing), template status and category updates, quality and
  messaging limit updates are logged to an owner dashboard tile; nobody is DMed (your rule).
- Logs keep phone and ids, never the text (your 2026-10-15 rule).

### 5.3 One pipeline for every DM

First a pure refactor PR: move the body of `POST /api/whatsapp/dm-reply`
(`dm-reply/route.ts:147`) into `handleInboundDm(input, { channel })` in `src/lib/inbound-dm.ts`
with no change in behaviour (all existing tests stay green). The Baileys route and the Cloud
webhook both call it with the same input shape: phone, text, wamid, sender name, quoted id and
text, timestamp. A button reply passes the button's text as the message. Every handler, the one
DM reader (`src/lib/dm-reader.ts`), the pool confirm, the pool reply reader and the Q&A run
unchanged. `channel` is just a fact they carry for choosing where the answer goes.

Quoted replies: `context.id` is a Cloud wamid; the quote lookup (`src/lib/reply-context.ts:186`,
`src/lib/quoted-message.ts:25`) learns its format in one normaliser and also searches
`PlatformJob.waMessageId` for the official number's messages.

### 5.4 A person on both numbers

Example: a Sutton FC member who also joined the pool.

- **Identity does not change.** One `User` per phone, as today. The channel belongs to each
  message, not to the person.
- **What comes from where.** Club things (his club's posts, reminders, pay links, recruit DMs)
  from the club number; pool things (offers, placed, pauses) and codes from the official number.
  Decided only by `channelFor`.
- **What he writes, wherever he writes it, goes through the same pipeline.** If he answers an
  offer in the club number's chat, the pool reply reader still finds the offer (by facts, as
  today), and the answer goes back on the club number because he wrote there. If he asks the
  official number about his club's game, the same Q&A answers on the official number (free,
  inside the window); club side BotJob DMs it triggers still come from the club number.
- **Free form or template.** For a cloud job the dispatcher checks `WaInbound` for his last
  message on the official number: within 24 hours, free form text; otherwise the job's template.
  If Meta still answers 131047 (window closed), the job is resent once as its template.
- **Usernames.** If a person arrives with a `user_id` and no phone, the row is kept and the DM is
  handled as an unknown sender (as a LID only sender is today). Our flows all start from a number
  he gave us, so this should be rare.
- **The switch over.** The 9 pool players have their chat with the club number. Before the pool
  purposes move, one last message from the club number would tell them "game offers now come from
  MatchTime's official number +44 ..., please save it". It queues 9 DMs, so it needs your go on
  the day (your rule on scripts that queue messages).

### 5.5 Sending, failure and retry

- `PlatformJob` gains `channel` (default `baileys`), `templateName`, `templateLang`,
  `templateParams` (JSON), `deliveredAt`, `readAt`, `errorCode`. The Pi's claim
  (`claimDuePlatformJobs`, `platform-jobs.ts:605`) filters `channel = baileys`; nothing else
  changes for the Pi.
- The Cloud dispatcher (`src/lib/cloud-api/dispatch.ts`) uses **the same claim function** with
  `channel = cloud`, so the pool offer admission (caps, quiet hours, switches) stays in one place.
  It runs in `after()` right after a job is queued, and from a sweep every minute
  (`/api/cron/cloud-dispatch`; UNVERIFIED item 10), which also runs the pool sweeps so pool offers
  no longer depend on the Pi being up.
- **Idempotency.** Meta documents no idempotency key (UNVERIFIED item 4). So, as today, at most
  once: the job is claimed by compare and set before the send; the wamid is stored on success.
- **Retry policy, pure** (`src/lib/cloud-api/errors.ts`): retry later only when Meta said it did not
  take the message (130429, 131056, 80007, HTTP 5xx with an error body), with backoff, at most 3
  times. Never retry after a timeout with no answer (it may have landed): mark `unconfirmed`, and
  let the status webhook settle it. 131026 and 131049: failed. 131050: failed, and marketing to
  him stops. 132015 or 132016: failed, template flagged on the dashboard, and the dispatcher stops
  using that template until it is green again. A code older than 10 minutes is dropped, as today.
- **Messaging limit.** Until verification, 250 people a day outside a window. A daily counter
  (`CLOUD_DAILY_UNIQUE_CAP`, default 200) holds lower priority jobs (details question, invitations)
  and lets codes and placed messages through first.
- **Pacing.** Meta allows 1 message per 6 seconds to the same person; our flows never come close,
  and 131056 is retried.

### 5.6 Templates as code

- `src/lib/cloud-api/templates.ts`: one registry entry per template (name, category, languages,
  body variables, buttons, which copy functions fill each variable). The text itself lives in
  i18n files next to the copy it mirrors (`src/lib/i18n/cloud-templates.en.ts` and `.tr.ts`), one
  copy home per kind.
- Unit tests: house rules on every template (no dashes, no "bot", no slashes as separators, no
  variable at the start or end, both languages present, Turkish not equal to English), and each
  variable is filled for every live shape of the job.
- `scripts/cloud-templates.ts`: compares the registry with Meta (`GET /<WABA_ID>/message_templates`)
  and prints the difference; `--apply` submits new or changed ones and needs your go. Status and
  category webhooks update a `CloudTemplateStatus` table read by the dashboard and by the
  dispatcher.
- A template Meta re-categorises from utility to marketing is reported on the dashboard; the
  marketing ones need the move to the Marketing Messages API before 13 October 2027.

### 5.7 Opt-out

- **STOP in any words** goes through the one DM reader, as today: "opt-out-all" stops the pool
  profile (`src/lib/pool/dm-optout.ts`, called at `dm-reply/route.ts:759`) and the DM subscriptions.
  The quick reply button "Stop game offers" is just that text arriving as a message. No phrase list.
- **Meta's own stop** (he stops marketing in WhatsApp): the `user_preferences` webhook and error
  131050 are written to his pool profile as a stop, with a consent record row
  (`PoolConsentRecord`, withdraw, channel `whatsapp-cloud`), like a stop on the manage page.
- **Blocks** show only as failed deliveries and a falling quality rating; three failed deliveries
  in a row pause his offers (reusing the existing pause rule), and the dashboard shows the rating.
- Codes are always sent: he asked for them.

### 5.8 Flags, all off by default

`CLOUD_API_ENABLED` (master), `CLOUD_API_PURPOSES` (each flow), `CLOUD_DAILY_UNIQUE_CAP`
(`CLOUD_OTP_FALLBACK_BAILEYS` is dropped: the code fallback is decided, see 5.1). With the master off, every function returns what it returns today and
the webhook only answers the handshake.

### 5.9 Testing at $0

- **Unit (vitest)**: `channelFor`, the inbound parser (fixtures copied from Meta's docs), signature
  checks (right, wrong, missing, tampered body), the error classifier, window choice, template
  rendering and house rules.
- **A Cloud API stub**: a small local server (`e2e/stubs/cloud-api.ts`) that records requests,
  returns fake wamids, and can answer any error code. `WA_CLOUD_API_BASE` points at it, honoured
  only under `MT_TEST_MODE=1` (the existing test seam rule). It also posts signed status and message
  webhooks back, so a whole round trip runs locally.
- **Sandboxed WhatsApp conversations** (`e2e/sim`, the existing pool and friend link scenarios):
  each scenario gains a channel per actor, and new ones cover a stranger signing up on the
  official number, a member on both numbers, a reply in the wrong chat, STOP in English and
  Turkish, a closed window, a paused template, a duplicate webhook and a bad signature.
- **Playwright**: the login page with the copy code flow, and `/play` showing the official number.
- **Meta's test number**: one manual smoke test to your own phone before the real number goes
  live (sends from the test number need no payment method; the free and recipient cap details are
  UNVERIFIED item 3).
- No model calls: the DM reader is stubbed in these suites, as today, so every suite costs $0.

### 5.10 The PRs, in order (TDD in each: red, green, refactor)

| PR | What | Depends on |
| --- | --- | --- |
| C0 | This plan | |
| C1 | `send-channel.ts` and `waNumberFor`, pure, flags off; source guard test | |
| C2 | Schema: `PlatformJob` columns, `WaInbound`, `CloudTemplateStatus`; Pi claim filters `baileys` (migration applied by hand before deploy) | C1 |
| C3 | Pure refactor: `handleInboundDm` out of the dm-reply route, zero behaviour change | |
| C4 | Cloud client, stub server, dispatcher, error classifier, cron sweep (also runs the pool sweeps) | C2 |
| C5 | Webhook route: handshake, signature, dedupe, statuses, `after()` into `handleInboundDm` | C3, C4 |
| C6 | Template registry, EN and TR copy, sync script (dry run), template status handling | C4 |
| C7a | Codes on `mt_code` (and the login page copy) | C5, C6, your setup |
| C7b | `/play`, member pool step and friend link point at the official number; welcome free form | C5 |
| C7c | Pool offers, placed, paused, plan changed, details question | C7b |
| C7d | Club invitations; friend given back and taken out | C7c |
| C8 | Opt-out wiring (`user_preferences`, 131050), dashboard tiles (quality, limit tier, templates) | C5 |

Adversarial second reviews on C5 (security), C7a (login) and C7c (messages to strangers). Each
switch on is one flag, flipped by you or on your go, one flow at a time, with a watched first day.

## 6. Risks and decisions

Decided on 4 Nov 2026 by the main session (Kemal delegated the open questions). Built into PR C1
(`src/lib/send-channel.ts`) where they are code.

1. **Pool offers: utility or marketing? Decided: submit as utility.** If Meta approves or
   re-categorises them as marketing (about 3 times the price, and marketing must move to the
   Marketing Messages API before 13 October 2027), that is accepted at today's volumes. Before
   volumes grow past about $2 a month of offer spend, the main session tells Kemal the cost.
2. **A rejected template. Decided: its flow stays on the club number until Meta approves it.**
   The purpose stays out of `CLOUD_API_PURPOSES` until then; we edit and resubmit, make a new one,
   or ask for a review (category reviews within 60 days). Nothing breaks.
3. **Display name. Decided: "MatchTime", with "MatchTime by Cressoft" as the fallback** if Meta
   refuses it. It should pass because matchtime.ai carries the brand and names Cressoft
   Consultancy Limited, but Meta reviews it only when the limit rises (UNVERIFIED item 5).
4. **Login and sign-up codes. Decided: Meta's authentication template (`mt_code`)**, not the
   reverse flow. £0.0159 each, the familiar one step flow.
5. **Codes when the official number is down. Decided: fall back to the club number, codes only**,
   since the person asked for the code. Nothing else ever falls back (`fallbackWhenCloudDown`).
6. **Partner asks. Decided: stay on the club number** (3.6). `partner-ask` links are pinned to the
   club number in `waLinkChannelFor`.
7. **The one-off pool invite to a partner club's player. Decided: stays on the club number**
   (3.8). `pool-partner-invite` is a club number purpose in `channelFor`.
8. **The "save our official number" DM to today's pool players** (5.4). **Decided: it needs
   Kemal's go on the day it is sent**, since it queues messages.
9. **Business verification documents.** Meta's list for UK companies is UNVERIFIED; have the
   Companies House certificate and a bank statement for the registered office ready.
10. **Quality and limits.** Until verified, 250 people a day outside a window. Blocks marked
    "Didn't sign up" lower the rating; the caps (2 offers a week, 1 a day, quiet hours) and the
    consent wording on `/play`, which names MatchTime and WhatsApp
    (`src/lib/i18n/pool-play.en.ts:86`), keep this low.
11. **Meta's policy bans "unauthorized third-party tools"** (`WA/about-the-platform`). The
    official account never touches Baileys and the club number is never added to the business
    portfolio, but both numbers belong to MatchTime. A ban of the club number should not reach
    the official one; that is not something Meta documents.
12. **Service replies are no longer free past 1,000 a month per number** (since 1 Oct 2026). At
    today's volume this is irrelevant; in the busy scenario it adds about £8 a month.
13. **Usernames**: a small share of people may arrive with no phone number (5.4). Handled, not
    solved; worth watching once usernames spread.

### 6.1 The channel table as built in PR C1

With `CLOUD_API_ENABLED` off (the default) every row is the club number. With it on:

| Purpose or link | Class | Channel |
| --- | --- | --- |
| `otp` | first contact | official when listed; falls back to the club number if the official one is down |
| `pool-welcome` | first contact and answer | where he wrote; with no message (joined on the web), official when listed |
| `pool-details-ask`, `pool-offer`, `pool-placed`, `pool-paused`, `pool-removed` | first contact | official when listed |
| `club-invite-ask`, `club-invite-link`, `club-invite-closed` | first contact | official when listed |
| `friend-removed`, `friend-out` | first contact | official when listed |
| `pool-code-reply`, `pool-reply`, `friend-booked`, `friend-not-booked`, `setup-reply` | answer | where he wrote; club number when that is not known |
| `connect-reply`, `organiser-decision`, `billing`, `setup-*` (learned, ask, admin code, reminder, removed, owner live), `pool-partner-invite`, every `owner-*` | club number | always the club number |
| Every BotJob (club DMs, HQ, group posts) | not asked | always the club number |
| wa.me links `pool-signup`, `friend-signup`, `member-pool-join` | pool door | official when `pool-welcome` is listed |
| wa.me links `club-connect`, `partner-ask` | club door | always the club number |

`waNumberFor(channel)` gives the digits: `MATCHTIME_WA_NUMBER` for the club number,
`WA_CLOUD_NUMBER` for the official one (null when unset, never the club number). Nothing calls
these yet: PR C2 makes `queuePlatformDm` call `channelFor` once and store the answer on the job,
and PR C7b moves the wa.me link sites onto `waNumberFor(waLinkChannelFor(...))` (updating the
allowlists in `send-channel-source-guard.test.ts` and `wa-number-server-only.test.ts`).

## 7. What was run

- Code read on `origin/main` at `6b73158a`.
- Production, read only, 4 Nov 2026 19:14 UTC: `PlatformJob` and `BotJob` counts by purpose and
  kind for 30 days, `PhoneOtp`, `PoolProfile`, `PoolOffer`, `PoolAsk`, `PartnerAsk`,
  `ClubPartnership`, `ClubInvitation`, `FriendLink`, `SentNotification` kinds. Code texts were
  classified by their fixed opening words only; no code was read.
- Meta docs and Meta's GBP and USD rate sheets, 4 Nov 2026.
- Cost: $0 (no model calls, no paid APIs, no messages sent).
