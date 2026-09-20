import type { MutablePacket } from '@brownie/plugin-api';
import type { ServerActionQueue } from '../../outbound/ServerActionQueue.js';
import { PacketOrigin, type PacketContext, type PipelineStage } from '../PacketPipeline.js';

/**
 * Shows the session's outbound queue everything that goes past.
 *
 * **Placed after the state stage and before the plugins, and both halves of
 * that matter.** After the state stage, because a queued packet is confirmed by
 * the world changing — the destination slot filling — and asking before the
 * world has been updated asks about the tick before. Before the plugins,
 * because a `FAILURE` has to put the queue into its backoff *first*: a plugin
 * that reacts to the same packet by asking for something else would otherwise
 * get its request queued as though nothing had happened.
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
    this.#queue.observe(packet, context.origin === PacketOrigin.Client);
  }
}
