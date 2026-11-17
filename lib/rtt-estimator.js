// RFC 9002 Section 5.3 / Appendix A.8: shared across all packet number spaces.

export class RttEstimator {
  constructor(options) {
    this.initialRtt = options.initialRttMs;
    this.timerGranularity = options.timerGranularityMs;
    this.ptoFractionNumerator = options.ptoFractionNumerator;
    this.ptoFractionDenominator = options.ptoFractionDenominator;

    this.minRtt = null;
    this.smoothedRtt = null;
    this.rttVar = null;
    this.latestRtt = null;
    this.minRttTimestamp = null;
  }

  // sample: { latestRtt, ackDelay, now }
  update(sample) {
    const { latestRtt, ackDelay = 0, now } = sample;
    this.latestRtt = latestRtt;

    if (this.minRtt === null || latestRtt < this.minRtt ||
        this._isExpired(now)) {
      this.minRtt = latestRtt;
      this.minRttTimestamp = now;
    }

    if (this.smoothedRtt === null) {
      this.smoothedRtt = latestRtt;
      this.rttVar = latestRtt / 2;
      return;
    }

    // RFC 9002 Appendix A.8: subtract ack delay from the sample unless the
    // min RTT window is expired or the sample is no larger than min_rtt
    // plus the delay (in which case use the raw sample).
    const adjustedRtt = (this._isExpired(now) ||
        latestRtt < this.minRtt + ackDelay)
      ? latestRtt
      : latestRtt - ackDelay;

    this.rttVar = 0.75 * this.rttVar + 0.25 *
      Math.abs(this.smoothedRtt - adjustedRtt);
    this.smoothedRtt = 0.875 * this.smoothedRtt + 0.125 * adjustedRtt;
  }

  _isExpired(now) {
    // RFC 9002 resets min_rtt when it has not been challenged for a
    // persistent-congestion window. This simulator keeps a fixed window of
    // a handful of initial RTTs instead of deriving it from the RTT itself.
    return this.minRttTimestamp !== null &&
      now - this.minRttTimestamp > this.initialRtt * 4;
  }

  get effectiveRtt() {
    return this.smoothedRtt ?? this.initialRtt;
  }

  // RFC 9002 Section 6.2.1.
  ptoDuration(ptoCount) {
    const duration = (this.ptoFractionNumerator / this.ptoFractionDenominator) *
      this.effectiveRtt + Math.max(4 * (this.rttVar ?? 0),
      this.timerGranularity);
    return duration * 2 ** ptoCount;
  }

  // RFC 9002 Section 6.2.2: a sudden RTT increase larger than the time
  // threshold must not be misclassified as loss.
  isRttSpike(latestRtt) {
    if (this.smoothedRtt === null) return false;
    return latestRtt > this.smoothedRtt + 3 * this.rttVar;
  }

  // RFC 9002 Section 6.2.2: max(kPacketThreshold * srtt, 1.125 * latest_rtt).
  lossDelay(packetThreshold) {
    const latest = this.latestRtt ?? this.initialRtt;
    return Math.max(packetThreshold * this.effectiveRtt, 1.125 * latest);
  }
}
