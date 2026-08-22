import { parseRecord } from '@brownie/ipc';
import type { Plugin, SessionView } from '@brownie/plugin-api';
import { createBundledRegistry } from '@brownie/protocol/bundled';
import type { PacketRegistry } from '@brownie/protocol';
import { checkStaleness, findGameInstall, readManifest } from '@brownie/gamedata-tool';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { RuntimeConfig } from './core/config/Config.js';
import { createAntiDebuffPlugin } from './features/antidebuff/antiDebuffPlugin.js';
import { createAntiLagPlugin } from './features/antilag/antiLagPlugin.js';
import { createAutoAbilityPlugin } from './features/autoability/autoAbilityPlugin.js';
import { createAutoAimPlugin } from './features/autoaim/autoAimPlugin.js';
import { createAutoDrinkPlugin } from './features/autodrink/autoDrinkPlugin.js';
import { createAutoLootPlugin } from './features/autoloot/autoLootPlugin.js';
import { createAutoNexusPlugin } from './features/autonexus/autoNexusPlugin.js';
import { createChatFilterPlugin } from './features/chatfilter/chatFilterPlugin.js';
import { createColliderPlugin } from './features/collider/colliderPlugin.js';
import { createDodgePlugin } from './features/dodge/dodgePlugin.js';
import { SteerTracker } from './features/dodge/SteerIntent.js';
import { createGlowPlugin } from './features/glow/glowPlugin.js';
import { createNoclipPlugin } from './features/noclip/noclipPlugin.js';
import { createPushTileSpoofPlugin } from './features/pushtiles/pushTileSpoofPlugin.js';
import { createSanctuaryPlugin } from './features/sanctuary/sanctuaryPlugin.js';
import { createServerSwitchPlugin } from './features/serverswitch/serverSwitchPlugin.js';
import { loadObjectCatalog, loadTileCatalog } from './gamedata/GameCatalogs.js';
import { EquippedWeapon } from './gamedata/EquippedWeapon.js';
import { Logger, type LogSink } from './core/logging/Logger.js';
import { CursorTracker } from './native/CursorTracker.js';
import { NativeLink } from './native/NativeLink.js';
import { NativePipeServer } from './native/NativePipeServer.js';
import {
  mintSessionKey,
  publishSessionKey,
  revokeSessionKey,
  sessionKeyPath,
} from './native/SessionKey.js';
import { OverlayControlPlane } from './overlay/OverlayControlPlane.js';
import { PacketCensus } from './observe/PacketCensus.js';
import { WorldStatusStage } from './overlay/WorldStatusStage.js';
import type { WorldState } from './state/WorldState.js';
import { CommandStage } from './pipeline/stages/CommandStage.js';
import { PluginStage } from './pipeline/stages/PluginStage.js';
import { PluginHost } from './plugins/PluginHost.js';
import { PluginLoader } from './plugins/PluginLoader.js';
import { AllowlistTargets } from './proxy/AllowlistTargets.js';
import { EMPTY_CATALOG, type ObjectCatalog } from './state/ObjectCatalog.js';
import { EMPTY_TILE_CATALOG, type TileCatalog } from './state/TileMap.js';
import { NetServerConnector } from './proxy/NetServerConnector.js';
import { ProxyServer } from './proxy/ProxyServer.js';
import type { ServerConnector } from './proxy/ProxySession.js';

export interface ApplicationOptions {
  readonly config: RuntimeConfig;
  readonly sink: LogSink;
  /** Overridable so an integration test can run without a game server. */
  readonly connector?: ServerConnector;
  readonly registry?: PacketRegistry;
  /** Where the game client was originally headed. */
  readonly requestedHost?: () => string | undefined;
  /** Plugins to load at startup. Discovery from disk is a separate concern. */
  readonly plugins?: readonly Plugin[];
  /**
   * Where to write the packet capture on shutdown. Omitted means "nowhere" —
   * a run that was not asked for a file does not leave one behind.
   */
  readonly censusPath?: string;
  /**
   * Where the overlay's "dump every class name" button writes to. Omitted means
   * the button is refused rather than writing somewhere nobody asked for.
   */
  readonly classDumpPath?: string;
  /**
   * Keep the bytes no schema described, so an undescribed body can be worked
   * out. Off by default: those bytes come from a real session.
   */
  readonly sampleBodies?: boolean;
}

/**
 * The composition root.
 *
 * Everything is constructed here and handed its collaborators; nothing reaches
 * for a module-level singleton. That is the difference between this and the
 * reference implementation's 647-line `index.ts`, which also deployed DLLs,
 * mirrored files into Steam directories, installed crash handlers and
 * discovered plugins — so none of it could be started without all of it.
 *
 * Startup and shutdown are explicit sequences, and shutdown is the exact
 * reverse of startup. Disposal is idempotent: nothing here relies on
 * `process.exit()` to clean up after it.
 */
export class Application {
  readonly #config: RuntimeConfig;
  readonly #log: Logger;
  readonly #registry: PacketRegistry;
  readonly #native: NativeLink;
  readonly #pipe: NativePipeServer | undefined;
  readonly #census: PacketCensus;
  /** Where to write the capture, or `undefined` to keep it in memory only. */
  readonly #censusPath: string | undefined;
  /** Where a class-name dump goes, or `undefined` to refuse to write one. */
  readonly #dumpPath: string | undefined;
  readonly #secret: Buffer;
  /** Set only when this run minted the key, so only it removes the file. */
  readonly #publishedKeyPath: string | undefined;
  readonly #plugins: PluginHost;
  readonly #overlay: OverlayControlPlane;
  readonly #loader: PluginLoader;
  readonly #proxy: ProxyServer;
  readonly #targets: AllowlistTargets;
  readonly #startupPlugins: readonly Plugin[];

  /// Chunks of a class-name dump, held until the module says it has finished.
  readonly #dump: string[] = [];

  /// Where the module last said the player is pointing. Read by two features
  /// and owned by neither: cursor aim ranks enemies against it, and the
  /// walk-to-cursor chord walks to it.
  readonly #cursor = new CursorTracker();

  /// Whether the module says that chord is held down.
  ///
  /// An edge, not a poll: the module reports the press and the release and
  /// nothing in between. Walking needs both this and a fresh point, so a module
  /// that stops talking mid-hold stops the walk on the point's freshness alone.
  #cursorWalkHeld = false;

  /// Which way the module says the player is walking under their own power.
  ///
  /// Owned here rather than in the dodge plugin for the same reason the cursor
  /// is: it is a reading off the link, and the link is the composition root's.
  /// The dodge is the only thing that reads it today, and it reads it to decide
  /// when *not* to act — see `SteerIntent.ts`.
  readonly #steer = new SteerTracker();

  /// Whether the module is drawing the shot paths, and therefore wants them.
  ///
  /// **The only switch that travels this way**, and it does because what it
  /// turns on is drawing: the module owns the checkbox because the module owns
  /// the pixels, and the runtime owns the prediction because the runtime owns
  /// the world model. Cleared when the module connects, since a module that has
  /// restarted has an unticked box and nothing on screen.
  #dodgeView = false;

  #started = false;
  #stopped = false;
  // Replaced once the game's data files are read. Until then every question
  // about an object or a tile is answered "I do not know".
  #objects: ObjectCatalog = EMPTY_CATALOG;
  #tiles: TileCatalog = EMPTY_TILE_CATALOG;
  /**
   * The weapon slot's own data, resolved once per item.
   *
   * Two features ask on a loop and neither may be given the catalog, so the
   * lookup lives here — once, rather than once per feature and once per tick.
   */
  readonly #weapon = new EquippedWeapon(() => this.#objects);

  constructor(options: ApplicationOptions) {
    this.#config = options.config;
    this.#log = Logger.create(options.sink, 'brownie', options.config.logging.level);
    this.#registry = options.registry ?? createBundledRegistry();
    this.#census = new PacketCensus(this.#registry, {
      sampleTails: options.sampleBodies ?? false,
    });
    this.#censusPath = options.censusPath;
    this.#dumpPath = options.classDumpPath;
    if (this.#census.sampling) {
      // Said out loud, every run: the file then contains bytes from a real
      // session, and somebody who forgot they turned this on should not learn
      // that from the file's contents.
      this.#log.warn(
        'packet body sampling is on — the capture will contain bytes from your session',
      );
    }
    this.#startupPlugins = options.plugins ?? [];

    // A configured secret is used as given; otherwise one is minted for this
    // run and published where the module reads it. Minting here rather than in
    // `resolveConfig` keeps that function pure — configuration describes what
    // was asked for, not what this process happens to have generated.
    const configured = this.#config.native.secretHex;
    const secret = configured === '' ? mintSessionKey() : Buffer.from(configured, 'hex');
    this.#publishedKeyPath =
      this.#config.native.enabled && configured === ''
        ? sessionKeyPath(this.#config.native.pipeName, process.env)
        : undefined;

    this.#native = new NativeLink({
      log: this.#log,
      secret,
      userId: 'local',
    });
    this.#secret = secret;
    this.#pipe = this.#config.native.enabled
      ? new NativePipeServer({
          log: this.#log,
          link: this.#native,
          pipeName: this.#config.native.pipeName,
        })
      : undefined;

    this.#targets = new AllowlistTargets({
      log: this.#log,
      allow: this.#config.servers.allow,
      port: this.#config.servers.port,
      // The native module reports where the game was actually heading before it
      // was redirected here; without that the allowlist has nothing to check and
      // refuses every session. An explicit option still wins, for driving the
      // proxy without a module at all.
      requestedHost: options.requestedHost ?? (() => this.#native.requestedHost),
    });

    // A target the module saw on the game's *own* `connect` permits itself.
    //
    // The allowlist exists because a host can arrive from outside the runtime —
    // a file another process wrote, a `RECONNECT` from a server — and following
    // one unchecked would make this an open relay. An intercepted connect is
    // not that: it is where the game had already decided to go, observed by a
    // module that authenticated over the pipe. Refusing to follow it would
    // protect nothing, because a module able to lie about it is a module that
    // could send the game there directly.
    this.#native.onServerTarget((host) => {
      this.#targets.permit(host);
    });

    // The module answering the overlay's metadata inspector.
    //
    // It goes to the log rather than back to the overlay on purpose: a class
    // can have a hundred fields, and a log can be searched, scrolled and pasted
    // while a panel over a running game cannot. This is how a new offset gets
    // found — by asking the game what it calls things, rather than by copying a
    // name out of an older project that only knows what somebody already found.
    this.#native.onControlAction((action) => {
      const [kind, first, second, third] = parseRecord(action);
      if (kind === 'inspect') this.#log.info(`inspect  ${first ?? ''}`);
      else if (kind === 'dump') this.#dump.push(first ?? '');
      else if (kind === 'dump-end') void this.#writeClassDump(first ?? '0', second ?? '0');
      // Where the cursor is, in hundredths of a tile — see `docs/ipc.md`. A
      // field that did not parse becomes `NaN`, which the tracker drops: a
      // point nobody can locate is worse than none.
      else if (kind === 'cursor-at')
        this.#cursor.observe(Number(first) / 100, Number(second) / 100);
      // The walk-to-cursor chord going down or coming up. Anything that is not
      // "1" is a release, which is the safe reading of a field that did not
      // arrive as either.
      else if (kind === 'unstick') this.#cursorWalkHeld = first === '1';
      // Which way the player is steering, in thousandths of a unit vector — a
      // world direction, because which way `W` points depends on the camera and
      // only the module can ask it. Anything that is not "1" is a release.
      else if (kind === 'steer') {
        if (first === '1') this.#steer.observe(Number(second) / 1000, Number(third) / 1000);
        else this.#steer.release();
      }
      // The module asking to be sent the shot paths, or to stop being sent
      // them. Anything that is not "1" is off, which is the safe reading of a
      // field that did not arrive as either.
      else if (kind === 'dodge-view') this.#dodgeView = first === '1';
    });

    // A module that has just connected is holding nothing and pointing nowhere.
    // Both let go on their own, but a reconnect inside that window would
    // otherwise open the session acting on what the previous one was told.
    this.#native.onConnected(() => {
      this.#cursorWalkHeld = false;
      this.#cursor.release();
      this.#steer.release();
      this.#dodgeView = false;
    });

    // The proxy is the plugin host's session source and the host supplies the
    // proxy's plugin stage. Neither can be constructed with the other already
    // in hand, so the stage builder reads a reference that is filled in below —
    // and is only consulted once a client connects, by which time both exist.
    const holder: { plugins?: PluginHost } = {};
    this.#proxy = new ProxyServer({
      registry: this.#registry,
      log: this.#log,
      connector: options.connector ?? new NetServerConnector(this.#log),
      targets: this.#targets,
      worldOptions: {
        // Read through `this`, so a session created after the catalogs load
        // sees them without the proxy being rebuilt.
        objects: {
          isPlayer: (type) => this.#objects.isPlayer(type),
          isEnemy: (type) => this.#objects.isEnemy(type),
          isPet: (type) => this.#objects.isPet(type),
          isInvincible: (type) => this.#objects.isInvincible(type),
          occupies: (type) => this.#objects.occupies(type),
          displayName: (type) => this.#objects.displayName(type),
          projectile: (type, bullet) => this.#objects.projectile(type, bullet),
          item: (type) => this.#objects.item(type),
          container: (type) => this.#objects.container(type),
          statMaxima: (type) => this.#objects.statMaxima(type),
        },
        tiles: {
          isDamaging: (type) => this.#tiles.isDamaging(type),
          isBlocking: (type) => this.#tiles.isBlocking(type),
          isPushing: (type) => this.#tiles.isPushing(type),
        },
      },
      buildStages: (session: SessionView, world: WorldState) => [
        // The census is first, so a packet a later stage drops is still
        // counted: the question it answers is what the game sent, not what
        // survived our handling of it.
        this.#census.stage(),
        // After the state stage, so what the overlay shows is the world as of
        // this packet rather than the one before it.
        new WorldStatusStage(world, {
          publish: (record) => {
            this.#native.publishRecord(record);
          },
          // The same resolution the dodge planner reads its range from, so what
          // the overlay shows is the figure actually in use rather than a
          // second computation that could quietly disagree with it.
          weapon: (objectType) => this.#weapon.of(objectType),
        }),
        ...(holder.plugins === undefined
          ? []
          : [
              new PluginStage(holder.plugins, session),
              // After the plugins, so a handler watching chat still sees the
              // line that invoked a command before this stage drops it.
              new CommandStage(holder.plugins, session),
            ]),
      ],
    });
    // The host tells the overlay when something changed, and the overlay reads
    // the host to say what. Same shape as above, same reason: the callback is
    // only ever invoked after both exist.
    const overlayHolder: { plane?: OverlayControlPlane } = {};
    this.#plugins = new PluginHost({
      log: this.#log,
      native: this.#native,
      sessions: this.#proxy,
      onChanged: () => overlayHolder.plane?.publish(),
    });
    holder.plugins = this.#plugins;

    this.#overlay = new OverlayControlPlane({
      host: this.#plugins,
      native: this.#native,
      log: this.#log,
    });
    overlayHolder.plane = this.#overlay;

    this.#loader = new PluginLoader({
      host: this.#plugins,
      log: this.#log,
      directory: this.#config.plugins.directory,
    });
  }

  get overlay(): OverlayControlPlane {
    return this.#overlay;
  }

  get log(): Logger {
    return this.#log;
  }

  get proxy(): ProxyServer {
    return this.#proxy;
  }

  get plugins(): PluginHost {
    return this.#plugins;
  }

  get native(): NativeLink {
    return this.#native;
  }

  get targets(): AllowlistTargets {
    return this.#targets;
  }

  /**
   * Starts, in order, failing loudly.
   *
   * The listener is bound **last**: everything a session needs must exist
   * before one can arrive, and a client that connects into a half-built runtime
   * is a race that only shows up under load.
   */
  async start(): Promise<void> {
    if (this.#started) throw new Error('the application is already started');
    this.#started = true;

    this.#log.info(`protocol: ${String(this.#registry.packetCount)} packet definitions`);

    await this.#loadGameData();

    // Built in, and loaded before anything from disk: it needs a way to tell
    // the module to walk, which is the composition root's to hand over and not
    // something a file in `plugins/` can be given. Everything else about it is
    // an ordinary plugin — it is switched on from the overlay and tuned there,
    // and does nothing at all until somebody does.
    this.#plugins.load(
      createDodgePlugin({
        output: {
          moveTo: (x, y, speedTilesPerSecond, holdMs) => {
            this.#native.publishRecord(
              [
                'move',
                Math.round(x * 100),
                Math.round(y * 100),
                Math.round(speedTilesPerSecond * 100),
                Math.round(holdMs),
              ].join('|'),
            );
          },
          // Bracketed, so a set half-received is never drawn: the module stages
          // what arrives between the two and commits on the closing record —
          // the same shape the plugin sync uses, and for the same reason.
          showShotPaths: (paths) => {
            this.#native.publishRecord('trail-begin');
            for (const path of paths) {
              const fields: (string | number)[] = ['trail', path.lifePermille];
              for (const coordinate of path.points) fields.push(Math.round(coordinate * 100));
              this.#native.publishRecord(fields.join('|'));
            }
            this.#native.publishRecord('trail-end');
          },
        },
        // The manual override, which comes from the module whole: the chord is
        // window input and the place it points at is measured against the
        // game's own camera. Nothing on the wire knows either.
        //
        // **Both halves, and the point only while the chord is down.** The
        // module keeps measuring the cursor for anything that asked — cursor
        // aim does — and walking to it is what the *chord* means, not what
        // pointing means.
        cursorWalk: { target: () => (this.#cursorWalkHeld ? this.#cursor.point() : undefined) },
        // And the other half of "who is driving": what the player's own hands
        // are asking for, so the planner can leave it alone while it is safe
        // and cancel it when it is not.
        steer: { direction: () => this.#steer.direction() },
        // And whether anybody is looking at the result. Nothing is predicted
        // for the picture while the box is unticked.
        view: { wanted: () => this.#dodgeView },
        // How far the equipped weapon reaches, which is the distance the
        // planner tries not to drift past. Same catalog and same reason as
        // auto-aim's `weapon`: it is in `objects.xml` and nowhere on the wire.
        weaponRange: (weaponType) => {
          const reach = this.#weapon.of(weaponType)?.reachTiles;
          return reach !== undefined && reach > 0 ? reach : undefined;
        },
      }),
    );

    // A first-party combat feature, loaded before anything from disk. Unlike
    // dodge it needs nothing the composition root has to hand over — it escapes
    // through the public `sendToServer('ESCAPE')` path — but it is built here so
    // its arithmetic lives in tested TypeScript rather than in a plain-JS file.
    this.#plugins.load(createAutoNexusPlugin());

    // Its neighbour in every sense: also combat, also nothing handed over — it
    // reads what was hit out of the world model and withholds the report — and
    // also built here because the numbers behind it are a table read out of the
    // game's own data, which is only trustworthy with tests beside it.
    this.#plugins.load(createSanctuaryPlugin());

    // Same reasoning, and it needs nothing handed over at all: what a shot does
    // to whoever it hits reaches it through the world model, which already
    // holds every tracked shot with the projectile data behind it.
    this.#plugins.load(createAntiDebuffPlugin());

    // Built here for the same two reasons as dodge: it needs a way to tell the
    // module where to point, and it needs the game's own projectile data —
    // neither of which is on the plugin surface, and both of which are the
    // composition root's to hand over.
    this.#plugins.load(
      createAutoAimPlugin({
        output: {
          aimAt: (x, y, holdMs) => {
            this.#native.publishRecord(
              ['aim', Math.round(x * 100), Math.round(y * 100), Math.round(holdMs)].join('|'),
            );
          },
        },
        // Resolved once per weapon and read through `this`, so a session that
        // starts before the catalogs finish loading picks them up when they do.
        weapon: (weaponType) => this.#weapon.of(weaponType),
        // The same catalog, and the same reason it is handed over here: a wall
        // in this game is an object with hit points, so to anything ranking
        // enemies by distance it is simply the closest one.
        isObstacle: (objectType) => this.#objects.occupies(objectType),
        // And again the same catalog: a quarter of what `objects.xml` marks as
        // an enemy is a spawner, an emitter or a room controller that carries
        // health and can never lose any of it. Nothing on the wire tells those
        // apart from the monster next to them.
        isInvincible: (objectType) => this.#objects.isInvincible(objectType),
        // The one input auto-aim has that comes from the module rather than
        // from the wire: where the player is pointing, which is a question only
        // the game's own camera can answer.
        cursorPoint: () => this.#cursor.point(),
      }),
    );

    // Auto-aim's neighbour, and it needs the same catalog for the same reason:
    // what an ability does when it is used — whether it moves the character,
    // whether it needs a target, what it costs — is in `objects.xml` and
    // nowhere on the wire. Read through `this`, so a session that starts before
    // the catalogs finish loading picks them up when they do.
    this.#plugins.load(
      createAutoAbilityPlugin({
        ability: (objectType) => this.#objects.item(objectType)?.ability,
        isObstacle: (objectType) => this.#objects.occupies(objectType),
        isInvincible: (objectType) => this.#objects.isInvincible(objectType),
      }),
    );

    // Built here for one of the same reasons as auto-aim: it needs the game's
    // own object data — whether a type is a pet is in `objects.xml` and nowhere
    // on the wire. Read through `this`, so a session that starts before the
    // catalogs finish loading picks them up when they do.
    this.#plugins.load(
      createAntiLagPlugin({
        isPet: (objectType) => this.#objects.isPet(objectType),
      }),
    );

    // Needs nothing handed over — it rewrites two stats on their way past — and
    // is built here rather than dropped in `plugins/` for the same reason as
    // anti-debuffs: what it puts back when an override is lifted is worth
    // having tests for.
    this.#plugins.load(createGlowPlugin());

    // Needs nothing handed over either — it drops a chat packet on its way to
    // the client — and is built here because what it recognises is a table of
    // patterns written against real spam, which is only trustworthy with the
    // lines that motivated it kept as tests.
    this.#plugins.load(createChatFilterPlugin());

    // Built here for the same reason as dodge, twice over: it needs a way to
    // say something the player will read without looking away from the game,
    // and it needs to hold the uplink — a lag switch over the whole session,
    // which is not a thing a packet handler can do and not a thing the plugin
    // surface should carry. The switch that turns the module's half on *is* on
    // that surface, through `setFeature`.
    this.#plugins.load(
      createNoclipPlugin({
        showText: (text, colour) => {
          this.#native.publishRecord(
            ['text', colour.red, colour.green, colour.blue, text].join('|'),
          );
        },
        holdUplink: (held) => {
          this.#proxy.holdClientTraffic(held);
        },
      }),
    );

    // Noclip's neighbour, and the switch it does not need: this one says one
    // number to the module and the module does the rest, so nothing has to be
    // handed over. Built here rather than dropped in `plugins/` because what it
    // claims — and what expiry puts back — is worth having tests for.
    this.#plugins.load(createColliderPlugin());

    // Movement too, but by rewriting the stream rather than by writing into the
    // game. It is built here for the one reason auto-aim and anti-lag are:
    // whether a ground type pushes is in the game's own `tiles.xml` and nowhere
    // on the wire. Read through `this`, so a session that starts before the
    // catalogs finish loading picks them up when they do.
    this.#plugins.load(
      createPushTileSpoofPlugin({
        isPushing: (tileType) => this.#tiles.isPushing(tileType),
      }),
    );

    // The two that move items, and both are built here for the same reason as
    // auto-ability: what an object *is* — a potion, a bag, a tier-13 bow — is
    // in `objects.xml` and nowhere on the wire, and reading it there is what
    // replaces the reference implementation's four hand-written id tables.
    this.#plugins.load(
      createAutoDrinkPlugin({
        item: (objectType) => this.#objects.item(objectType),
      }),
    );

    this.#plugins.load(
      createAutoLootPlugin({
        item: (objectType) => this.#objects.item(objectType),
        container: (objectType) => this.#objects.container(objectType),
        statMaxima: (objectType) => this.#objects.statMaxima(objectType),
        displayName: (objectType) => this.#objects.displayName(objectType),
      }),
    );

    // Needs nothing handed over — it sends one packet to the client — and is
    // built here rather than dropped in `plugins/` because what a typed name
    // resolves to is a table with real ambiguities in it, and those are worth
    // having tests for: `/con a` naming two servers is the difference between
    // asking and going somewhere the player did not mean.
    this.#plugins.load(createServerSwitchPlugin());

    for (const plugin of this.#startupPlugins) this.#plugins.load(plugin);
    await this.#loader.loadAll();
    this.#loader.watch();
    this.#overlay.start();

    if (this.#pipe !== undefined) {
      try {
        if (this.#publishedKeyPath !== undefined) {
          // Published before listening: a module that connects the moment the
          // pipe appears must already be able to authenticate, or its first
          // attempt fails for a reason that looks like a bug.
          await publishSessionKey(this.#publishedKeyPath, this.#secret);
          this.#log.debug(`session key published at ${this.#publishedKeyPath}`);
        }
        await this.#pipe.listen();
      } catch (cause) {
        // The overlay being unavailable is not a reason to refuse to proxy: the
        // game is perfectly playable without it, and saying so beats exiting.
        this.#log.warn(
          `overlay unavailable: ${cause instanceof Error ? cause.message : 'unknown'}`,
        );
      }
    } else {
      this.#log.info('overlay disabled: set native.enabled to listen for the module');
    }

    await this.#proxy.listen(this.#config.proxy.host, this.#config.proxy.port);
    this.#log.info('ready — point the game client at the proxy');
  }

  /**
   * Reads the game's own object and tile data, if it was configured.
   *
   * Missing or unreadable data is a warning, not a failure: the proxy works
   * without it, and the catalogs answer "no" to everything — so a feature that
   * needs them does nothing rather than acting on a guess.
   */
  async #loadGameData(): Promise<void> {
    const directory = this.#config.gameData.directory;
    if (directory === '') {
      this.#log.info('no game data configured: objects and tiles stay unclassified');
      return;
    }
    try {
      const objects = await loadObjectCatalog(join(directory, 'objects.xml'));
      const tiles = await loadTileCatalog(join(directory, 'tiles.xml'));
      this.#objects = objects;
      this.#tiles = tiles;
      // Anything resolved against the empty catalog before this point is an
      // answer from a different catalog, and there is no reason to keep it.
      this.#weapon.clear();
      this.#log.info(`game data: ${String(objects.size)} objects, ${String(tiles.size)} tiles`);

      // Extracted data is a copy of something the game replaces on its own
      // schedule. Saying nothing when it has fallen behind is how a proxy ends
      // up classifying last patch's monsters with nobody able to say why.
      const staleness = checkStaleness(readManifest(directory), findGameInstall());
      if (staleness.stale) {
        this.#log.warn(`game data is out of date — ${staleness.reason ?? ''}`);
        this.#log.warn('run `npm run gamedata extract` to refresh it');
      }
    } catch (cause) {
      this.#log.warn(
        `could not read game data from ${directory}: ${cause instanceof Error ? cause.message : 'unknown'}`,
      );
    }
  }

  /**
   * Writes the class export the module just sent.
   *
   * A file rather than the log, because it is the whole image with its members
   * and the question it answers — "what is even in there?" — is one you grep.
   * Written once and kept: the names are stable for as long as the game build
   * is, so there is no reason to walk the metadata twice.
   *
   * The buffer is cleared whatever happens. A failed write must not leave half
   * an image behind for the next export to be appended to.
   */
  async #writeClassDump(written: string, skipped: string): Promise<void> {
    const text = this.#dump.join('');
    this.#dump.length = 0;

    const path = this.#dumpPath;
    if (path === undefined) {
      this.#log.warn('the module sent a class export, but no path was configured to write it to');
      return;
    }
    try {
      // Created here rather than assumed: the caller names a path, and on a
      // machine where the game's data has never been extracted the directory
      // it names does not exist yet.
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text, 'utf8');
      // The skipped count is part of the result, not a footnote: those classes
      // were registered but not built, so the file is what the game has needed
      // so far rather than an inventory of what it has.
      this.#log.info(`wrote ${written} classes to ${path}; ${skipped} were not built yet`);
    } catch (cause) {
      this.#log.warn(
        `could not write the class export: ${cause instanceof Error ? cause.message : 'unknown'}`,
      );
    }
  }

  /** Stops, in the exact reverse order. Safe to call more than once. */
  /**
   * Writes what the session actually saw, if it saw anything and somebody asked
   * for it.
   *
   * The path comes from the caller rather than from `process.cwd()`. Deciding to
   * write a file, and where, belongs to whoever composed the application: the
   * first version chose for itself and every test run left a `packet-census.json`
   * in the repository — a capture of nothing, in a place nobody asked for.
   *
   * On shutdown rather than continuously, because the file is evidence to read
   * afterwards and not a live feed. Nothing is written when no traffic passed:
   * an empty capture that looks like a result is worse than no file.
   */
  async #writeCensus(): Promise<void> {
    const path = this.#censusPath;
    if (path === undefined || this.#census.totalPackets === 0) return;

    this.#log.info(this.#census.summary());
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify(this.#census.report(), undefined, 2)}\n`, 'utf8');
      this.#log.info(`wrote ${path}`);
    } catch (cause) {
      this.#log.warn(
        `could not write the packet census: ${cause instanceof Error ? cause.message : 'unknown'}`,
      );
    }
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#log.info('shutting down');

    // First, before anything that can be slow or can fail. The capture is a
    // whole session's evidence held only in memory, and a teardown step that
    // hangs or throws ahead of it takes the session with it.
    await this.#writeCensus();

    await this.#proxy.close();
    this.#loader.stop();
    this.#overlay.stop();
    this.#plugins.disposeAll();
    if (this.#pipe !== undefined) await this.#pipe.close();
    else this.#native.disconnect('runtime shutting down');

    if (this.#publishedKeyPath !== undefined) {
      // A key left behind is one the next run does not use but a stale module
      // might still present. Failing to remove it is worth saying and not worth
      // failing the shutdown over — the secret is useless without the pipe.
      try {
        await revokeSessionKey(this.#publishedKeyPath);
      } catch (cause) {
        this.#log.warn(
          `could not remove the session key: ${cause instanceof Error ? cause.message : 'unknown'}`,
        );
      }
    }

    this.#log.info('stopped');
  }
}
