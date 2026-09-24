import type { MutablePacket } from '@brownie/plugin-api';
import type { ServerActionQueue } from '../../outbound/ServerActionQueue.js';
import { PacketOrigin, type PacketContext, type PipelineStage } from '../PacketPipeline.js';

/**
 * Shows the session's outbound queue what the server sends.
 *
 * **Placed after the state stage and before the plugins, and both halves of
 * that matter.** After the state stage, because a queued packet is confirmed by
 * the world changing — the destination slot filling — and asking before the
 * world has been updated asks about the tick before. Before the plugins,
 * because a `FAILURE` has to put the queue into its backoff *first*: a plugin
 * that reacts to the same packet by asking for something else would otherwise
 * get its request queued as though nothing had happened.
 *
 * **The client's own packets are not shown here.** The queue has to see one of
 * those only once it has actually gone to the server — that is the moment
 * something of ours may follow it — and a stage runs before the packet is
 * forwarded. The session reports that moment itself; see
 * `ProxySessionOptions.onClientPacketPassed`.
 *
 * It never touches the packet. A stage that only reads is a stage that cannot
 * break traffic, and this one only reads.
 */
export class OutboundQueueStage implements PipelineStage {
  readonly name = 'outbound-queue';

  readonly #queue: ServerActionQueue;

  constructor(queue: ServerActionQueue) {
    this.#queue = queue;
  }

  handle(packet: MutablePacket, context: PacketContext): void {
    if (context.origin === PacketOrigin.Server) this.#queue.observe(packet);
  }
}
