// Which user accounts to wake for a mail check on each drain run.
export const DRAIN_INTERVAL_MS = 3 * 60_000;
export const ACTIVE_WINDOW_MS = 24 * 3600_000;
// An hour at most before a dormant account answers a new contact's handshake.
export const SLOW_CYCLE_MS = 3600_000;

// Recently used accounts every run; the rest in slices, so each is still
// reached once per SLOW_CYCLE_MS without waking thousands at once.
export function planDrain({ accounts, now, isHeld, cursor = 0 }) {
  const active = [];
  const dormant = [];
  for (const [username, info] of Object.entries(accounts)) {
    if (username === '__bot__' || !info?.accountId) continue;
    if (now - (info.lastActiveAt || 0) <= ACTIVE_WINDOW_MS) active.push(info.accountId);
    else dormant.push(info.accountId);
  }
  const perRun = Math.ceil(dormant.length / (SLOW_CYCLE_MS / DRAIN_INTERVAL_MS));
  const start = dormant.length ? cursor % dormant.length : 0;
  const slice = Array.from({ length: perRun }, (_, i) => dormant[(start + i) % dormant.length]);
  const targets = [...new Set([...active, ...slice])].filter((id) => !isHeld(id));
  return { targets, active: active.length, dormant: dormant.length, cursor: dormant.length ? (start + perRun) % dormant.length : 0 };
}
