import {
  SWITCH_SLOT,
  bindAnnouncement,
  type PluginMeta,
  type Unsubscribe,
} from '@brownie/plugin-api';
import type { Logger } from '../core/logging/Logger.js';
import { OFF_COLOUR, ON_COLOUR, type FloatingTextColour } from '../overlay/floatingText.js';
import { BindMode } from './pluginBind.js';

/** One press the module reported. See `hotkeyEvent` in `docs/ipc.md`. */
export interface HotkeyEvent {
  readonly pluginId: string;
  /** Which of the plugin's switches the key moves. See `bindSlot`. */
  readonly slot: string;
  /** {@link BindMode.Toggle} or {@link BindMode.Hold}. */
  readonly action: string;
  /** The key going down, or — for a hold — coming up. */
  readonly value: boolean;
}

/** The part of the native link this needs. */
export interface HotkeySource {
  onHotkey(listener: (event: HotkeyEvent) => void): Unsubscribe;
  /** The module going away, however it went. */
  onDisconnected(listener: () => void): Unsubscribe;
}

/** The part of the plugin host this needs. */
export interface HotkeySwitches {
  isActive(pluginId: string, slot: string): boolean;
  setActive(pluginId: string, slot: string, on: boolean): boolean;
  /** What the plugin calls itself, and how it says its switches read. */
  meta(pluginId: string): PluginMeta | undefined;
}

export interface PluginHotkeysOptions {
  readonly host: HotkeySwitches;
  readonly native: HotkeySource;
  readonly log: Logger;
  /**
   * Says where a press left its switch, over the player.
   *
   * Not built here: what a line of the game's own text costs to send is the
   * composition root's business, and this side of it is one string and a
   * colour. The same output noclip and the hazard guard take.
   */
  readonly showText: (text: string, colour: FloatingTextColour) => void;
}

/**
 * Turns a key the module saw into a plugin switch moving.
 *
 * **The module decides nothing.** It knows which key is bound to which plugin
 * and which way that key is meant to act, because only it can watch a keyboard
 * — and it reports the press. What that press *means* to a switch is decided
 * here, where the switch is: a toggle flips whatever the plugin is doing now,
 * which is a state the module does not have and must not guess at.
 *
 * **A hold is an override, not a setting.** It remembers what the switch was
 * before the key went down and puts it back on the way up, so a plugin left on
 * comes back on rather than being switched off by a key that was only ever
 * meant to switch it on.
 *
 * **And no press is saved**, a toggle's included: the host moves the switch for
 * the run and writes nothing, so a restart puts back what the panel was set to.
 * See `PluginHost.setActive`.
 *
 * **Every press says where it left its switch**, in the game's own floating
 * text, and it is said here for the same reason the press is applied here: this
 * is the one place that knows what a key actually did. A plugin cannot watch
 * its own switch, a hold puts a switch back without anybody pressing anything,
 * and a key bound to a plugin that cannot be switched moves nothing at all — so
 * a plugin announcing its own state would be announcing what it was asked for
 * rather than what happened. See {@link PluginHotkeysOptions.showText}.
 *
 * **And it has to end without being told to.** A player can let go of a key in
 * another window, alt-tab, or kill the game with the key still down; the module
 * reports the release for the first two and vanishes for the third. So the link
 * going down releases everything — otherwise the last hold before a crash is a
 * plugin left running with nothing left able to say stop, and one of them holds
 * the client's whole uplink.
 */
export class PluginHotkeys {
  readonly #host: HotkeySwitches;
  readonly #native: HotkeySource;
  readonly #log: Logger;
  readonly #showText: (text: string, colour: FloatingTextColour) => void;

  /**
   * What each live hold found its switch set to, by plugin and slot. The key's
   * presence is what says the hold is live, so a repeated press cannot
   * overwrite the state the release has to put back.
   */
  readonly #held = new Map<string, { pluginId: string; slot: string; wasOn: boolean }>();
  readonly #subscriptions: Unsubscribe[] = [];
  #started = false;

  constructor(options: PluginHotkeysOptions) {
    this.#host = options.host;
    this.#native = options.native;
    this.#log = options.log.child('hotkeys');
    this.#showText = options.showText;
  }

  start(): void {
    if (this.#started) throw new Error('the hotkey router is already started');
    this.#started = true;

    this.#subscriptions.push(
      this.#native.onHotkey((event) => {
        this.#apply(event);
      }),
      this.#native.onDisconnected(() => {
        this.releaseAll();
      }),
    );
  }

  /**
   * Stops listening and ends every live hold.
   *
   * The release matters more than the unsubscribe: once this stops listening,
   * nothing is left to deliver the key coming up, and a hold nothing can end is
   * a plugin left running by a key nobody is pressing.
   */
  stop(): void {
    for (const unsubscribe of this.#subscriptions.splice(0)) unsubscribe();
    this.releaseAll();
    this.#started = false;
  }

  /**
   * Puts every held switch back where its hold found it.
   *
   * **Silently**, unlike an ordinary release: the two things that call this are
   * the module going away and the run ending, and in both there is nothing left
   * to draw a line over the player with. A press is what has somebody waiting
   * to read the answer.
   */
  releaseAll(): void {
    for (const [id, held] of [...this.#held]) {
      this.#held.delete(id);
      this.#host.setActive(held.pluginId, held.slot, held.wasOn);
    }
  }

  #apply(event: HotkeyEvent): void {
    switch (event.action) {
      case BindMode.Toggle:
        // The down edge only: a toggle has no release, and acting on one would
        // undo the press that came before it.
        if (event.value) this.#toggle(event.pluginId, event.slot);
        return;
      case BindMode.Hold:
        if (event.value) this.#press(event.pluginId, event.slot);
        else this.#release(event.pluginId, event.slot);
        return;
      default:
        // A module newer than this build. Ignored rather than refused, which is
        // the rule everywhere else on this link.
        this.#log.trace(`not an action this build applies: "${event.action}"`);
    }
  }

  #toggle(pluginId: string, slot: string): void {
    const wanted = !this.#host.isActive(pluginId, slot);
    if (!this.#host.setActive(pluginId, slot, wanted)) {
      this.#log.warn(`hotkey toggled ${describe(pluginId, slot)}, which cannot be switched`);
      return;
    }
    this.#announce(pluginId, slot);
  }

  #press(pluginId: string, slot: string): void {
    // Already held: the module restates nothing, but a reconnect or a rebind can
    // produce a second down edge, and the state the release puts back must be
    // the one from before the first.
    const id = heldId(pluginId, slot);
    if (this.#held.has(id)) return;
    this.#held.set(id, { pluginId, slot, wasOn: this.#host.isActive(pluginId, slot) });
    if (!this.#host.setActive(pluginId, slot, true)) {
      this.#held.delete(id);
      this.#log.warn(`hotkey held ${describe(pluginId, slot)}, which cannot be switched`);
      return;
    }
    this.#announce(pluginId, slot);
  }

  #release(pluginId: string, slot: string): void {
    const id = heldId(pluginId, slot);
    const held = this.#held.get(id);
    // A release with no hold behind it — the module reported one this runtime
    // never saw the start of. Nothing to put back, and switching the plugin off
    // would be acting on a press that was somebody else's.
    if (held === undefined) return;
    this.#held.delete(id);
    this.#host.setActive(pluginId, slot, held.wasOn);
    this.#announce(pluginId, slot);
  }

  /**
   * Says where the switch a key just moved has ended up.
   *
   * **Read back rather than assumed.** What was asked for and what happened
   * differ wherever the host declines part of a move — arming a setting inside
   * a plugin that would not start, most of all — and a line naming the state
   * nobody is in is worse than no line, because it is the state the player
   * stops checking for.
   */
  #announce(pluginId: string, slot: string): void {
    const meta = this.#host.meta(pluginId);
    if (meta === undefined) return;
    // A key the module reports for a slot this plugin does not offer. The move
    // above already refused it; this refuses to name it.
    const announcement = bindAnnouncement(meta, slot);
    if (announcement === undefined) return;

    const on = this.#host.isActive(pluginId, slot);
    this.#showText(
      `${announcement.name}: ${on ? announcement.on : announcement.off}`,
      on ? ON_COLOUR : OFF_COLOUR,
    );
  }
}

/**
 * One live hold, as a map key.
 *
 * Joined on a character neither half can contain — a plugin id is kebab-case
 * and a slot is a setting key — so two holds can never collide into one.
 */
function heldId(pluginId: string, slot: string): string {
  return `${pluginId} ${slot}`;
}

/** The same pair, for a person reading a log line. */
function describe(pluginId: string, slot: string): string {
  return slot === SWITCH_SLOT ? `"${pluginId}"` : `"${pluginId}.${slot}"`;
}
