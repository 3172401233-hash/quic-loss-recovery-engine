import test from 'node:test';
import assert from 'node:assert/strict';
import { Recovery, BLOCKED } from '../lib/index.js';

test('first burst is line-rate before any RTT sample exists', () => {
  const recovery = new Recovery();
  for (let i = 0; i < 10; i += 1) recovery.queuePacket('application');
  const batch = recovery.sendBatch(0);
  assert.equal(batch.sent.length, 10);
  assert.equal(batch.reason, BLOCKED.NO_DATA);
});

test('after the first sample the pacer spreads packets across the RTT', () => {
  const recovery = new Recovery({
    initialWindowPackets: 100,
    initialBurstPackets: 100
  });
  for (let i = 0; i < 2; i += 1) recovery.queuePacket('application');
  recovery.sendBatch(0);

  // 100 ms RTT sample: pacing bucket clamps to a two-packet burst.
  recovery.onAck('application',
    { largestAcked: 1, firstAckRange: 1, ranges: [] }, 100);
  assert.equal(recovery.pacer.capacity, 2 * 1200);

  for (let i = 0; i < 2; i += 1) recovery.queuePacket('application');
  const immediate = recovery.sendBatch(100);
  assert.equal(immediate.sent.length, 2);
  assert.equal(immediate.reason, BLOCKED.NO_DATA);

  // The next queued packet has no credit yet and gets a future pacing time.
  recovery.queuePacket('application');
  assert.equal(recovery.pacer.canSend(1200, 100), false);
  const pacingAt = recovery.pacer.nextSendTime(1200, 100);
  assert.ok(pacingAt > 100);

  // Advancing the caller's clock refills credit and unblocks sending.
  const later = recovery.sendBatch(pacingAt + 1);
  assert.equal(later.sent.length, 1);
});

test('pacing rate equals gain times window over smoothed RTT', () => {
  const recovery = new Recovery();
  for (let i = 0; i < 2; i += 1) recovery.queuePacket('application');
  recovery.sendBatch(0);
  recovery.onAck('application',
    { largestAcked: 1, firstAckRange: 1, ranges: [] }, 100);

  const expected = 2.5 * recovery.congestion.congestionWindow /
    recovery.rtt.smoothedRtt;
  assert.equal(recovery.pacer.rate(), expected);
});

test('pacing gain drops after loss pushes the sender out of slow start', () => {
  const recovery = new Recovery();
  for (let i = 0; i < 6; i += 1) recovery.queuePacket('application');
  recovery.sendBatch(0);
  assert.equal(recovery.pacer.gain, 2.5);

  recovery.onAck('application',
    { largestAcked: 5, firstAckRange: 2, ranges: [] }, 10);
  assert.equal(recovery.congestion.inSlowStart, false);
  assert.equal(recovery.pacer.gain, 1.25);
});

test('no pending traffic means nothing is scheduled', () => {
  const recovery = new Recovery();
  const result = recovery.sendBatch(0);
  assert.equal(result.reason, BLOCKED.NO_DATA);
  assert.equal(result.nextWakeUp.pacingAt, null);
  assert.equal(result.nextWakeUp.timeoutAt, null);
});
