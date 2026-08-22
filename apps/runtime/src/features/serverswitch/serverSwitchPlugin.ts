/**
 * `/con` — moves the character to another game server, by name — and `/ip`,
 * which says which one this session is on.
 *
 * The move is a `RECONNECT` sent to the game client: the client drops the
 * connection it has and dials the address in the packet. What makes that reach
 * the proxy rather than bypass it is the module's connect hook, which sends any
 * dial for the game port to loopback and reports the address it was aimed at —
 * and that report is both how the new session learns its target and how the
 * allowlist comes to permit it. So the packet names the *real* server, not
 * loopback: the reference implementation wrote loopback and had to remember a
 * pending target across the reconnect, which the hook now answers for free.
 *
 * **Nexus, with no key.** A key is a seat the server is holding for this
 * character in a particular world, and there is no seat on a server we have not
 * spoken to yet — so the reconnect asks for the front door: `gameId` Nexus,
 * `keyTime` -1, an empty key. The reference implementation went the long way
 * round, putting the account guid in the key so it could recognise the client's
 * next `HELLO` and rewrite that key back to empty, because it carried its own
 * per-connection state across the reconnect. Nothing here does.
 *
 * Not automatic, and nothing here watches the world: it acts when the player
 * types, and never otherwise.
 */

import { PluginCategory, definePlugin, type Plugin, type SessionView } from '@brownie/plugin-api';
import { GameId } from '../../constants/GameId.js';
import { GAME_SERVERS, findServer, serverAt } from './serverList.js';

/**
 * The port every game server listens on.
 *
 * Also the port the module's connect hook watches, which is why it is fixed
 * here: a reconnect naming any other port would be dialled straight past the
 * proxy, and a session we cannot see is worse than one we refused.
 */
const GAME_PORT = 2050;

export function createServerSwitchPlugin(): Plugin {
  const listing = GAME_SERVERS.map((server) => server.name).join(', ');

  return definePlugin({
    meta: {
      id: 'server-switch',
      name: 'Server Switch',
      category: PluginCategory.Commands,
      description: 'Adds /con, which connects to another game server by name, and /ip.',
    },

    setup(context) {
      context.commands.register({
        name: 'con',
        usage: '/con <name|abbreviation|address>',
        description: 'Connect to another game server.',
        run: (args, session) => {
          const query = args[0];
          if (query === undefined) {
            session.notify(`Servers: ${listing}`);
            return;
          }

          const match = findServer(query);
          if (match.kind === 'ambiguous') {
            session.notify(`"${query}" could be ${match.names.join(', ')}.`);
            return;
          }
          if (match.kind === 'unknown') {
            session.notify(`No server matches "${query}". Type /con for the list.`);
            return;
          }

          const { name, host } = match.server;
          context.log.info(`connecting to ${name} (${host})`);
          session.notify(`Connecting to ${name}...`);
          reconnect(session, name, host);
        },
      });

      // Where the *session* is connected, which is the only address anyone can
      // act on: it is what the module reported the game dialling, so it answers
      // "did `/con` land" as well as "which server am I on".
      context.commands.register({
        name: 'ip',
        description: 'Show the game server this session is connected to.',
        run: (_args, session) => {
          const { host, port } = session.server;
          if (host === '') {
            session.notify('No game server yet.');
            return;
          }
          const known = serverAt(host);
          const where = `${host}:${String(port)}`;
          session.notify(known === undefined ? where : `${known.name}: ${where}`);
        },
      });
    },
  });
}

function reconnect(session: SessionView, name: string, host: string): void {
  session.sendToClient('RECONNECT', {
    name,
    host,
    port: GAME_PORT,
    gameId: GameId.Nexus,
    keyTime: -1,
    key: Buffer.alloc(0),
  });
}
