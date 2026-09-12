import fs from 'node:fs';
import path from 'node:path';

/**
 * Single-instance guard.
 *
 * Two bots on one account is the worst failure mode this program has: both see
 * the same signal, both open a position, and every risk limit is silently
 * doubled — the daily loss stop included. It happens easily, because a stale
 * process from an earlier run is invisible unless you go looking for it.
 *
 * The lock is a file holding the owner's PID. A lock whose process is gone is
 * stale and taken over, so a crash or a kill does not need manual cleanup.
 */
export class InstanceLock {
  private acquired = false;

  constructor(private readonly file: string) {}

  /** Returns the PID of the live owner, or null if the lock was taken. */
  tryAcquire(): number | null {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });

    const existing = this.readPid();
    if (existing !== null && existing !== process.pid && isAlive(existing)) {
      return existing;
    }

    fs.writeFileSync(this.file, String(process.pid));
    this.acquired = true;

    // Guard against two starts racing: whoever wrote last owns it.
    if (this.readPid() !== process.pid) {
      this.acquired = false;
      return this.readPid();
    }
    return null;
  }

  release(): void {
    if (!this.acquired) return;
    try {
      if (this.readPid() === process.pid) fs.unlinkSync(this.file);
    } catch { /* already gone */ }
    this.acquired = false;
  }

  private readPid(): number | null {
    try {
      const pid = Number(fs.readFileSync(this.file, 'utf8').trim());
      return Number.isInteger(pid) && pid > 0 ? pid : null;
    } catch {
      return null;
    }
  }
}

/** Signal 0 tests for existence without touching the process. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to someone else — still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
