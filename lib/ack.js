// ACK range parsing/generation (RFC 9000 Section 19.3, range semantics only;
// no wire-format varints here) and packet number unwrapping
// (RFC 9002 Appendix A.10).

// Decode an ACK frame into inclusive [low, high] ranges, ordered from the
// largest packet numbers down to the smallest.
export function decodeAckRanges(frame) {
  const ranges = [];
  if (frame.largestAcked === undefined || frame.largestAcked === null) {
    return ranges;
  }

  let smallest = frame.largestAcked - frame.firstAckRange;
  ranges.push([smallest, frame.largestAcked]);

  for (const { gap, ackRange } of frame.ranges ?? []) {
    const largest = smallest - gap - 2;
    const low = largest - ackRange;
    ranges.push([low, largest]);
    smallest = low;
  }
  return ranges;
}

 // Encode a collection of acknowledged packet numbers into an ACK frame.
export function encodeAckFrame(ackedNumbers, ackDelay = 0) {
  const numbers = [...new Set(ackedNumbers)].sort((a, b) => a - b);
  if (numbers.length === 0) {
    throw new Error('cannot encode an ACK frame without acknowledged packets');
  }

  const ranges = [];
  let rangeStart = numbers[0];
  let prev = numbers[0];
  for (let i = 1; i < numbers.length; i += 1) {
    const number = numbers[i];
    if (number !== prev + 1) {
      ranges.push([rangeStart, prev]);
      rangeStart = number;
    }
    prev = number;
  }
  ranges.push([rangeStart, prev]);

  // Ranges are sent largest-first.
  ranges.reverse();
  const largestAcked = numbers[numbers.length - 1];
  const frame = {
    largestAcked,
    firstAckRange: largestAcked - ranges[0][0],
    ranges: [],
    ackDelay
  };

  let previousSmallest = ranges[0][0];
  for (let i = 1; i < ranges.length; i += 1) {
    const [low, high] = ranges[i];
    frame.ranges.push({
      gap: previousSmallest - high - 2,
      ackRange: high - low
    });
    previousSmallest = low;
  }
  return frame;
}

// Expand a truncated packet number using the largest packet number already
// seen in this packet number space.
export function unwrapPacketNumber(packetNumber, pnNbits, largestPacketNumber) {
  const pnWindow = 2 ** pnNbits;
  const pnWindowHalf = pnWindow / 2;
  const expected = largestPacketNumber === null ? 0 : largestPacketNumber + 1;
  let candidate = packetNumber +
    pnWindow * Math.floor((expected - packetNumber + pnWindowHalf) / pnWindow);
  if (largestPacketNumber !== null &&
      candidate <= largestPacketNumber - pnWindow) {
    candidate += pnWindow;
  }
  return candidate;
}

// Flatten decoded ranges to the individual packet numbers they cover.
export function expandAckRanges(frame) {
  const numbers = [];
  for (const [low, high] of decodeAckRanges(frame)) {
    for (let n = low; n <= high; n += 1) numbers.push(n);
  }
  return numbers;
}
