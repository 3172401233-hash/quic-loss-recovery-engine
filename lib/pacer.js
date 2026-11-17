// Token-bucket pacer. The pacing rate is congestionWindow / smoothedRTT
// multiplied by a pacing gain; a burst allowance keeps the first window and
// short bursts line-rate.

export class Pacer {
  constructor(options, rtt, congestion) {
    this.options = options;
    this.rtt = rtt;
    this.congestion = congestion;

    this.maxPacketSize = options.maxPacketSize;
    this.capacity = options.initialBurstPackets * options.maxPacketSize;
    this.tokens = this.capacity;
    this.lastRefillTime = null;
    this.hasRttSample = false;
  }

  get gain() {
    return this.congestion.inSlowStart
      ? this.options.pacingGainSlowStart
      : this.options.pacingGainCongestionAvoidance;
  }
  // Bytes per millisecond.
  rate() {
    const rtt = Math.max(this.rtt.effectiveRtt, 1);
    return this.gain * this.congestion.congestionWindow / rtt;
  }

  refill(now) {
    if (this.lastRefillTime === null) {
      this.lastRefillTime = now;
      return;
    }
    if (!this.hasRttSample) return;
    const elapsed = now - this.lastRefillTime;
    if (elapsed > 0) {
      this.tokens = Math.min(this.capacity,
        this.tokens + elapsed * this.rate());
      this.lastRefillTime = now;
    }
  }

  canSend(size, now) {
    this.refill(now);
    return this.tokens >= size;
  }

  consume(size) {
    this.tokens -= size;
  }

  // Time at which enough credit will have accumulated for `size` bytes.
  nextSendTime(size, now) {
    this.refill(now);
    if (this.tokens >= size) return now;
    const rate = this.rate();
    return now + (size - this.tokens) / rate;
  }

  // Once the first RTT sample exists, clamp the bucket to a small burst so
  // the pacer actually spreads packets over the RTT.
  onFirstSample() {
    this.hasRttSample = true;
    this.lastRefillTime = null;
    this.capacity = Math.min(
      this.options.initialBurstPackets * this.maxPacketSize,
      this.options.maxBurstPackets * this.maxPacketSize);
    this.tokens = Math.min(this.tokens, this.capacity);
  }
}
