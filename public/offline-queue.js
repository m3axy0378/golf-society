// Keeps a score submission from being silently lost when signal drops mid-round
// (common out on a course). A form that can't reach the server is saved to
// localStorage instead of failing, and gets retried automatically once the
// device is back online — from any page, not just the one it was queued on.
window.TeeLeagueOfflineQueue = (function () {
  const STORAGE_KEY = 'teeLeaguePendingScores';

  function readQueue() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    } catch {
      return [];
    }
  }

  function writeQueue(queue) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(queue));
  }

  function renderBanner(queue) {
    let banner = document.getElementById('offline-queue-banner');
    if (queue.length === 0) {
      if (banner) banner.remove();
      return;
    }
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'offline-queue-banner';
      banner.className = 'offline-banner';
      document.body.appendChild(banner);
    }
    banner.innerHTML = '';
    const text = document.createElement('span');
    text.textContent = queue.length === 1
      ? `Round for "${queue[0].competitionName}" saved on this device — will sync once you're back online.`
      : `${queue.length} rounds saved on this device — will sync once you're back online.`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Retry now';
    btn.className = 'btn-secondary';
    btn.addEventListener('click', flushQueue);
    banner.appendChild(text);
    banner.appendChild(btn);
  }

  // 'ok' = saved, 'rejected' = server reached but declined it (a real
  // validation error, not a connectivity problem), 'offline' = never reached it.
  async function trySend(item) {
    try {
      const res = await fetch(item.action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(item.payload),
        credentials: 'same-origin',
      });
      return res.ok ? 'ok' : 'rejected';
    } catch {
      return 'offline';
    }
  }

  let flushing = false;
  async function flushQueue() {
    if (flushing) return;
    flushing = true;
    try {
      const queue = readQueue();
      if (queue.length === 0) return;
      const remaining = [];
      let rejectedAny = false;
      for (const item of queue) {
        const result = await trySend(item);
        if (result === 'offline') remaining.push(item);
        else if (result === 'rejected') rejectedAny = true;
      }
      writeQueue(remaining);
      renderBanner(remaining);
      if (rejectedAny) {
        alert("One of your queued rounds couldn't be saved automatically (it may already be saved, or needs an admin's help) — check the competition page to confirm.");
      }
    } finally {
      flushing = false;
    }
  }

  // Used by a form's own submit handler: tries to send right away, and only
  // falls back to queueing if the request genuinely can't reach the server.
  async function submitOrQueue({ action, payload, competitionId, competitionName }) {
    if (navigator.onLine) {
      const result = await trySend({ action, payload });
      if (result === 'ok') return 'submitted';
      if (result === 'rejected') return 'rejected';
      // else 'offline' despite navigator.onLine — fall through to queue it.
    }
    const queue = readQueue();
    queue.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      action,
      payload,
      competitionId,
      competitionName,
      queuedAt: Date.now(),
    });
    writeQueue(queue);
    renderBanner(queue);
    return 'queued';
  }

  window.addEventListener('online', flushQueue);
  renderBanner(readQueue());
  if (navigator.onLine) flushQueue();

  return { submitOrQueue, flushQueue };
})();
