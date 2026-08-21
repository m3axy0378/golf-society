// Shared Web Push helpers used by both the Profile page's toggle and the
// auto-enable prompt shown right after signup. Notification permission can
// only ever be granted via the browser's own prompt — nothing here can
// silently turn notifications on without that.
window.TeeLeaguePush = (function () {
  function supported() {
    return 'serviceWorker' in navigator && 'PushManager' in window;
  }

  function csrfToken() {
    const meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.content : '';
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
  }

  async function getRegistration() {
    if (!supported()) return null;
    return navigator.serviceWorker.register('/sw.js');
  }

  async function getSubscription() {
    const reg = await getRegistration();
    if (!reg) return null;
    return reg.pushManager.getSubscription();
  }

  // Resolves to { ok: true } once actually subscribed, or
  // { ok: false, reason: 'unsupported' | 'denied' }.
  async function subscribe(vapidPublicKey) {
    const reg = await getRegistration();
    if (!reg) return { ok: false, reason: 'unsupported' };

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return { ok: false, reason: 'denied' };

    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
    });
    await fetch('/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken() },
      body: JSON.stringify({ subscription: sub }),
    });
    return { ok: true };
  }

  async function unsubscribe() {
    const sub = await getSubscription();
    if (sub) {
      await fetch('/push/unsubscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken() },
        body: JSON.stringify({ endpoint: sub.endpoint }),
      });
      await sub.unsubscribe();
    }
  }

  return { supported, getRegistration, getSubscription, subscribe, unsubscribe };
})();
