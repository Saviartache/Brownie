import type { MutablePacket, SessionView } from '@brownie/plugin-api';
import type { PluginHost } from '../../plugins/PluginHost.js';
import type { PacketContext, PipelineStage } from '../PacketPipeline.js';

/**
 * Offers each packet to the plugins.
 *
 * Deliberately thin: the ordering, gating and error isolation all live in the
 * host, because they are properties of *a plugin* rather than of a pipeline
 * position. What this stage contributes is where in the packet's journey that
 * happens — after state is current, before the packet is forwarded — and a
 * binding to the session the packet belongs to.
 *
 * One of these per session; one host for the process.
 */
export class PluginStage implements PipelineStage {
  readonly name = 'plugins';

  readonly #host: PluginHost;
  readonly #session: SessionView;

  constructor(host: PluginHost, session: SessionView) {
    this.#host = host;
    this.#session = session;
  }

  handle(packet: MutablePacket, _context: PacketContext): void {
    this.#host.dispatchPacket(packet, this.#session);
  }
}
