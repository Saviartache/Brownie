import { createConnection } from 'node:net';
import type { Logger } from '../core/logging/Logger.js';
import type { ServerConnector, ServerTarget } from './ProxySession.js';
import { SocketTransport, type Transport } from './Transport.js';

/**
 * Opens real TCP connections to game servers.
 *
 * The transport starts paused and resumes on `connect`, so packets the game
 * client sends during the ~50 ms connect window are held rather than dropped.
 * That window is not hypothetical: the client sends its first packets
 * immediately, and dropping one desynchronises RC4 for the rest of the
 * connection.
 */
export class NetServerConnector implements ServerConnector {
  readonly #log: Logger;

  constructor(log: Logger) {
    this.#log = log.child('connector');
  }

  connect(target: ServerTarget): Transport {
    const socket = createConnection({ host: target.host, port: target.port });
    const transport = new SocketTransport(socket, { startPaused: true });
    socket.once('connect', () => {
      this.#log.debug(`connected to ${target.host}:${String(target.port)}`);
      transport.resume();
    });
    return transport;
  }
}
