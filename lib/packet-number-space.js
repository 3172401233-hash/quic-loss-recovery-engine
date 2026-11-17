// RFC 9002 Appendix A.6: one PacketNumberSpace per encryption level.
// Each space keeps its own sent-packet history, largest acked packet number
// and PTO/ack-eliciting bookkeeping. Handshake packets and application
// packets therefore never share a loss list.

export class PacketNumberSpace {
  constructor(name) {
    this.name = name;

    // Keyed by packet number; iteration order follows insertion order, and
    // packet numbers are always allocated monotonically.
    this.sentPackets = new Map();

    this.largestAcked = null;
    this.bytesInFlight = 0;
    this.ptoCount = 0;
  }

  add(packet) {
    this.sentPackets.set(packet.packetNumber, packet);
    if (packet.ackEliciting) {
      this.bytesInFlight += packet.size;
    }
  }

  get(packetNumber) {
    return this.sentPackets.get(packetNumber);
  }

  has(packetNumber) {
    return this.sentPackets.has(packetNumber);
  }

  remove(packetNumber) {
    const packet = this.sentPackets.get(packetNumber);
    if (packet === undefined) return null;
    this.sentPackets.delete(packetNumber);
    if (packet.ackEliciting && packet.inFlight) {
      this.bytesInFlight -= packet.size;
    }
    return packet;
  }

  oldestAckEliciting() {
    let oldest = null;
    for (const packet of this.sentPackets.values()) {
      if (packet.ackEliciting && packet.inFlight) {
        if (oldest === null || packet.timeSent < oldest.timeSent) {
          oldest = packet;
        }
      }
    }
    return oldest;
  }

  ackElicitingInFlight() {
    for (const packet of this.sentPackets.values()) {
      if (packet.ackEliciting && packet.inFlight) return true;
    }
    return false;
  }

  // Sent packets in ascending packet number order, oldest first.
  oldestFirst() {
    return [...this.sentPackets.values()];
  }
}
