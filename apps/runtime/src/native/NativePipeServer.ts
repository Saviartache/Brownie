import { createServer, type Server } from 'node:net';
import type { Logger } from '../core/logging/Logger.js';
import { SocketTransport } from '../proxy/Transport.js';
import type { NativeLink } from './NativeLink.js';

/** `\\.\pipe\<name>` — the only form a Windows named pipe takes. */
export function pipePath(name: string): string {
  return `\\\\.\\pipe\\${name}`;
}

export interface NativePipeServerOptions {
  readonly log: Logger;
  readonly link: NativeLink;
  /** Pipe name without the `\\.\pipe\` prefix. */
  readonly pipeName: string;
}

/**
 * Listens for the injected native module.
 *
 * Thin on purpose: everything about the conversation lives in
 * {@link NativeLink}, which knows nothing about pipes and is therefore testable
 * without one. This class only turns an accepted socket into a transport.
 *
 * Windows-only, and deliberately so — the peer is a DLL inside a Win32 game
 * process. On any other platform this refuses to start rather than pretending,
 * so the proxy half of the runtime still runs and says why the overlay is
 * absent.
 */
export class NativePipeServer {
  readonly #log: Logger;
  readonly #link: NativeLink;
  readonly #path: string;
  #server: Server | undefined;

  constructor(options: NativePipeServerOptions) {
    this.#log = options.log.child('native-pipe');
    this.#link = options.link;
    this.#path = pipePath(options.pipeName);
  }

  get listening(): boolean {
    return this.#server?.listening ?? false;
  }

  get path(): string {
    return this.#path;
  }

  async listen(): Promise<void> {
    if (process.platform !== 'win32') {
      throw new Error(
        'the native module connects over a Windows named pipe; the overlay is unavailable on this platform',
      );
    }
    if (this.#server !== undefined) throw new Error('the native pipe server is already listening');

    const server = createServer((socket) => {
      this.#link.accept(new SocketTransport(socket));
    });
    this.#server = server;

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.removeListener('listening', onListening);
        this.#server = undefined;
        reject(error);
      };
      const onListening = (): void => {
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.#path);
    });

    server.on('error', (error) => {
      this.#log.error('native pipe error', error);
    });
    this.#log.info(`waiting for the native module on ${this.#path}`);
  }

  async close(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    this.#link.disconnect('runtime shutting down');
    if (server === undefined) return;
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
}
