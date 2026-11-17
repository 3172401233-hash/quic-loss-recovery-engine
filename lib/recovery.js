import { EventEmitter } from 'node:events';
import { DEFAULT_OPTIONS, BLOCKED, SPACES } from './constants.js';
import { PacketNumberSpace } from './packet-number-space.js';
import { RttEstimator } from './rtt-estimator.js';
import { CongestionController } from './congestion.js';
import { Pacer } from './pacer.js';
import { decodeAckRanges } from './ack.js';

let packetSequence = 0;

export class Recovery extends EventEmitter {
  constructor(overrides = {}) {
    super();
    this.options = { ...DEFAULT_OPTIONS, ...overrides };

    // Three independent packet number spaces (RFC 9000 Section 12.3).
    this.spaces = new Map(
      SPACES.map((name) => [name, new PacketNumberSpace(name)])
    );
    this.nextPacketNumber = Object.fromEntries(SPACES.map((s) => [s, 0]));

    // Shared RTT, congestion window and pacer across the spaces.
    this.rtt = new RttEstimator(this.options);
    this.congestion = new CongestionController(this.options);
    this.pacer = new Pacer(this.options, this.rtt, this.congestion);

    // Single send queue: new data is pushed, retransmissions are unshifted
    // so lost data is re-sent ahead of fresh data (head-of-line priority).
    this.pending = [];
    this._hasRttSample = false;
  }

  // Queue application/handshake data for eventual transmission.
  queuePacket(spaceName, { size = this.options.maxPacketSize,
      ackEliciting = true, data = null } = {}) {
    this._requireSpace(spaceName);
    const entry = {
      id: packetSequence += 1,
      space: spaceName,
      size,
      ackEliciting,
      data,
      retransmitOf: null
    };
    this.pending.push(entry);
    return entry;
  }

  // Emit as many packets as the window/pacer/limit allow. All time is
  // supplied by the caller; the engine never reads a clock itself.
  sendBatch(now, limit = Infinity) {
    const sent = [];
    let reason = BLOCKED.NONE;

    while (sent.length < limit && this.pending.length > 0) {
      const entry = this.pending[0];
      if (!this.congestion.canSend(entry.size)) {
        reason = BLOCKED.CONGESTION_WINDOW;
        break;
      }
      if (!this.pacer.canSend(entry.size, now)) {
        reason = BLOCKED.PACING;
        break;
      }

      this.pending.shift();
      const packet = {
        id: packetSequence += 1,
        packetNumber: this.nextPacketNumber[entry.space]++,
        space: entry.space,
        size: entry.size,
        timeSent: now,
        ackEliciting: entry.ackEliciting,
        inFlight: entry.ackEliciting,
        data: entry.data,
        retransmitOf: entry.retransmitOf,
        acknowledged: false,
        lost: false
      };

      this.spaces.get(entry.space).add(packet);
      this.congestion.onPacketSent(packet);
      this.pacer.consume(entry.size);
      sent.push(packet);
    }

    if (reason === BLOCKED.NONE && this.pending.length === 0) {
      reason = BLOCKED.NO_DATA;
    }

    return {
      sent,
      reason,
      nextWakeUp: this._nextWakeUp(now)
    };
  }

  // Process an ACK frame for one packet number space.
  onAck(spaceName, frame, now) {
    const space = this._requireSpace(spaceName);
    const result = {
      space: spaceName,
      ackedPackets: [],
      lostPackets: [],
      duplicate: false,
      rttSample: null
    };

    let newlyAcked = false;
    for (const [low, high] of decodeAckRanges(frame)) {
      if (low < 0) {
        throw new RangeError(
          `ACK range contains negative packet number ${low}`);
      }
      for (let pn = low; pn <= high; pn += 1) {
        const packet = space.get(pn);
        // Unknown numbers are silently ignored: they may belong to a
        // discarded space or to packets that were never sent.
        if (packet === undefined || packet.acknowledged) continue;

        packet.acknowledged = true;
        space.remove(pn);
        this.congestion.onPacketAcked(packet);
        result.ackedPackets.push(packet);
        newlyAcked = true;
        if (space.largestAcked === null || pn > space.largestAcked) {
          space.largestAcked = pn;
        }
      }
    }

    // Duplicate or stale ACK: state must stay unchanged and idempotent.
    if (!newlyAcked) {
      result.duplicate = true;
      return result;
    }

    // RTT sample comes from the largest newly acknowledged packet.
    const largest = result.ackedPackets.reduce((a, b) =>
      b.packetNumber > a.packetNumber ? b : a);
    const latestRtt = now - largest.timeSent;
    const rttSample = {
      latestRtt,
      ackDelay: frame.ackDelay ?? 0,
      now
    };
    this.rtt.update(rttSample);
    if (!this._hasRttSample) {
      this._hasRttSample = true;
      this.pacer.onFirstSample();
    }
    result.rttSample = rttSample;

    // Any ACK progress resets the PTO backoff for this space.
    space.ptoCount = 0;

    // Local loss detection runs immediately after processing the ACK.
    result.lostPackets = this.detectLostPackets(spaceName, now);
    this.emit('ack', result);
    return result;
  }

  // RFC 9002 Section 6.2.2: packet threshold and time threshold.
  detectLostPackets(spaceName, now = Infinity) {
    const space = this._requireSpace(spaceName);
    if (space.largestAcked === null) return [];

    const lossDelay = this.rtt.lossDelay(this.options.packetThreshold);
    const lost = [];
    for (const packet of space.oldestFirst()) {
      if (!packet.ackEliciting || !packet.inFlight) continue;

      const packetThresholdLost =
        space.largestAcked - packet.packetNumber >=
        this.options.packetThreshold;
      const timeThresholdLost = packet.timeSent + lossDelay <= now;

      if (packetThresholdLost || timeThresholdLost) {
        lost.push(packet);
      }
    }

    if (lost.length > 0) {
      // One congestion reaction per loss episode, using the oldest sent time.
      const earliestSentTime = Math.min(...lost.map((p) => p.timeSent));
      for (const packet of lost) {
        this._removeAsLost(spaceName, packet.packetNumber);
      }
      this.congestion.onPacketLost({ sentTime: earliestSentTime });
      this.emit('loss', { space: spaceName, packets: lost });
    }
    return lost;
  }

  // Manually declare a single packet lost (also re-queues it).
  declareLost(spaceName, packetNumber) {
    const packet = this._removeAsLost(spaceName, packetNumber);
    if (packet === null) return null;
    this.congestion.onPacketLost({ sentTime: packet.timeSent });
    this.emit('loss', { space: spaceName, packets: [packet] });
    return packet;
  }

  _removeAsLost(spaceName, packetNumber) {
    const space = this._requireSpace(spaceName);
    const packet = space.remove(packetNumber);
    if (packet === null) return null;

    packet.lost = true;
    packet.inFlight = false;
    if (packet.ackEliciting) {
      this.congestion.bytesInFlight -= packet.size;
    }

    // Retransmissions jump the queue but keep the original data reference.
    this.pending.unshift({
      id: packetSequence += 1,
      space: spaceName,
      size: packet.size,
      ackEliciting: packet.ackEliciting,
      data: packet.data,
      retransmitOf: packet.packetNumber
    });
    return packet;
  }

  // Earliest PTO deadline across every space that has ack-eliciting traffic.
  nextTimeout() {
    let deadline = null;
    let deadlineSpace = null;
    for (const space of this.spaces.values()) {
      if (!space.ackElicitingInFlight()) continue;
      const oldest = space.oldestAckEliciting();
      const candidate =
        oldest.timeSent + this.rtt.ptoDuration(space.ptoCount);
      if (deadline === null || candidate < deadline) {
        deadline = candidate;
        deadlineSpace = space.name;
      }
    }
    return deadline === null
      ? null
      : { time: deadline, space: deadlineSpace };
  }

  // PTO expiry: back off the timer and re-queue every outstanding
  // ack-eliciting packet of the timed-out space. Real RFC 9002 sends one or
  // two probe packets first; this simulator instead re-arms all outstanding
  // data so a stalled connection always resumes once the timer fires.
  onTimeout(now) {
    const timeout = this.nextTimeout();
    if (timeout === null || timeout.time > now) {
      return { fired: false };
    }

    const space = this.spaces.get(timeout.space);
    space.ptoCount += 1;

    const lostPackets = space.oldestFirst()
      .filter((packet) => packet.ackEliciting && packet.inFlight)
      .map((packet) => this._removeAsLost(space.name, packet.packetNumber));

    if (lostPackets.length > 0) {
      const earliestSentTime =
        Math.min(...lostPackets.map((p) => p.timeSent));
      this.congestion.onPacketLost({ sentTime: earliestSentTime });
    }

    this.emit('timeout', {
      space: space.name,
      ptoCount: space.ptoCount,
      packets: lostPackets
    });
    return {
      fired: true,
      space: space.name,
      ptoCount: space.ptoCount,
      lostPackets,
      nextTimeout: this.nextTimeout()
    };
  }

  // RFC 9000 Section 4.10/12.5: drop a packet number space (e.g. Initial
  // once the handshake completes).
  discardSpace(spaceName) {
    const space = this._requireSpace(spaceName);
    let droppedInFlight = 0;
    for (const packet of space.oldestFirst()) {
      if (packet.inFlight) {
        this.congestion.bytesInFlight -= packet.size;
        droppedInFlight += 1;
      }
    }
    const pendingBefore = this.pending.length;
    this.pending = this.pending.filter((entry) => entry.space !== spaceName);
    const droppedPending = pendingBefore - this.pending.length;
    this.spaces.delete(spaceName);
    return { droppedInFlight, droppedPending };
  }

  getStats() {
    const perSpace = {};
    for (const [name, space] of this.spaces) {
      perSpace[name] = {
        largestAcked: space.largestAcked,
        inFlight: space.bytesInFlight,
        outstanding: space.sentPackets.size,
        ptoCount: space.ptoCount
      };
    }
    return {
      rtt: {
        latest: this.rtt.latestRtt,
        smoothed: this.rtt.smoothedRtt,
        min: this.rtt.minRtt,
        variance: this.rtt.rttVar,
        pto: this.rtt.ptoDuration(0)
      },
      congestion: {
        window: this.congestion.congestionWindow,
        bytesInFlight: this.congestion.bytesInFlight,
        available: this.congestion.availableWindow,
        slowStart: this.congestion.inSlowStart,
        inRecovery: this.congestion.inRecovery
      },
      pacing: {
        rate: this.pacer.rate(),
        tokens: this.pacer.tokens
      },
      pending: this.pending.length,
      spaces: perSpace
    };
  }

  _nextWakeUp(now) {
    const timeout = this.nextTimeout();
    const head = this.pending[0];
    let pacingAt = null;
    if (head !== undefined && this.congestion.canSend(head.size)) {
      pacingAt = this.pacer.nextSendTime(head.size, now);
    }
    return {
      pacingAt,
      timeoutAt: timeout === null ? null : timeout.time,
      timeoutSpace: timeout === null ? null : timeout.space
    };
  }

  _requireSpace(spaceName) {
    const space = this.spaces.get(spaceName);
    if (space === undefined) {
      throw new Error(`unknown or discarded packet number space: ${spaceName}`);
    }
    return space;
  }
}
