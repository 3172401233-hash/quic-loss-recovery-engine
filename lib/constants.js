// All time values in this engine are in milliseconds unless stated otherwise.

export const SPACES = ['initial', 'handshake', 'application'];

export const DEFAULT_OPTIONS = {
  // Maximum packet size; congestion window and bytes-in-flight use this unit.
  maxPacketSize: 1200,
  // RFC 9002 Section 6.2.2: packet threshold of 3.
  packetThreshold: 3,
  // RFC 9002 Section 7.2: initial RTT when no sample exists yet.
  initialRttMs: 333,
  // Granularity added to the loss time threshold.
  timerGranularityMs: 1,
  // PTO is armed at 1.5 * smoothed RTT (RFC 9002 Section 6.2.1).
  ptoFractionNumerator: 3,
  ptoFractionDenominator: 2,
  // RFC 9002 Section B.3: initial window is 10 * max datagram size.
  initialWindowPackets: 10,
  // Loss halves the congestion window, down to a floor of 2 packets.
  minimumWindowPackets: 2,
  // Pacing gain (rate multiplier). 2.5 in slow start, 1.25 in congestion
  // avoidance, matching the classic QUIC recovery draft values.
  pacingGainSlowStart: 2.5,
  pacingGainCongestionAvoidance: 1.25,
  // First burst before any RTT sample: allow a full initial window at once.
  initialBurstPackets: 10,
  // The token bucket may never hold credit beyond this many packets.
  maxBurstPackets: 2
};

// Why sendBatch() stopped producing packets.
export const BLOCKED = Object.freeze({
  NONE: 'none',
  NO_DATA: 'no_data',
  CONGESTION_WINDOW: 'congestion_window',
  PACING: 'pacing'
});
