import { Resend } from "resend";

function getResend() {
  return new Resend(process.env.RESEND_API_KEY);
}

const FROM_EMAIL = process.env.EMAIL_FROM || "MatchTime <noreply@resend.dev>";
const APP_URL = process.env.NEXTAUTH_URL || "https://matchtime.ai";

export async function sendVerificationEmail(
  email: string,
  code: string,
  name?: string | null
) {
  if (!process.env.RESEND_API_KEY) {
    console.log("RESEND_API_KEY not set, verification code:", code);
    return;
  }

  await getResend().emails.send({
    from: FROM_EMAIL,
    to: email,
    subject: `Your MatchTime verification code: ${code}`,
    html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f5f5f5; margin: 0; padding: 0;">
  <div style="max-width: 520px; margin: 40px auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
    <div style="background: linear-gradient(135deg, #16a34a, #15803d); padding: 32px; text-align: center;">
      <h1 style="color: white; margin: 0; font-size: 24px; font-weight: 700;">MatchTime</h1>
    </div>
    <div style="padding: 32px; text-align: center;">
      <p style="font-size: 16px; color: #333; margin: 0 0 8px;">Hi ${name || "there"},</p>
      <p style="font-size: 16px; color: #333; margin: 0 0 24px;">
        Enter this code to verify your email address:
      </p>
      <div style="background: #f0fdf4; border: 2px dashed #16a34a; border-radius: 12px; padding: 24px; margin: 24px 0;">
        <p style="font-size: 36px; font-weight: 700; letter-spacing: 8px; color: #15803d; margin: 0;">${code}</p>
      </div>
      <p style="font-size: 14px; color: #666; margin: 0;">
        This code expires in 10 minutes.
      </p>
    </div>
    <div style="padding: 16px 32px; background: #fafafa; border-top: 1px solid #eee; text-align: center;">
      <p style="font-size: 12px; color: #999; margin: 0;">Sent by MatchTime</p>
    </div>
  </div>
</body>
</html>
    `.trim(),
  });
}

export async function sendRatingEmails(
  matchId: string,
  activityName: string,
  matchDate: string,
  players: { email: string; name: string | null }[]
) {
  if (!process.env.RESEND_API_KEY) {
    console.log("RESEND_API_KEY not set, skipping email notifications");
    return;
  }

  const rateUrl = `${APP_URL}/matches/${matchId}/rate`;

  const results = await Promise.allSettled(
    players.map((player) =>
      getResend().emails.send({
        from: FROM_EMAIL,
        to: player.email,
        subject: `Rate your teammates - ${activityName}`,
        html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f5f5f5; margin: 0; padding: 0;">
  <div style="max-width: 520px; margin: 40px auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
    <div style="background: linear-gradient(135deg, #16a34a, #15803d); padding: 32px; text-align: center;">
      <h1 style="color: white; margin: 0; font-size: 24px; font-weight: 700;">MatchTime</h1>
    </div>
    <div style="padding: 32px;">
      <p style="font-size: 16px; color: #333; margin: 0 0 8px;">Hi ${player.name || "there"},</p>
      <p style="font-size: 16px; color: #333; margin: 0 0 24px;">
        The match <strong>${activityName}</strong> on <strong>${matchDate}</strong> has been completed!
        Time to rate your teammates and vote for Man of the Match.
      </p>
      <div style="text-align: center; margin: 32px 0;">
        <a href="${rateUrl}" style="display: inline-block; background: #16a34a; color: white; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-size: 16px; font-weight: 600;">
          Rate Players
        </a>
      </div>
      <p style="font-size: 14px; color: #666; margin: 0;">
        You can also rate players by visiting:<br>
        <a href="${rateUrl}" style="color: #16a34a;">${rateUrl}</a>
      </p>
    </div>
    <div style="padding: 16px 32px; background: #fafafa; border-top: 1px solid #eee; text-align: center;">
      <p style="font-size: 12px; color: #999; margin: 0;">Sent by MatchTime</p>
    </div>
  </div>
</body>
</html>
        `.trim(),
      })
    )
  );

  const sent = results.filter((r) => r.status === "fulfilled").length;
  const failed = results.filter((r) => r.status === "rejected").length;
  console.log(`Rating emails: ${sent} sent, ${failed} failed`);

  return { sent, failed };
}

// `sendBotHealthAlertEmail` was deleted on 2026-09-28. Routine health
// alerts are recorded for the owner's /admin/health page instead of being
// emailed; see src/lib/ops-alerts.ts. BOT_HEALTH_ALERT_EMAIL is unused.
