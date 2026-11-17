import test from 'node:test';
import assert from 'node:assert/strict';
import { Recovery } from '../lib/recovery.js';
import { BLOCKED } from '../lib/constants.js';
import { encodeAckFrame } from '../lib/ack.js';

function send(recovery, now, count, space = 'application', options = {}) {
  for (let i = 0; i < count; i += 1) {
    recovery.queuePacket(space, options);
  }
  return recovery.sendBatch(now).sent;
}

test('each packet number space allocates independent packet numbers', () => {
  const recovery = new Recovery();
  const app = send(recovery, 0, 3, 'application');
  const handshake = send(recovery, 0, 2, 'handshake');
  const initial = send(recovery, 0, 2, 'initial');

  assert.deepEqual(app.map((p) => p.packetNumber), [0, 1, 2]);
  assert.deepEqual(handshake.map((p) => p.packetNumber), [0, 1]);
  assert.deepEqual(initial.map((p) => p.packetNumber), [0, 1]);
  assert.notEqual(app[0].space, handshake[0].space);
});

test('ACK in one space never touches packets in another space', () => {
  const recovery = new Recovery();
  const app = send(recovery, 0, 2, 'application');
  send(recovery, 0, 2, 'handshake');

  const result = recovery.onAck('application',
    encodeAckFrame(app.map((p) => p.packetNumber)), 50);

  assert.equal(result.ackedPackets.length, 2);
  assert.equal(recovery.spaces.get('application').sentPackets.size, 0);
  assert.equal(recovery.spaces.get('handshake').sentPackets.size, 2);
});

test('out-of-order ACK acknowledges every covered range', () => {
  const recovery = new Recovery();
  const packets = send(recovery, 0, 10);

  // ACK 0,1 and 4,5,6 before anything else: ranges, not a prefix.
  const result = recovery.onAck('application',
    encodeAckFrame([packets[0].packetNumber, packets[1].packetNumber,
      packets[4].packetNumber, packets[5].packetNumber,
      packets[6].packetNumber]), 50);

  assert.equal(result.ackedPackets.length, 5);
  assert.equal(recovery.spaces.get('application').largestAcked, 6);
  // Packets 2 and 3 are three or more numbers behind largestAcked, so the
  // packet threshold declares them lost at the same moment.
  assert.deepEqual(result.lostPackets.map((p) => p.packetNumber), [2, 3]);
  assert.equal(recovery.congestion.bytesInFlight, 3 * 1200);
});

test('duplicate ACK is idempotent and reports itself', () => {
  const recovery = new Recovery();
  const packets = send(recovery, 0, 4);
  const frame = encodeAckFrame([packets[0].packetNumber]);

  const first = recovery.onAck('application', frame, 50);
  const second = recovery.onAck('application', frame, 80);
  const third = recovery.onAck('application', frame, 110);

  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(third.duplicate, true);
  assert.equal(second.ackedPackets.length, 0);
  assert.equal(recovery.congestion.bytesInFlight, 3 * 1200);
  assert.equal(recovery.spaces.get('application').sentPackets.size, 3);
});

test('partial loss: packet threshold fires before the time threshold', () => {
  const recovery = new Recovery();
  const packets = send(recovery, 0, 6);

  // Skip packet 2; acknowledge 0,1,3,4,5 => largestAcked 5 means
  // packet 2 is 3 packet numbers behind the threshold.
  const acked = packets
    .map((p) => p.packetNumber)
    .filter((pn) => pn !== 2);
  const result = recovery.onAck('application', encodeAckFrame(acked), 10);

  const lostNumbers = result.lostPackets.map((p) => p.packetNumber);
  assert.deepEqual(lostNumbers, [2]);
  // Lost data is re-queued at the head for retransmission.
  assert.equal(recovery.pending[0].retransmitOf, 2);
});

test('partial loss: time threshold alone declares old packets lost', () => {
  const recovery = new Recovery();
  const packets = send(recovery, 0, 3);

  // Only the newest packet is ACKed: no packet-threshold gap of 3 yet.
  const result = recovery.onAck('application',
    encodeAckFrame([packets[2].packetNumber]), 10);
  assert.equal(result.lostPackets.length, 0);

  // The caller advances time past the threshold and re-runs detection.
  const threshold = recovery.rtt.lossDelay(3);
  const later = recovery.detectLostPackets('application', threshold + 1);
  const lostNumbers = later.map((p) => p.packetNumber).sort();
  assert.deepEqual(lostNumbers, [0, 1]);
});

test('retransmitted packets get fresh packet numbers in the same space', () => {
  const recovery = new Recovery({
    initialWindowPackets: 100,
    initialBurstPackets: 100,
    maxBurstPackets: 100
  });
  send(recovery, 0, 7);
  recovery.onAck('application',
    encodeAckFrame([6]), 10);

  const retx = recovery.sendBatch(5001).sent;
  // Packets 0..3 are at least three numbers behind largestAcked 6;
  // packets 4 and 5 remain outstanding.
  assert.deepEqual(retx.map((p) => p.packetNumber), [7, 8, 9, 10]);
  assert.deepEqual(retx.map((p) => p.retransmitOf), [3, 2, 1, 0]);
});

test('discarding a space frees in-flight bytes and pending entries', () => {
  const recovery = new Recovery();
  send(recovery, 0, 3, 'initial');
  recovery.queuePacket('initial');

  const before = recovery.congestion.bytesInFlight;
  assert.equal(before, 3 * 1200);

  const discarded = recovery.discardSpace('initial');
  assert.equal(discarded.droppedInFlight, 3);
  assert.equal(discarded.droppedPending, 1);
  assert.equal(recovery.congestion.bytesInFlight, 0);
  assert.throws(() => recovery.queuePacket('initial'), /discarded/);
});

test('sendBatch reports congestion-window blocking', () => {
  const recovery = new Recovery();
  send(recovery, 0, 10);
  recovery.queuePacket('application');
  const result = recovery.sendBatch(0);

  assert.equal(result.sent.length, 0);
  assert.equal(result.reason, BLOCKED.CONGESTION_WINDOW);
});

test('non-ack-eliciting packets stay in history but cost no window bytes', () => {
  const recovery = new Recovery();
  const packets = send(recovery, 0, 2, 'application',
    { ackEliciting: false });
  assert.equal(recovery.congestion.bytesInFlight, 0);

  const result = recovery.onAck('application',
    encodeAckFrame(packets.map((p) => p.packetNumber)), 10);
  assert.equal(result.ackedPackets.length, 2);
});

test('ack-only packets behind the loss threshold are never re-queued', () => {
  const recovery = new Recovery();
  recovery.queuePacket('application', { ackEliciting: false });
  recovery.queuePacket('application', { ackEliciting: false });
  for (let i = 0; i < 4; i += 1) recovery.queuePacket('application');
  recovery.sendBatch(0);

  const result = recovery.onAck('application',
    encodeAckFrame([2, 3, 4, 5]), 5000);
  assert.equal(result.lostPackets.length, 0);
  assert.equal(recovery.pending.length, 0);
  assert.equal(recovery.spaces.get('application').sentPackets.size, 2);
});
