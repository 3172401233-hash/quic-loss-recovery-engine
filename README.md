# quic-loss-recovery-engine

纯 JavaScript 的 QUIC 丢包恢复状态机（教学/模拟器用）。**不包含加密，也不
触碰真实 socket**：所有入包由调用方构造，所有时间由调用方通过参数推进，引擎
内部没有任何 `Date.now()` / 定时器。

它解决的问题是：握手包和应用包共用一个丢失列表时，连续丢包会让吞吐归零，
之后即使 ACK 到达也无法恢复发送。本引擎为 Initial、Handshake、Application
维护三个互相隔离的包号空间，并把 RTT、PTO、局部丢失检测、拥塞窗口和 pacing
组织成一个可单步推进的状态机。

## 目录结构

| 文件 | 职责 |
| --- | --- |
| `lib/recovery.js` | 顶层 `Recovery` 状态机：发送队列、ACK 处理、丢失检测、PTO 超时、空间丢弃 |
| `lib/packet-number-space.js` | 单个包号空间的在途包表、largest acked、字节计数 |
| `lib/rtt-estimator.js` | smoothed RTT / RTTVAR / min RTT、PTO 时长、RTT 突变识别 |
| `lib/congestion.js` | 简化版 Reno 拥塞控制器（慢启动、拥塞避免、乘性减窗、恢复窗口） |
| `lib/pacer.js` | 令牌桶 pacing 速率控制器 |
| `lib/ack.js` | ACK range 编解码与包号展开（RFC 9000 §19.3、附录 A.10） |
| `lib/constants.js` | 默认参数与阻塞原因常量 |
| `test/` | `node --test` 测试套件 |

## 快速上手

```js
import { Recovery, encodeAckFrame } from './lib/index.js';

const recovery = new Recovery();           // 时间单位统一为毫秒

// 1. 排队并发送一批 Application 包
for (let i = 0; i < 5; i += 1) {
  recovery.queuePacket('application', { size: 1200 });
}
const { sent, reason, nextWakeUp } = recovery.sendBatch(/* now */ 0);

// 2. 调用方从网络收到 ACK 帧后驱动状态机
const frame = encodeAckFrame(sent.map((p) => p.packetNumber));
const result = recovery.onAck('application', frame, /* now */ 40);
// result.ackedPackets / result.lostPackets / result.rttSample

// 3. 调用方按 nextWakeUp 推进时钟，处理 PTO 超时
const timeout = recovery.nextTimeout();
if (timeout !== null && now >= timeout.time) {
  recovery.onTimeout(now);                 // 退避并重排队所有在途数据
}
```

引擎通过事件暴露内部动作：`recovery.on('ack' | 'loss' | 'timeout', ...)`。

## ACK range 与包号空间

- ACK 帧以 `{ largestAcked, firstAckRange, ranges: [{ gap, ackRange }],
  ackDelay }` 表示，语义与 RFC 9000 §19.3 一致，但不做 varint 线格式编解码。
  `decodeAckRanges` 解析为若干闭区间 `[low, high]`，`encodeAckFrame` 反向
  生成，二者可往返。
- 三个包号空间各自维护独立的包号计数器和在途 `Map`。某个空间的 ACK 只会
  命中该空间的包；重复 ACK、覆盖未发送包号的 ACK 都是幂等且安全的。
- `discardSpace('initial')` 实现 RFC 9000 §12.5 的空间丢弃，立即释放对应
  在途字节与排队数据。
- 截断包号用 `unwrapPacketNumber` 按 RFC 9000 附录 A.10 展开（含 RFC 测试
  向量）。

## RTT 与 PTO

RTT 估计器在三个空间之间共享，遵循 RFC 9002 §5.3 / 附录 A.8：

- 首个样本令 `smoothed_rtt = latest_rtt`、`rttvar = latest_rtt / 2`；
  之后使用 `1/8`、`1/4` 的指数加权。
- `min_rtt` 在简化的固定窗口（4 倍初始 RTT）后允许刷新；ACK delay 按
  A.8 规则从样本中扣除。
- 没有任何样本时使用 RFC 9002 的初始 RTT 333 ms。
- PTO 时长为 `1.5 * smoothed_rtt + max(4 * rttvar, 定时器粒度)`，每次该
  空间超时后乘以 2 的 `ptoCount` 次方（指数退避）；收到任何新 ACK 即归零。
- RTT 突变：当 `latest_rtt > smoothed_rtt + 3 * rttvar` 时判定为 spike，
  配合动态时间阈值避免把网络延迟尖峰误判成丢包。

## 丢失检测

每次处理 ACK 后自动运行 RFC 9002 §6.2.2 的双重判定（任一满足即判丢）：

- **包号阈值**：包号比 `largest_acked` 落后 3 个及以上；
- **时间阈值**：`sent_time + max(kPacketThreshold * smoothed_rtt,
  1.125 * latest_rtt) <= now`，阈值随 RTT 样本动态变化。

PTO 超时时，本引擎做了一个**刻意的简化**：RFC 9002 规定先发 1~2 个探测包，
而这里直接把该空间所有在途的 ack-eliciting 包标记丢失并重新排队。这样在
模拟器里连接永远不会因为等待探测响应而僵死——这正是“吞吐归零且不恢复”
缺陷的修复点。重传包使用新包号，并通过 `retransmitOf` 记录原包号。

## 采用的简化拥塞算法

`lib/congestion.js` 是 **Reno 风格的单窗口控制器**，不实现 BBR、带宽探测或
持续拥塞（persistent congestion）判定：

- **初始窗口** `iwnd = 10 * max_packet_size`（RFC 9002 附录 B.3），最小
  窗口 `2 * max_packet_size`。
- **慢启动**：每确认一个 MSS，窗口增加一个 MSS（按字节累计）。
- **拥塞避免**：窗口超过慢启动阈值后，每 RTT 约增加一个 MSS
  （`MSS * acked / cwnd` 逐包累计）。
- **乘性减窗**：一次恢复 episode 内，窗口**只减半一次**，下限为最小窗口，
  同时把慢启动阈值设为减半后的窗口并退出慢启动。
- **恢复窗口**：以触发 episode 的最早 `sent_time` 为界；当 ACK 覆盖了该
  时刻之后发送的包，episode 结束。同一 episode 内的后续丢失信号被忽略，
  避免重复减窗。
- `bytes_in_flight` 在三个包号空间之间共享；非 ack-eliciting 包（如纯
  ACK）不计入在途字节。

### Pacing

`lib/pacer.js` 用令牌桶实现，速率
`pacing_gain * congestion_window / smoothed_rtt`：

- 慢启动增益 `2.5`，拥塞避免增益 `1.25`（经典 QUIC recovery 取值）。
- 首个 RTT 样本到达前不做速率限制，允许一次性发满初始窗口，避免冷启动
  被 pacing 卡住；首个样本后令牌桶容量钳制到 2 个 MSS 的突发额度。
- `sendBatch` 在拥塞窗口或令牌不足时停止，并通过返回值 `reason`
  （`congestion_window` / `pacing` / `no_data`）和 `nextWakeUp` 告诉调用方
  下次何时推进。

## 测试

```bash
node --test
```

覆盖场景（49 个用例）：

- ACK 乱序 ranges、重复 ACK 幂等、编解码往返、包号展开 RFC 向量；
- 三个包号空间互相隔离、Initial 空间丢弃；
- RTT 指数平均、ACK delay 处理、RTT 突变、PTO 指数退避与 ACK 后复位；
- 包号阈值 / 时间阈值局部丢失、重传新包号与排队优先级；
- 慢启动增长、乘性减窗只触发一次、最小窗口、恢复 episode 结束、窗口关闭；
- pacing 冷启动突发、令牌耗尽与时钟推进后恢复、增益随慢启动状态切换；
- 端到端回归：连续全丢 → PTO → 重传 → ACK → 吞吐恢复。
