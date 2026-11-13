import { readServerEnv } from "@/lib/b2-storage";
import { formatLockoutDuration } from "@/lib/vault-lockout";

export type LockoutEmailDispatchResult = {
  sent: boolean;
  method: "resend" | "webhook" | "supabase_auth" | "none";
};

function buildLockoutEmailContent(params: {
  toEmail: string;
  lockDurationMs: number;
  lockedUntil: number;
  lockoutCount: number;
  appOrigin: string;
}) {
  const durationLabel = formatLockoutDuration(params.lockDurationMs);
  const unlockIso = new Date(params.lockedUntil).toUTCString();
  const safeAppUrl = params.appOrigin
    ? `${params.appOrigin}/auth`
    : "https://thepapervault.vercel.app/auth";

  const subject = `Security Alert: Your PaperVault was locked for ${durationLabel}`;

  const text = [
    "The PaperVault — Security Alert",
    "================================",
    "",
    `Your encrypted vault (${params.toEmail}) has been temporarily locked for ${durationLabel} after repeated incorrect passphrase attempts (Lockout #${params.lockoutCount}).`,
    "",
    `Lockout Duration: ${durationLabel}`,
    `Unlocks At: ${unlockIso}`,
    "",
    "What happened:",
    "- Multiple incorrect vault passphrase attempts triggered an automatic sign-out.",
    "- After signing back in, another incorrect passphrase attempt occurred, triggering an escalating vault lockout.",
    "",
    "Recommended actions:",
    `1. If this was NOT you, sign in at ${safeAppUrl} and change your account login password immediately.`,
    "2. Your private diary, notes, gallery photos, and companion chats remain end-to-end encrypted and unreadable without your passphrase.",
    "3. If you forgot your passphrase, wait until the lockout ends, then click 'Forgot passphrase?' to recover using your Security Questions and Recovery Key.",
    "",
  ].join("\n");

  const html = `
  <div style="font-family: Georgia, 'Times New Roman', serif; background:#faf6ef; color:#2f2419; padding:32px 16px;">
    <div style="max-width:560px; margin:0 auto; background:#fffdf9; border:1px solid #e4d9c8; border-radius:14px; padding:28px;">
      <p style="margin:0 0 6px; font-size:13px; letter-spacing:0.08em; text-transform:uppercase; color:#9b5b2a; font-family:system-ui, sans-serif;">
        The PaperVault · Security Alert
      </p>
      <h1 style="margin:0 0 14px; font-size:24px; color:#2f2419;">
        Your Vault Has Been Locked for ${durationLabel}
      </h1>
      <p style="margin:0 0 16px; font-size:15px; line-height:1.6; font-family:system-ui, sans-serif; color:#4b3c2d;">
        We detected repeated incorrect passphrase attempts on your account (<strong>${params.toEmail}</strong>). For your protection, you were signed out and your vault has been locked.
      </p>
      <div style="background:#f6efe4; border:1px solid #e4d9c8; border-radius:10px; padding:14px 16px; margin-bottom:18px; font-family:system-ui, sans-serif; font-size:14px; color:#3d2e20;">
        <div><strong>Lockout Tier:</strong> Attempt #${params.lockoutCount}</div>
        <div style="margin-top:4px;"><strong>Duration:</strong> ${durationLabel}</div>
        <div style="margin-top:4px;"><strong>Unlocks At:</strong> ${unlockIso}</div>
      </div>
      <p style="margin:0 0 10px; font-size:14px; line-height:1.6; font-family:system-ui, sans-serif; color:#4b3c2d;">
        <strong>If this wasn&apos;t you:</strong> Change your login password immediately and verify your security questions.
      </p>
      <p style="margin:0 0 20px; font-size:14px; line-height:1.6; font-family:system-ui, sans-serif; color:#4b3c2d;">
        <strong>If you forgot your passphrase:</strong> Once the ${durationLabel} lockout expires, sign in and use <em>Forgot passphrase?</em> with your Security Questions and Recovery Key.
      </p>
      <a href="${safeAppUrl}" style="display:inline-block; background:#3f2d20; color:#fffdf9; text-decoration:none; padding:10px 18px; border-radius:8px; font-family:system-ui, sans-serif; font-size:14px; font-weight:600;">
        Open The PaperVault
      </a>
    </div>
  </div>`.trim();

  return { subject, text, html };
}

export async function sendVaultLockoutEmail(params: {
  request: Request;
  toEmail: string;
  lockDurationMs: number;
  lockedUntil: number;
  lockoutCount: number;
  supabaseUrl?: string;
  supabaseAnonKey?: string;
}): Promise<LockoutEmailDispatchResult> {
  const cleanEmail = params.toEmail.trim().toLowerCase();
  if (!cleanEmail || !cleanEmail.includes("@")) {
    return { sent: false, method: "none" };
  }

  let appOrigin = "";
  try {
    appOrigin = new URL(params.request.url).origin;
  } catch {
    appOrigin = "";
  }

  const content = buildLockoutEmailContent({
    toEmail: cleanEmail,
    lockDurationMs: params.lockDurationMs,
    lockedUntil: params.lockedUntil,
    lockoutCount: params.lockoutCount,
    appOrigin,
  });

  // 1. Primary: Resend API (when RESEND_API_KEY is configured)
  const resendKey = readServerEnv("RESEND_API_KEY", params.request);
  if (resendKey) {
    const fromAddr =
      readServerEnv("RESEND_FROM_EMAIL", params.request) ||
      "The PaperVault Security <onboarding@resend.dev>";
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${resendKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: fromAddr,
          to: [cleanEmail],
          subject: content.subject,
          html: content.html,
          text: content.text,
        }),
      });
      if (res.ok) {
        return { sent: true, method: "resend" };
      }
    } catch {
      // fall through to secondary methods
    }
  }

  // 2. Secondary: Custom email webhook (when EMAIL_WEBHOOK_URL is configured)
  const webhookUrl = readServerEnv("EMAIL_WEBHOOK_URL", params.request);
  if (webhookUrl) {
    try {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "vault_locked_out",
          to: cleanEmail,
          subject: content.subject,
          text: content.text,
          html: content.html,
          lockedUntil: params.lockedUntil,
          lockDurationMs: params.lockDurationMs,
          lockoutCount: params.lockoutCount,
        }),
      });
      if (res.ok) {
        return { sent: true, method: "webhook" };
      }
    } catch {
      // fall through
    }
  }

  // 3. Fallback: Supabase Auth recovery alert email so the user's inbox is alerted via Supabase's configured SMTP
  const sbUrl = (params.supabaseUrl || "").replace(/\/+$/, "");
  const sbKey = params.supabaseAnonKey || "";
  if (sbUrl && sbKey) {
    try {
      const redirectTo = appOrigin
        ? `${appOrigin}/auth?notice=vault_locked`
        : "/auth?notice=vault_locked";
      const res = await fetch(`${sbUrl}/auth/v1/recover`, {
        method: "POST",
        headers: {
          apikey: sbKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: cleanEmail,
          redirect_to: redirectTo,
        }),
      });
      if (res.ok) {
        return { sent: true, method: "supabase_auth" };
      }
    } catch {
      // ignore non-fatal dispatch error
    }
  }

  return { sent: false, method: "none" };
}
