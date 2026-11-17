// "Add as Second Device" codes: one per account at a time. While a code is live DC
// pauses that account's mail, so an unused code is cancelled after ttlMs.
export class DeviceLogins {
  constructor(rpc, { ttlMs = 5 * 60_000, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    this.rpc = rpc;
    this.ttlMs = ttlMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.byAccount = new Map();
  }

  async start(accountId) {
    const live = this.byAccount.get(accountId);
    if (live && ['waiting', 'transferring'].includes(live.state) && live.qr) {
      return { qr: live.qr, expiresAt: live.expiresAt };
    }
    const entry = { state: 'waiting', progress: 0, qr: null, expiresAt: Date.now() + this.ttlMs };
    this.byAccount.set(accountId, entry);
    const settle = (state) => {
      if (this.byAccount.get(accountId) !== entry) return;
      this.clearTimer(entry.timer);
      if (['waiting', 'transferring'].includes(entry.state)) entry.state = state;
      entry.qr = null;
      // DC paused this account's IO for the transfer.
      this.rpc.startIo(accountId).catch(() => {});
    };
    this.rpc.provideBackup(accountId).then(() => settle('done'), () => settle('failed'));
    try {
      entry.qr = await this.rpc.getBackupQr(accountId);
    } catch (e) {
      entry.state = 'failed';
      await this.rpc.stopOngoingProcess(accountId).catch(() => {});
      throw e;
    }
    entry.timer = this.setTimer(() => {
      if (entry.state !== 'waiting') return;
      entry.state = 'expired';
      this.rpc.stopOngoingProcess(accountId).catch(() => {});
    }, this.ttlMs);
    entry.timer?.unref?.();
    return { qr: entry.qr, expiresAt: entry.expiresAt };
  }

  onProgress(accountId, progress) {
    const entry = this.byAccount.get(accountId);
    // Progress before the code exists is DC preparing it, not a phone connecting.
    if (!entry?.qr || !['waiting', 'transferring'].includes(entry.state)) return;
    if (progress > 0 && progress < 1000) {
      entry.state = 'transferring';
      entry.progress = Math.round(progress / 10);
    }
  }

  async cancel(accountId) {
    const entry = this.byAccount.get(accountId);
    if (!entry || !['waiting', 'transferring'].includes(entry.state)) return;
    entry.state = 'cancelled';
    await this.rpc.stopOngoingProcess(accountId).catch(() => {});
  }

  status(accountId) {
    const entry = this.byAccount.get(accountId);
    if (!entry) return { state: 'idle', progress: 0 };
    return { state: entry.state, progress: entry.state === 'done' ? 100 : entry.progress };
  }
}
