// Simplified Reno-style congestion controller (RFC 9002 Section 7 style,
// without bandwidth probing / persistent congestion).

export class CongestionController {
  constructor(options) {
    this.maxPacketSize = options.maxPacketSize;
    this.congestionWindow = options.initialWindowPackets * options.maxPacketSize;
    this.initialWindow = this.congestionWindow;
    this.minimumWindow = options.minimumWindowPackets * options.maxPacketSize;
    this.slowStartThreshold = Infinity;
    this.inSlowStart = true;

    // Bytes considered "in flight" across every packet number space.
    this.bytesInFlight = 0;

    // Sent-time of the packet that opened the current recovery episode.
    this.recoveryStartTime = -Infinity;
    this.inRecovery = false;
  }

  get availableWindow() {
    return Math.max(0, this.congestionWindow - this.bytesInFlight);
  }

  canSend(size) {
    return this.bytesInFlight + size <= this.congestionWindow;
  }

  onPacketSent(packet) {
    if (packet.inFlight) this.bytesInFlight += packet.size;
  }

  onPacketAcked(packet) {
    if (packet.inFlight) this.bytesInFlight -= packet.size;

    // Reno exits recovery once an ACK covers a packet sent after the
    // recovery episode started.
    if (this.inRecovery && packet.timeSent > this.recoveryStartTime) {
      this.inRecovery = false;
    }

    if (this.inRecovery) return;

    if (this.inSlowStart) {
      // Slow start: grow one MSS per acknowledged MSS.
      this.congestionWindow += packet.size;
      if (this.congestionWindow >= this.slowStartThreshold) {
        this.inSlowStart = false;
      }
    } else {
      // Congestion avoidance: roughly one MSS per RTT.
      this.congestionWindow +=
        Math.max(1, this.maxPacketSize * packet.size / this.congestionWindow);
    }
  }

  // lossEvent: { sentTime, packetsLost }
  onPacketLost(lossEvent) {
    if (lossEvent.sentTime <= this.recoveryStartTime) return;

    this.recoveryStartTime = lossEvent.sentTime;
    this.inRecovery = true;

    // Multiplicative decrease, at most once per recovery episode.
    this.congestionWindow = Math.max(this.minimumWindow,
      this.congestionWindow / 2);
    this.slowStartThreshold = this.congestionWindow;
    this.inSlowStart = false;
  }
}
