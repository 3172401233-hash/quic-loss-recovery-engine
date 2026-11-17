import test from 'node:test';
import assert from 'node:assert/strict';
import { Recovery } from '../lib/recovery.js';
import { encodeAckFrame } from '../lib/ack.js';

// Regression test for the original simulator bug: after a burst of losses
// throughput dropped to zero and never recovered even when ACKs arrived.
test('continuous loss followed by ACKs recovers throughput', () => {
  const recovery = new Recovery({
    initialBurstPackets: 100,
    maxBurstPackets: 100
  });
  const events = [];
  recovery.on('loss', (event) => events.push(['loss', event.packets.length]));
  recovery.on('timeout', (event) =>
    events.push(['timeout', event.ptoCount]));
  recovery.on('ack', (event) =>
    events.push(['ack', event.ackedPackets.length]));

  // Send a full initial window; the network drops every packet.
  for (let i = 0; i < 10; i += 1) recovery.queuePacket('application');
  const firstBatch = recovery.sendBatch(0);
  assert.equal(firstBatch.sent.length, 10);

  // No ACKs arrive; the full window keeps the sender stalled on the PTO.
  recovery.queuePacket('application');
  const stalled = recovery.sendBatch(50);
  assert.equal(stalled.sent.length, 0);
  assert.equal(recovery.pending.length, 1);

  // The caller advances time to the PTO deadline; the engine re-arms all
  // outstanding packets instead of leaving the connection stuck.
  const deadline = recovery.nextTimeout().time;
  const timeoutResult = recovery.onTimeout(deadline);
  assert.equal(timeoutResult.fired, true);
  // All ten lost packets are re-queued ahead of the fresh data.
  assert.equal(recovery.pending.length, 11);

  const retx = recovery.sendBatch(deadline).sent;
  assert.ok(retx.length >= 1);

  // The retransmission gets through and ACKs arrive: sending resumes.
  const ackedNumbers = retx.map((packet) => packet.packetNumber);
  recovery.onAck('application', encodeAckFrame(ackedNumbers),
    deadline + 60);

  const resume = recovery.sendBatch(deadline + 60);
  assert.ok(resume.sent.length >= 1);
  assert.equal(recovery.congestion.bytesInFlight > 0, true);
  assert.ok(events.some(([name]) => name === 'timeout'));
  assert.ok(events.some(([name]) => name === 'ack'));
});

test('a sudden RTT increase does not fabricate packet loss', () => {
  const recovery = new Recovery({
    initialWindowPackets: 100,
    initialBurstPackets: 100,
    maxBurstPackets: 100
  });
  // Stable 50 ms RTT for several round trips so rttvar settles down.
  let now = 0;
  for (let round = 0; round < 4; round += 1) {
    const batch = [];
    for (let i = 0; i < 2; i += 1) recovery.queuePacket('application');
    batch.push(...recovery.sendBatch(now).sent);
    now += 50;
    recovery.onAck('application',
      encodeAckFrame(batch.map((p) => p.packetNumber)), now);
  }
  const smoothed = recovery.rtt.smoothedRtt;

  // New packets sent at t=100 come back after a 500 ms delay.
  const latePackets = [];
  recovery.queuePacket('application');
  latePackets.push(...recovery.sendBatch(now).sent);

  const result = recovery.onAck('application',
    encodeAckFrame(latePackets.map((p) => p.packetNumber)), now + 500);
  assert.equal(result.lostPackets.length, 0);
  assert.ok(recovery.rtt.isRttSpike(500));
  // The estimator tracks the new path RTT instead of ignoring it.
  assert.ok(recovery.rtt.smoothedRtt > smoothed);
});

test('out-of-order and duplicate ACKs keep one consistent state', () => {
  const recovery = new Recovery({
    initialBurstPackets: 100,
    maxBurstPackets: 100
  });
  const packets = [];
  for (let i = 0; i < 8; i += 1) recovery.queuePacket('application');
  packets.push(...recovery.sendBatch(0).sent);

  const frame1 = encodeAckFrame([0, 1, 4]);
  const frame2 = encodeAckFrame([2, 3, 5]);
  const first = recovery.onAck('application', frame1, 40);
  const second = recovery.onAck('application', frame2, 60);
  const repeated = recovery.onAck('application', frame1, 70);

  assert.equal(first.ackedPackets.length + second.ackedPackets.length, 6);
  assert.equal(repeated.duplicate, true);
  assert.equal(recovery.spaces.get('application').largestAcked, 5);
  // Exactly two packets (6, 7) remain outstanding with correct byte count.
  assert.equal(recovery.congestion.bytesInFlight, 2 * 1200);
});

test('handshake and application spaces recover independently', () => {
  const recovery = new Recovery({
    initialBurstPackets: 100,
    maxBurstPackets: 100
  });
  for (let i = 0; i < 3; i += 1) {
    recovery.queuePacket('handshake');
    recovery.queuePacket('application');
  }
  recovery.sendBatch(0);

  // Handshake packets are lost; application packets are acknowledged.
  const appPackets = [...recovery.spaces.get('application').sentPackets
    .values()];
  const appAck = recovery.onAck('application',
    encodeAckFrame(appPackets.map((p) => p.packetNumber)), 30);
  assert.equal(appAck.ackedPackets.length, 3);

  const deadline = recovery.nextTimeout();
  assert.equal(deadline.space, 'handshake');
  const fired = recovery.onTimeout(deadline.time);
  assert.equal(fired.space, 'handshake');
  assert.equal(fired.lostPackets.length, 3);

  const retx = recovery.sendBatch(deadline.time).sent;
  assert.deepEqual(retx.map((p) => p.space),
    ['handshake', 'handshake', 'handshake']);

  // The shared RTT estimator learned from the application ACK anyway.
  assert.equal(recovery.rtt.latestRtt, 30);
});

test('discarding the Initial space never breaks later application traffic',
  () => {
    const recovery = new Recovery();
    for (let i = 0; i < 3; i += 1) recovery.queuePacket('initial');
    for (let i = 0; i < 3; i += 1) recovery.queuePacket('application');
    recovery.sendBatch(0);

    recovery.discardSpace('initial');
    assert.equal(recovery.spaces.has('initial'), false);

    const appPackets = [...recovery.spaces.get('application').sentPackets
      .values()];
    const result = recovery.onAck('application',
      encodeAckFrame(appPackets.map((p) => p.packetNumber)), 25);
    assert.equal(result.ackedPackets.length, 3);
    assert.equal(recovery.congestion.bytesInFlight, 0);
  });
