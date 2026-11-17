import test from 'node:test';
import assert from 'node:assert/strict';
import { Recovery } from '../lib/recovery.js';
import { encodeAckFrame } from '../lib/ack.js';

test('PTO deadline is reported for the oldest ack-eliciting packet', () => {
  const recovery = new Recovery();
  for (let i = 0; i < 3; i += 1) recovery.queuePacket('application');
  recovery.sendBatch(100);

  const timeout = recovery.nextTimeout();
  assert.equal(timeout.space, 'application');
  // No sample yet: PTO = 1.5 * 333 + max(0, granularity 1).
  assert.equal(timeout.time, 100 + (1.5 * 333 + 1));
});

test('onTimeout before the deadline does nothing', () => {
  const recovery = new Recovery();
  for (let i = 0; i < 3; i += 1) recovery.queuePacket('application');
  recovery.sendBatch(0);

  const result = recovery.onTimeout(10);
  assert.equal(result.fired, false);
});

test('PTO expiry backs off exponentially and re-queues all outstanding data',
  () => {
    const recovery = new Recovery({
      initialBurstPackets: 100,
      maxBurstPackets: 100
    });
    for (let i = 0; i < 4; i += 1) recovery.queuePacket('application');
    recovery.sendBatch(0);

    const firstDeadline = recovery.nextTimeout().time;
    const first = recovery.onTimeout(firstDeadline);
    assert.equal(first.fired, true);
    assert.equal(first.ptoCount, 1);
    assert.equal(first.lostPackets.length, 4);

    // The re-queued packets are sent again at the timeout instant.
    const retx = recovery.sendBatch(firstDeadline).sent;
    assert.equal(retx.length, 4);
    // Each loss entry is unshifted, so the newest lost packet is re-sent
    // first (reverse order), then all get fresh ascending packet numbers.
    assert.deepEqual(retx.map((p) => p.retransmitOf), [3, 2, 1, 0]);
    assert.deepEqual(retx.map((p) => p.packetNumber), [4, 5, 6, 7]);

    // Next PTO uses the doubled duration.
    const secondDeadline = recovery.nextTimeout().time;
    assert.equal(secondDeadline,
      firstDeadline + 2 * (1.5 * 333 + 1));

    const second = recovery.onTimeout(secondDeadline);
    assert.equal(second.ptoCount, 2);
  });

test('an ACK after backoff resets the PTO count', () => {
  const recovery = new Recovery({
    initialBurstPackets: 100,
    maxBurstPackets: 100
  });
  for (let i = 0; i < 3; i += 1) recovery.queuePacket('application');
  recovery.sendBatch(0);

  const deadline = recovery.nextTimeout().time;
  recovery.onTimeout(deadline);
  const retx = recovery.sendBatch(deadline).sent;
  assert.equal(recovery.spaces.get('application').ptoCount, 1);

  recovery.onAck('application',
    encodeAckFrame(retx.map((p) => p.packetNumber)), deadline + 50);
  assert.equal(recovery.spaces.get('application').ptoCount, 0);
});

test('PTO state is independent across packet number spaces', () => {
  const recovery = new Recovery();
  for (let i = 0; i < 2; i += 1) {
    recovery.queuePacket('handshake');
    recovery.queuePacket('application');
  }
  recovery.sendBatch(0);

  const deadline = recovery.nextTimeout().time;
  const result = recovery.onTimeout(deadline);

  // Both spaces were sent at t=0, so the first space in iteration order
  // (handshake) fires; the application space is untouched.
  assert.equal(result.fired, true);
  assert.equal(result.space, 'handshake');
  assert.equal(recovery.spaces.get('handshake').ptoCount, 1);
  assert.equal(recovery.spaces.get('application').ptoCount, 0);
  assert.equal(recovery.spaces.get('application').sentPackets.size, 2);
});

test('ack-only packets do not arm the PTO timer', () => {
  const recovery = new Recovery();
  recovery.queuePacket('application', { ackEliciting: false });
  recovery.sendBatch(0);
  assert.equal(recovery.nextTimeout(), null);
  assert.equal(recovery.onTimeout(99999).fired, false);
});
