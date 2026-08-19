const webpush = require('web-push');
const db = require('../db');

let configured = false;

// Push only works once a VAPID key pair is set in the environment (see
// .env.example). Without it, isConfigured() is false everywhere and every
// send silently does nothing instead of breaking the feature it's attached to.
function isConfigured() {
  if (configured) return true;
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return false;
  webpush.setVapidDetails(VAPID_SUBJECT || 'mailto:admin@example.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  configured = true;
  return true;
}

// Sends the same notification to every subscribed device across all
// players. Subscriptions that the push service reports as gone (410/404 —
// the user uninstalled, cleared site data, etc.) are pruned automatically.
async function sendToAllPlayers({ title, body, url }) {
  if (!isConfigured()) return { sent: 0, failed: 0, configured: false };

  const { rows: subs } = await db.query('SELECT id, endpoint, p256dh, auth FROM push_subscriptions');
  const payload = JSON.stringify({ title, body, url: url || '/dashboard' });

  let sent = 0;
  let failed = 0;

  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload);
        sent += 1;
      } catch (err) {
        failed += 1;
        if (err.statusCode === 404 || err.statusCode === 410) {
          await db.query('DELETE FROM push_subscriptions WHERE id = $1', [sub.id]);
        }
      }
    })
  );

  return { sent, failed, configured: true };
}

module.exports = { isConfigured, sendToAllPlayers };
