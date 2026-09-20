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
 * **The server last chosen is remembered, and a connection anywhere else is
 * returned to it.** The first join of the runtime arms the memory, and `/con`
 * is what moves it after that. Two things can land the client on the wrong
 * server, and both are watched for:
 *
 * - a *keyless* `RECONNECT` from a server, naming another host — the game
 *   moving a kicked or dropped character on to wherever it thinks fit. The
 *   packet is rewritten in flight to name the chosen server, so the client
 *   never dials the wrong host at all.
 * - the client dialling on its own — after a dropped link it goes back to the
 *   server its own settings name, and a server picked in the game's own chooser
 *   looks exactly the same from here. The dial is judged at `HELLO`, the first
 *   packet of every session, where the wrong host is answered with a
 *   `RECONNECT` of our own — which is how `/con` itself moves the client.
 *
 * **A seat is never dropped.** A reconnect that carries a key is a world the
 * server is holding a place in — a dungeon, a realm — and a `HELLO` that
 * presents one is the client taking that place. Both pass untouched, whatever
 * host they name: a dungeon is a connection too, and the one thing this module
 * must not do is bounce a character out of a dungeon it just entered.
 *
 * Returning gives up after a few attempts that never landed. A chosen server
 * that is down turns return-and-fallback into a loop — each return fails, the
 * game falls back, the return fires again — and settling wherever the game
 * itself landed, which then becomes the chosen server, beats bouncing forever.
 */

import {
  PluginCategory,
  definePlugin,
  type MutablePacket,
  type Plugin,
  type SessionView,
} from '@brownie/plugin-api';
import { GameId } from '../../constants/GameId.js';
import { GAME_SERVERS, findServer, serverAt, type GameServer } from './serverList.js';

/**
 * The port every game server listens on.
 *
 * Also the port the module's connect hook watches, which is why it is fixed
 * here: a reconnect naming any other port would be dialled straight past the
 * proxy, and a session we cannot see is worse than one we refused.
 */
const GAME_PORT = 2050;

/**
 * How many returns may fail to land before the module stops sending them.
 *
 * Three is every bounce of a loop that has no reason to stop on its own: each
 * failed return costs the client a connection attempt, and a player watching
 * their character flip between two servers wants it settled, not pursued.
 */
const MAX_RETURN_ATTEMPTS = 3;

export function createServerSwitchPlugin(): Plugin {
  const listing = GAME_SERVERS.map((server) => server.name).join(', ');

  return definePlugin({
    meta: {
      id: 'server-switch',
      name: 'Server Switch',
      category: PluginCategory.Commands,
      description:
        'Adds /con, which connects to another game server by name and remembers it, and /ip; connections to any other server are returned to the remembered one.',
    },

    setup(context) {
      /**
       * The server the player last chose, and how many returns to it have
       * failed to land.
       *
       * Deliberately not per session, and deliberately not cleared when one
       * ends: the return exists for exactly the connection change that ends a
       * session. Not persisted either — a restarted runtime has nothing to
       * check against, and the next join re-arms the memory.
       */
      let chosen: GameServer | undefined;
      let failedReturns = 0;

      context.commands.register({
        name: 'con',
        usage: '/con <name|abbreviation|address>',
        description: 'Connect to another game server.',
        run: (args, session) => {
          const query = args[0];
          if (query === undefined) {
            session.notify(`Servers: ${listing}`);
            if (chosen !== undefined) {
              session.notify(`Returning to ${chosen.name} when the game connects elsewhere.`);
            }
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

          // The choice is recorded before the client is sent anywhere, so the
          // session this opens lands on a server we mean to keep — and a
          // player re-choosing after a give-up starts counting from zero.
          chosen = match.server;
          failedReturns = 0;
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

      // A keyless reconnect naming another host is the game rerouting a kicked
      // or dropped character. Rewriting it in flight means the client never
      // dials the wrong server; a keyed one is a seat in a world and passes.
      context.packets.on('RECONNECT', (packet, session) => {
        if (chosen === undefined) return;
        const host = packet.string('host');
        if (host === undefined || host === chosen.host) return;
        if (seated(packet.get('key'))) return;

        const wrong = serverAt(host)?.name ?? host;
        context.log.info(`the game reconnected to ${wrong} (${host}); returning to ${chosen.name}`);
        session.notify(`The game moved you to ${wrong}; returning to ${chosen.name}.`);
        toChosen(packet, chosen);
      });

      // The client's own dial is judged at its first packet, by which time the
      // session's target is already resolved: a server link opens before the
      // pipeline runs. This is the path of a dropped link, where the game
      // reconnects to the server its own settings name.
      context.packets.on('HELLO', (packet, session) => {
        const host = session.server.host;
        // No resolved target means the session is refusing itself; there is no
        // server here to be wrong.
        if (host === '') return;

        if (chosen === undefined) {
          chosen = serverAt(host) ?? { name: host, host };
          context.log.info(`will return to ${chosen.name} (${host})`);
          return;
        }

        if (host === chosen.host) {
          // The return worked, whatever was tried before it.
          failedReturns = 0;
          return;
        }
        // A key presented here is a seat the game itself handed out — a dungeon
        // on another server, say — and is none of ours to refuse.
        if (seated(packet.get('key'))) return;

        if (failedReturns >= MAX_RETURN_ATTEMPTS) {
          context.log.warn(`gave up returning to ${chosen.name}: it looks unreachable`);
          session.notify(
            `Gave up returning to ${chosen.name} — it looks unreachable. /con ${chosen.name} to try again.`,
          );
          // Cleared, so wherever the game has settled becomes the chosen
          // server at the next join instead of the next thing to escape.
          chosen = undefined;
          failedReturns = 0;
          return;
        }

        failedReturns++;
        const wrong = serverAt(host)?.name ?? host;
        context.log.info(`connected to ${wrong} (${host}), not ${chosen.name}; returning`);
        session.notify(`Wrong server (${wrong}); returning to ${chosen.name}. /con to switch.`);
        reconnect(session, chosen.name, chosen.host);
      });
    },
  });
}

/** A key is a seat the server is holding; a connection presenting one passes. */
function seated(key: unknown): boolean {
  return Buffer.isBuffer(key) && key.length > 0;
}

/** Rewrites a reconnect in flight to the front door of the chosen server. */
function toChosen(packet: MutablePacket, chosen: GameServer): void {
  packet.set('name', chosen.name);
  packet.set('host', chosen.host);
  packet.set('port', GAME_PORT);
  packet.set('gameId', GameId.Nexus);
  packet.set('keyTime', -1);
  packet.set('key', Buffer.alloc(0));
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
