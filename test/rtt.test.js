import test from 'node:test';
import assert from 'node:assert/strict';
import { RttEstimator } from '../lib/rtt-estimator.js';
import { DEFAULT_OPTIONS } from '../lib/constants.js';

function makeEstimator() {
  return new RttEstimator(DEFAULT_OPTIONS);
}

test('starts from the RFC 9002 initial RTT of 333 ms', () => {
  const rtt = makeEstimator();
  assert.equal(rtt.effectiveRtt, 333);
  assert.equal(rtt.latestRtt, null);
});

test('first sample seeds smoothed RTT and half variance', () => {
  const rtt = makeEstimator();
  rtt.update({ latestRtt: 100, ackDelay: 0, now: 1000 });
  assert.equal(rtt.smoothedRtt, 100);
  assert.equal(rtt.rttVar, 50);
  assert.equal(rtt.minRtt, 100);
});

test('exponential averaging follows RFC 9002 weights', () => {
  const rtt = makeEstimator();
  rtt.update({ latestRtt: 100, ackDelay: 0, now: 0 });
  rtt.update({ latestRtt: 120, ackDelay: 0, now: 100 });

  // No ack delay: adjusted RTT equals the 120 ms sample.
  // rttvar = 0.75*50 + 0.25*|100-120| = 42.5
  assert.equal(rtt.rttVar, 42.5);
  // srtt = 0.875*100 + 0.125*120 = 102.5
  assert.equal(rtt.smoothedRtt, 102.5);
});

test('ack delay is added through min RTT, not applied raw', () => {
  const rtt = makeEstimator();
  rtt.update({ latestRtt: 100, ackDelay: 0, now: 0 });
  rtt.update({ latestRtt: 105, ackDelay: 20, now: 100 });
  // RFC 9002 A.8: the sample (105) is below min_rtt + ack_delay (120),
  // so the raw sample is used unchanged rather than inflating the RTT.
  assert.equal(rtt.smoothedRtt, 0.875 * 100 + 0.125 * 105);
  assert.equal(rtt.rttVar, 0.75 * 50 + 0.25 * 5);
});

test('ack delay is subtracted from a delayed sample', () => {
  const rtt = makeEstimator();
  rtt.update({ latestRtt: 100, ackDelay: 0, now: 0 });
  rtt.update({ latestRtt: 140, ackDelay: 20, now: 100 });
  // Adjusted RTT = 140 - 20 = 120.
  assert.equal(rtt.smoothedRtt, 0.875 * 100 + 0.125 * 120);
});

test('PTO doubles on every backoff level', () => {
  const rtt = makeEstimator();
  rtt.update({ latestRtt: 100, ackDelay: 0, now: 0 });
  const base = rtt.ptoDuration(0);
  assert.equal(rtt.ptoDuration(1), base * 2);
  assert.equal(rtt.ptoDuration(3), base * 8);
});

test('PTO includes 1.5x smoothed RTT and four times RTT variance', () => {
  const rtt = makeEstimator();
  rtt.update({ latestRtt: 100, ackDelay: 0, now: 0 });
  const expected = 1.5 * 100 + Math.max(4 * 50, 1);
  assert.equal(rtt.ptoDuration(0), expected);
});

test('an abrupt RTT jump is flagged as a spike', () => {
  const rtt = makeEstimator();
  rtt.update({ latestRtt: 100, ackDelay: 0, now: 0 });
  rtt.update({ latestRtt: 110, ackDelay: 0, now: 100 });
  assert.equal(rtt.isRttSpike(500), true);
  assert.equal(rtt.isRttSpike(120), false);
});

test('loss delay is the packet-threshold/time-threshold maximum', () => {
  const rtt = makeEstimator();
  rtt.update({ latestRtt: 100, ackDelay: 0, now: 0 });
  // max(3 * srtt, 1.125 * latest) => max(300, 112.5)
  assert.equal(rtt.lossDelay(3), 300);
});
