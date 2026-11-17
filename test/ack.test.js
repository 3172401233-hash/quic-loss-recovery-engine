import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeAckRanges,
  encodeAckFrame,
  expandAckRanges,
  unwrapPacketNumber
} from '../lib/ack.js';

test('encode then decode round trips disjoint ACK ranges', () => {
  const frame = encodeAckFrame([1, 2, 3, 5, 8, 9]);
  assert.equal(frame.largestAcked, 9);
  assert.equal(frame.firstAckRange, 1);

  const ranges = decodeAckRanges(frame);
  assert.deepEqual(ranges, [[8, 9], [5, 5], [1, 3]]);
  assert.deepEqual(expandAckRanges(frame).sort((a, b) => a - b),
    [1, 2, 3, 5, 8, 9]);
});

test('a single contiguous block produces no sub-ranges', () => {
  const frame = encodeAckFrame([10, 11, 12, 13]);
  assert.deepEqual(frame.ranges, []);
  assert.deepEqual(decodeAckRanges(frame), [[10, 13]]);
});

test('duplicate packet numbers are deduplicated when encoding', () => {
  const frame = encodeAckFrame([4, 4, 5, 5, 6]);
  assert.deepEqual(expandAckRanges(frame).sort((a, b) => a - b),
    [4, 5, 6]);
});

test('decode handles a hand-built sparse frame (out-of-order arrival)', () => {
  // Largest 20: first range 17..20, gap skips 16, second range 14..15,
  // gap skips 13, third range 12..12.
  const frame = {
    largestAcked: 20,
    firstAckRange: 3,
    ranges: [
      { gap: 0, ackRange: 1 },
      { gap: 0, ackRange: 0 }
    ]
  };
  assert.deepEqual(decodeAckRanges(frame),
    [[17, 20], [14, 15], [12, 12]]);
});

test('empty ACK frame decodes to no ranges', () => {
  assert.deepEqual(decodeAckRanges({ largestAcked: null }), []);
});

test('packet number unwrapping matches RFC 9000 Appendix A.10 vectors', () => {
  assert.equal(unwrapPacketNumber(0xa82f, 16, 0xa82e), 0xa82f);
  assert.equal(unwrapPacketNumber(0xaf13, 16, 0xa82e), 0xaf13);
});

test('unwrapping before any packet is seen starts the space at zero', () => {
  assert.equal(unwrapPacketNumber(0, 16, null), 0);
  assert.equal(unwrapPacketNumber(7, 16, null), 7);
});
