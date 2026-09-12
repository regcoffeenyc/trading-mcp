import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InstanceLock } from './lock.js';

function tmpLock(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'botlock-')), 'bot.lock');
}

test('the first instance acquires the lock', () => {
  const lock = new InstanceLock(tmpLock());
  assert.equal(lock.tryAcquire(), null, 'nothing was holding it');
  lock.release();
});

test('a second instance is refused while another live process holds the lock', () => {
  const file = tmpLock();
  // PID 1 always exists and is not this process. kill(1, 0) raises EPERM for an
  // unprivileged caller, which still proves the process is alive.
  const otherLivePid = 1;
  fs.writeFileSync(file, String(otherLivePid));

  const second = new InstanceLock(file);
  assert.equal(second.tryAcquire(), otherLivePid, 'should report the live owner and refuse');
  assert.equal(fs.readFileSync(file, 'utf8'), String(otherLivePid), 'must not steal a live lock');
});

test('re-acquiring a lock this process already owns succeeds', () => {
  const file = tmpLock();
  fs.writeFileSync(file, String(process.pid));
  const lock = new InstanceLock(file);
  assert.equal(lock.tryAcquire(), null, 'our own lock is not a conflict');
  lock.release();
});

test('a lock left by a dead process is taken over', () => {
  const file = tmpLock();
  // A PID that cannot be running: the kernel never assigns this one.
  fs.writeFileSync(file, '999999999');
  const lock = new InstanceLock(file);
  assert.equal(lock.tryAcquire(), null, 'a stale lock must not block startup');
  assert.equal(fs.readFileSync(file, 'utf8'), String(process.pid));
  lock.release();
});

test('a corrupt lock file does not block startup', () => {
  const file = tmpLock();
  fs.writeFileSync(file, 'not-a-pid');
  const lock = new InstanceLock(file);
  assert.equal(lock.tryAcquire(), null);
  lock.release();
});

test('release removes the file, and only its own', () => {
  const file = tmpLock();
  const lock = new InstanceLock(file);
  lock.tryAcquire();
  lock.release();
  assert.equal(fs.existsSync(file), false);

  // A lock this instance does not own must survive its release.
  fs.writeFileSync(file, '999999998');
  const other = new InstanceLock(file);
  other.release();
  assert.equal(fs.existsSync(file), true, 'must not delete another owner\'s lock');
});
