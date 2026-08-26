import { buildRecord, encodeOptions, parseRecord } from '@brownie/ipc';
import {
  SWITCH_SLOT,
  bindLabel,
  bindSlot,
  bindTargets,
  type SettingDescriptor,
  type Unsubscribe,
} from '@brownie/plugin-api';
import type { Logger } from '../core/logging/Logger.js';
import { parseBind, NO_BIND } from '../plugins/pluginBind.js';
import type { PluginHost } from '../plugins/PluginHost.js';

/** The part of the native link the overlay needs. */
export interface OverlayTransport {
  readonly connected: boolean;
  publishRecord(record: string): void;
  onConnected(listener: () => void): Unsubscribe;
  onControlAction(listener: (action: string) => void): Unsubscribe;
}

export interface OverlayControlPlaneOptions {
  readonly host: PluginHost;
  readonly native: OverlayTransport;
  readonly log: Logger;
  /**
   * Runs a coalesced publish. Injected so a test can flush deterministically
   * instead of racing a timer.
   */
  readonly schedule?: (flush: () => void) => void;
}

/** Wire names for a setting's kind and for the type of value it carries. */
const WIRE_TYPE: Readonly<Record<SettingDescriptor['kind'], string>> = {
  boolean: 'boolean',
  number: 'number',
  range: 'range',
  select: 'select',
  multiSelect: 'multiSelect',
  text: 'text',
  colour: 'colour',
  button: 'button',
};

const VALUE_TYPE: Readonly<Record<SettingDescriptor['kind'], string>> = {
  boolean: 'b',
  number: 'n',
  range: 'n',
  select: 's',
  // A set of keys, carried as one delimited string — see MULTI_SELECT_DELIMITER.
  multiSelect: 's',
  text: 's',
  // `#rrggbbaa`, which is a string like any other on the wire — the overlay is
  // where it becomes four bars, and it comes back in the same spelling.
  colour: 's',
  button: 'b',
};

/**
 * Publishes the plugin list to the overlay and routes interactions back.
 *
 * The overlay holds no state of its own: the runtime describes what to draw and
 * the overlay draws it. That is what makes adding a control a Node-only change,
 * and it is why this class is the *only* thing that knows both the plugin host
 * and the wire format.
 *
 * Publishing is coalesced. A settings replay touches every key of every plugin,
 * and sending a record per key would put thousands of frames through the pipe
 * for one logical change.
 */
export class OverlayControlPlane {
  readonly #host: PluginHost;
  readonly #native: OverlayTransport;
  readonly #log: Logger;
  readonly #schedule: (flush: () => void) => void;

  readonly #subscriptions: Unsubscribe[] = [];
  #publishQueued = false;
  #started = false;

  /**
   * The records the overlay was last told about.
   *
   * Every interaction ends in a full re-sync, and most of them change one field
   * of one record — so most syncs are the sync that was already sent. The
   * overlay's mirror is a function of these records alone, so a sync identical
   * to the last one leaves it in the state it is already in: sending it costs a
   * pipe write here and a parse of every record there, for nothing. Cleared
   * when the module connects, because a fresh one mirrors nothing.
   */
  #published: readonly string[] | undefined;

  constructor(options: OverlayControlPlaneOptions) {
    this.#host = options.host;
    this.#native = options.native;
    this.#log = options.log.child('overlay');
    this.#schedule =
      options.schedule ??
      ((flush): void => {
        queueMicrotask(flush);
      });
  }

  start(): void {
    if (this.#started) throw new Error('the control plane is already started');
    this.#started = true;

    this.#subscriptions.push(
      this.#native.onControlAction((action) => {
        this.#handleAction(action);
      }),
      // A reconnecting module has nothing: it starts from its own defaults and
      // mirrors whatever we send, so a full sync is the only correct greeting.
      this.#native.onConnected(() => {
        this.#published = undefined;
        this.publish();
      }),
    );
    this.publish();
  }

  stop(): void {
    for (const unsubscribe of this.#subscriptions.splice(0)) unsubscribe();
    this.#started = false;
  }

  /** Queues a full sync. Repeated calls before the flush cost nothing. */
  publish(): void {
    if (this.#publishQueued) return;
    this.#publishQueued = true;
    this.#schedule(() => {
      this.#publishQueued = false;
      this.publishNow();
    });
  }

  /** Publishes immediately. Bracketed so the overlay can commit atomically. */
  publishNow(): void {
    if (!this.#native.connected) return;

    const records: string[] = [buildRecord('sync-begin')];
    for (const status of this.#host.statuses()) {
      const { meta } = status;
      records.push(
        buildRecord(
          'plugin',
          meta.id,
          meta.name,
          meta.category,
          this.#host.isEnabled(meta.id),
          status.state,
          status.error ?? '',
          // Appended, so an overlay built before this field still draws the
          // plugin — it just cannot tell a retryable failure from a final one.
          status.enableable,
        ),
      );

      // Its own record rather than more fields on the plugin's, because it is
      // not a property of the plugin at all: an overlay that draws no bind
      // control simply never sees one, a plugin that is not bindable publishes
      // nothing for one to draw, and a plugin that offers two keys publishes
      // two records rather than a shape every other plugin has to carry.
      for (const target of bindTargets(meta)) {
        const slot = bindSlot(target);
        // Split into its two halves here so the overlay never parses the
        // compound value — it draws a key and a mode, and sends back the two it
        // is holding. The one spelling is this side's to keep.
        const bind = parseBind(this.#host.bindOf(meta.id, slot)) ?? NO_BIND;
        // Slot and label appended, so an overlay built before there could be
        // more than one still draws the last of them rather than nothing.
        records.push(buildRecord('bind', meta.id, bind.mode, bind.key, slot, bindLabel(target)));
      }

      const settings = this.#host.settingsOf(meta.id);
      if (settings === undefined) continue;
      const values = settings.values();
      for (const descriptor of settings.descriptors()) {
        if (descriptor.hidden === true) continue;
        records.push(settingRecord(meta.id, descriptor, values[descriptor.key]));
      }
    }
    // Anything the overlay still holds that this sync did not mention is gone.
    records.push(buildRecord('sync-end'));

    if (sameRecords(this.#published, records)) return;
    this.#published = records;
    for (const record of records) this.#native.publishRecord(record);
  }

  /**
   * Applies one interaction.
   *
   * Unknown kinds are ignored rather than rejected: a newer overlay must never
   * break on an older runtime, and the same rule in reverse is what lets the
   * two be updated separately.
   */
  #handleAction(raw: string): void {
    const [kind, ...fields] = parseRecord(raw);
    switch (kind) {
      case 'toggle': {
        const [pluginId, value] = fields;
        if (pluginId === undefined) return;
        if (!this.#host.setEnabled(pluginId, value === '1')) {
          this.#log.warn(`overlay toggled "${pluginId}", which cannot be enabled`);
        }
        this.publish();
        return;
      }
      case 'setting': {
        const [pluginId, key, valueType, value] = fields;
        if (pluginId === undefined || key === undefined || value === undefined) return;
        const settings = this.#host.settingsOf(pluginId);
        if (settings === undefined) {
          this.#log.warn(`overlay set "${key}" on unknown plugin "${pluginId}"`);
          return;
        }
        // The overlay echoes back the value type it was given, so the string it
        // sends can be turned into what the setting actually holds.
        if (!settings.apply(key, decodeValue(valueType, value))) {
          this.#log.warn(`overlay sent an unusable value for ${pluginId}.${key}: "${value}"`);
        }
        this.publish();
        return;
      }
      case 'bind': {
        const [pluginId, mode, key, slot] = fields;
        if (pluginId === undefined || mode === undefined || key === undefined) return;
        // Joined here and checked by the host: the two halves are how the
        // overlay holds a bind, the one string is how everything else does, and
        // neither half is trustworthy on its own. An overlay that names no slot
        // means the plugin's own switch, which is the only bind it can draw.
        if (!this.#host.setBind(pluginId, slot ?? SWITCH_SLOT, `${mode}:${key}`)) {
          this.#log.warn(`overlay sent an unusable bind for "${pluginId}": "${mode}:${key}"`);
        }
        this.publish();
        return;
      }
      case 'press': {
        const [pluginId, key] = fields;
        if (pluginId === undefined || key === undefined) return;
        this.#host.settingsOf(pluginId)?.press(key);
        this.publish();
        return;
      }
      default:
        // At trace, not debug. Every listener on this channel sees every
        // action, so an action addressed to one of the others reaches here as a
        // matter of course — the module's inspector answers, for instance.
        // "Unknown to me" stopped meaning "unknown to everyone" the moment
        // there was a second listener, and a line per inspected field is noise
        // in the log that the inspection itself is being read from.
        this.#log.trace(`not an action this plane handles: "${kind ?? ''}"`);
    }
  }
}

function sameRecords(previous: readonly string[] | undefined, next: readonly string[]): boolean {
  if (previous === undefined || previous.length !== next.length) return false;
  for (let i = 0; i < next.length; i++) {
    if (previous[i] !== next[i]) return false;
  }
  return true;
}

function settingRecord(pluginId: string, descriptor: SettingDescriptor, value: unknown): string {
  const bounds =
    descriptor.kind === 'number' || descriptor.kind === 'range' ? descriptor : undefined;
  const options =
    descriptor.kind === 'select' || descriptor.kind === 'multiSelect'
      ? encodeOptions(descriptor.options.map(([v, label]) => [label, v] as const))
      : '';
  const visible = descriptor.visibleWhen;

  // Positional, and new fields are appended: an older overlay that stops early
  // still draws the control, it just does not group or hide it.
  return buildRecord(
    'setting',
    pluginId,
    descriptor.key,
    descriptor.label ?? descriptor.key,
    WIRE_TYPE[descriptor.kind],
    VALUE_TYPE[descriptor.kind],
    scalar(value),
    bounds?.min !== undefined,
    bounds?.min ?? 0,
    bounds?.max !== undefined,
    bounds?.max ?? 0,
    bounds?.step ?? 0,
    descriptor.advanced === true,
    options,
    descriptor.group ?? '',
    visible === undefined ? '' : `${visible.key}=${visible.equals.map(scalar).join('|')}`,
  );
}

function scalar(value: unknown): string {
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'number' || typeof value === 'string') return String(value);
  return '';
}

/** Turns the overlay's string back into the type the setting holds. */
function decodeValue(valueType: string | undefined, value: string): boolean | number | string {
  if (valueType === 'b') return value === '1' || value === 'true';
  if (valueType === 'n') return Number(value);
  return value;
}
