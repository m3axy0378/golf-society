// Transactional email via Resend's HTTP API (https://resend.com) — a plain
// fetch call rather than their SDK, since sending one email is all we need.
// Optional, same pattern as lib/push.js: without RESEND_API_KEY and
// RESEND_FROM_EMAIL set, isConfigured() is false and sendPasswordResetEmail()
// quietly no-ops instead of breaking the reset flow — the request just won't
// receive an email (see .env.example for setup).
const RESEND_API_URL = 'https://api.resend.com/emails';

function isConfigured() {
  return Boolean(process.env.RESEND_API_KEY && process.env.RESEND_FROM_EMAIL);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// RESEND_FROM_EMAIL only needs to be an address (e.g. no-reply@teeleague.co.uk).
// The sender name shown in inboxes comes from societyName instead, so it stays
// in sync with the club's name in Admin → Settings rather than needing the env
// var reformatted by hand — this also tolerates someone having set it as the
// older "Name <address>" form, by discarding the name and keeping the address.
function fromHeader(societyName) {
  const raw = process.env.RESEND_FROM_EMAIL || '';
  const address = (raw.match(/<(.+)>/)?.[1] || raw).trim();
  return `${societyName} <${address}>`;
}

// Email clients strip <head> styles unpredictably and don't share the app's
// CSS, so this is a self-contained, inline-styled, table-based layout rather
// than reusing public/style.css — with a plain hex fallback stack (not
// "Inter") since web fonts aren't reliably available in an inbox. Colours
// are copied from the --color-navy/--color-gold tokens in public/style.css.
function buildHtml({ name, resetUrl, societyName, baseUrl }) {
  const safeName = escapeHtml(name);
  const safeSociety = escapeHtml(societyName);
  return `<!DOCTYPE html>
<html>
  <body style="margin:0; padding:0; background:#f5f3ee; font-family:Arial, Helvetica, sans-serif;">
    <span style="display:none; font-size:0; line-height:0; max-height:0; max-width:0; opacity:0; overflow:hidden;">Reset your ${safeSociety} password — this link expires in 1 hour.</span>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f3ee; padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px; width:100%; background:#ffffff; border-radius:10px; overflow:hidden;">
            <tr>
              <td align="center" style="background:#071a2b; padding:24px;">
                <img src="${baseUrl}/img/icon-192.png" width="40" height="40" alt="${safeSociety}" style="display:block; border-radius:8px;">
              </td>
            </tr>
            <tr>
              <td style="padding:32px 32px 8px; font-family:Arial, Helvetica, sans-serif;">
                <h1 style="margin:0 0 16px; font-size:20px; color:#071a2b;">Reset your password</h1>
                <p style="margin:0 0 16px; font-size:15px; line-height:1.5; color:#12202f;">Hi ${safeName},</p>
                <p style="margin:0 0 24px; font-size:15px; line-height:1.5; color:#12202f;">Someone asked to reset the password on your ${safeSociety} account. If that was you, set a new one below.</p>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:0 32px 24px;">
                <a href="${resetUrl}" style="display:inline-block; background:#c9a24a; color:#071a2b; font-weight:bold; font-size:15px; text-decoration:none; padding:12px 28px; border-radius:8px;">Set new password</a>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px 32px; font-family:Arial, Helvetica, sans-serif;">
                <p style="margin:0 0 12px; font-size:13px; line-height:1.5; color:#5b6b7a;">Or paste this link into your browser:<br><a href="${resetUrl}" style="color:#214f9b; word-break:break-all;">${resetUrl}</a></p>
                <p style="margin:0; font-size:13px; line-height:1.5; color:#5b6b7a;">This link expires in 1 hour. If you didn't request this, you can ignore this email — your password won't change.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

async function sendPasswordResetEmail({ to, name, resetUrl, societyName, baseUrl }) {
  if (!isConfigured()) {
    console.warn(`RESEND_API_KEY/RESEND_FROM_EMAIL not set — skipping password reset email to ${to}`);
    return { sent: false, configured: false };
  }

  const res = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: fromHeader(societyName),
      to,
      subject: `Reset your ${societyName} password`,
      html: buildHtml({ name, resetUrl, societyName, baseUrl }),
      text: `Reset your ${societyName} password: ${resetUrl}\n\nThis link expires in 1 hour. If you didn't request this, you can ignore this email — your password won't change.`,
    }),
  });

  if (!res.ok) {
    console.error('Resend email send failed', res.status, await res.text().catch(() => ''));
    return { sent: false, configured: true };
  }

  return { sent: true, configured: true };
}

module.exports = { isConfigured, sendPasswordResetEmail };
