import type { MutablePacket, SessionView } from '@brownie/plugin-api';
import type { PluginHost } from '../../plugins/PluginHost.js';
import { PacketOrigin, type PacketContext, type PipelineStage } from '../PacketPipeline.js';

/** What the client sends when the player presses enter in the chat box. */
const CHAT_PACKET = 'PLAYERTEXT';

/**
 * What marks a line as ours.
 *
 * The client sends whatever is typed, slash and all, and it is the *server*
 * that answers an unknown command. `Unrecognized command: {command}` does live
 * in the client's `resources.assets`, but as a localisation entry the client
 * renders when the server names the key — the same mechanism behind the
 * `{"k":"s.…"}` bodies `docs/protocol.md` records on `NOTIFICATION`. A message
 * appearing in the client's own string table is not evidence of where it came
 * from.
 *
 * So a command claimed here is dropped before the server ever sees it, and the
 * server never gets the chance to complain about it.
 */
const PREFIX = '/';

/**
 * Turns a line of chat into a plugin command.
 *
 * A plugin could already register commands and `PluginHost` could already run
 * them, but nothing connected the two: a registered command was unreachable,
 * which made the whole API dead code that read as though it worked.
 *
 * **A line the plugins do not claim is passed through untouched.** The game has
 * its own commands — `/tell`, `/who`, `/trade` — and a proxy that swallowed
 * every slash would break them. `dispatchCommand` returning false is what says
 * "not ours"; only a claimed command is dropped, so nothing else is lost and
 * nothing reaches the server as something the player appeared to say.
 *
 * Chat only, and only from the client. Nothing here reads what the server says.
 */
export class CommandStage implements PipelineStage {
  readonly name = 'commands';

  readonly #host: PluginHost;
  readonly #session: SessionView;

  constructor(host: PluginHost, session: SessionView) {
    this.#host = host;
    this.#session = session;
  }

  handle(packet: MutablePacket, context: PacketContext): void {
    if (context.origin !== PacketOrigin.Client || packet.name !== CHAT_PACKET) return;

    const text = packet.string('text');
    if (text === undefined || !text.startsWith(PREFIX)) return;

    const words = text.slice(PREFIX.length).trim().split(/\s+/);
    const name = words[0];
    // A bare prefix is not a command. Left alone rather than treated as one
    // with an empty name, which no plugin can have registered anyway.
    if (name === undefined || name === '') return;

    if (this.#host.dispatchCommand(name, words.slice(1), this.#session)) {
      packet.drop();
    }
  }
}
