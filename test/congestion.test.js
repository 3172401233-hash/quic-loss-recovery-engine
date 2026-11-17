import test from 'node:test';
import assert from 'node:assert/strict';
import { Recovery, BLOCKED } from '../lib/index.js';
import { encodeAckFrame } from '../lib/ack.js';

test('initial window allows ten full-size packets and no more', () => {
  const recovery = new Recovery();
  for (let i = 0; i < 12; i += 1) recovery.queuePacket('application');

  const batch = recovery.sendBatch(0);
  assert.equal(batch.sent.length, 10);
  assert.equal(batch.sent.length, 10);
  assert.equal(recovery.congestion.availableWindow, 0);
});

test('window opens again as ACKs drain bytes in flight', () => {
  const recovery = new Recovery({
    initialBurstPackets: 100,
    maxBurstPackets: 100
  });
  for (let i = 0; i < 10; i += 1) recovery.queuePacket('application');
  recovery.sendBatch(0);

  recovery.onAck('application', encodeAckFrame([0, 1]), 50);
  assert.ok(recovery.congestion.availableWindow > 0);

  for (let i = 0; i < 3; i += 1) recovery.queuePacket('application');
  const next = recovery.sendBatch(50, 2);
  assert.equal(next.sent.length, 2);
});

test('slow start grows the window by one MSS per ACKed MSS', () => {
  const recovery = new Recovery();
  const packets = [];
  for (let i = 0; i < 5; i += 1) recovery.queuePacket('application');
  packets.push(...recovery.sendBatch(0).sent);
  const initialWindow = recovery.congestion.congestionWindow;

  recovery.onAck('application',
    encodeAckFrame(packets.map((p) => p.packetNumber)), 50);

  assert.equal(recovery.congestion.congestionWindow,
    initialWindow + 5 * 1200);
  assert.equal(recovery.congestion.inSlowStart, true);
});

test('a loss episode halves the window once and exits slow start', () => {
  const recovery = new Recovery();
  for (let i = 0; i < 6; i += 1) recovery.queuePacket('application');
  recovery.sendBatch(0);
  const before = recovery.congestion.congestionWindow;

  const result = recovery.onAck('application',
    encodeAckFrame([3, 4, 5]), 10);
  assert.ok(result.lostPackets.length > 0);
  // The ACKed packets first grow the window in slow start, then the loss
  // reaction halves the grown window exactly once.
  const grown = before + 3 * 1200;
  assert.equal(recovery.congestion.congestionWindow, grown / 2);
  assert.equal(recovery.congestion.inSlowStart, false);

  // Further losses from the same recovery episode do not halve again.
  const windowAfterFirstLoss = recovery.congestion.congestionWindow;
  // A second congestion signal inside the same episode is ignored.
  recovery.congestion.onPacketLost({
    sentTime: recovery.congestion.recoveryStartTime
  });
  assert.equal(recovery.congestion.congestionWindow,
    windowAfterFirstLoss);
});

test('the window never drops below the two-packet minimum', () => {
  const recovery = new Recovery();
  // Repeatedly halve by opening new recovery episodes with later sent times.
  let sentTime = 0;
  for (let episode = 0; episode < 10; episode += 1) {
    recovery.congestion.recoveryStartTime = -Infinity;
    recovery.congestion.inRecovery = false;
    recovery.congestion.onPacketLost({ sentTime: (sentTime += 1) });
  }
  assert.equal(recovery.congestion.congestionWindow, 2 * 1200);
});

test('recovery episode ends when an ACK covers a later-sent packet', () => {
  const recovery = new Recovery();
  for (let i = 0; i < 6; i += 1) recovery.queuePacket('application');
  recovery.sendBatch(0);
  recovery.onAck('application', encodeAckFrame([3, 4, 5]), 10);
  assert.equal(recovery.congestion.inRecovery, true);

  // Retransmissions are sent at t=20; ACKing one exits recovery.
  const retx = recovery.sendBatch(20).sent;
  assert.ok(retx.length > 0);
  recovery.onAck('application',
    encodeAckFrame([retx[0].packetNumber]), 60);
  assert.equal(recovery.congestion.inRecovery, false);
});

test('a closed window reports the blocking reason', () => {
  const recovery = new Recovery({ maxBurstPackets: 100 });
  for (let i = 0; i < 11; i += 1) recovery.queuePacket('application');
  recovery.sendBatch(0);

  const blocked = recovery.sendBatch(0);
  assert.equal(blocked.reason, BLOCKED.CONGESTION_WINDOW);
  assert.equal(blocked.sent.length, 0);
});
