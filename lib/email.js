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

async function sendPasswordResetEmail({ to, name, resetUrl, societyName }) {
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
      from: process.env.RESEND_FROM_EMAIL,
      to,
      subject: `Reset your ${societyName} password`,
      html: `<p>Hi ${escapeHtml(name)},</p>
<p>Someone asked to reset the password on your ${escapeHtml(societyName)} account. If that was you, set a new one here:</p>
<p><a href="${resetUrl}">${resetUrl}</a></p>
<p>This link expires in 1 hour. If you didn't request this, you can ignore this email — your password won't change.</p>`,
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
