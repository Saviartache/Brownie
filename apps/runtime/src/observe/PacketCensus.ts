/**
 * What actually came over the wire, tallied against what we claim it is.
 *
 * `docs/protocol.md` records an open question this exists to settle: the game's
 * own metadata names 110 incoming and 93 outgoing packet types, our definitions
 * describe 170, and comparing the two by name is impossible because the game
 * spells them as class names (`InventoryDrop`) while the definitions use short
 * screaming-case (`INVDROP`), and the extractor's id-to-type bindings resolve to
 * obfuscated names. That document says the ground truth is a live capture. This
 * is the live capture.
 *
 * Three things are worth knowing, and nothing else:
 *
 *   * **ids nobody defines** — a packet the registry could not name at all.
 *   * **ids that decode to nothing** — defined, but the body did not parse.
 *   * **ids whose body nobody describes** — the schema parsed and then left
 *     bytes over. An empty schema cannot fail to decode, so without this a
 *     definition with no fields at all reads as a clean success; the first
 *     capture had one, and it looked like the healthiest packet in the set.
 *   * **ids arriving from the wrong side** — defined as client-to-server and
 *     seen coming back, or the reverse. That is the specific discrepancy the
 *     document names, and only traffic can resolve it.
 *
 * Counts, not payloads — by default. A capture that records bodies holds account
 * names, chat and positions: someone's session, kept on disk for a question
 * about packet ids. Describing an undescribed body needs those bytes, though,
 * so sampling exists and is **off unless asked for**, takes only the bytes no
 * schema claimed, keeps a handful per id rather than all of them, and says so
 * in the log when it is on.
 */

import { PacketDirection, type PacketRegistry } from '@brownie/protocol';
import type { MutablePacket } from '@brownie/plugin-api';
import {
  PacketOrigin,
  type PacketContext,
  type PipelineStage,
} from '../pipeline/PacketPipeline.js';

interface Sighting {
  name: string;
  fromClient: number;
  fromServer: number;
  /** Times the body failed to decode, with the first reason kept. */
  failed: number;
  failure?: string;
  /** True when no definition exists for the id at all. */
  undefinedId: boolean;
  /** Largest number of bytes the schema parsed past but did not describe. */
  undescribedBytes: number;
  /** Hex of a few of those tails, when sampling was asked for. */
  samples: string[];
}

export interface CensusReport {
  readonly totalPackets: number;
  readonly ids: readonly {
    readonly id: number;
    readonly name: string;
    readonly fromClient: number;
    readonly fromServer: number;
    readonly failed: number;
    readonly failure?: string;
    readonly undefinedId: boolean;
    readonly undescribedBytes: number;
    readonly samples?: readonly string[];
    /** Set when the definition's direction disagrees with what was seen. */
    readonly directionConflict?: string;
  }[];
}

export class PacketCensus {
  /**
   * Enough of a fixed-width body to see its shape, and few enough that the file
   * stays evidence about a packet rather than a record of a session.
   */
  static readonly MAX_SAMPLES = 8;

  readonly #registry: PacketRegistry;
  readonly #seen = new Map<number, Sighting>();
  readonly #sampling: boolean;
  #total = 0;

  constructor(registry: PacketRegistry, options: { readonly sampleTails?: boolean } = {}) {
    this.#registry = registry;
    this.#sampling = options.sampleTails ?? false;
  }

  /** Whether undescribed bodies are being recorded, so the caller can say so. */
  get sampling(): boolean {
    return this.#sampling;
  }

  get totalPackets(): number {
    return this.#total;
  }

  /**
   * The stage that feeds it.
   *
   * First in the pipeline, so a packet a later stage drops is still counted:
   * the question is what the game sent, not what survived our handling of it.
   */
  stage(): PipelineStage {
    return {
      name: 'census',
      handle: (packet: MutablePacket, context: PacketContext) => {
        this.#record(packet, context.origin);
      },
    };
  }

  #record(packet: MutablePacket, origin: PacketOrigin): void {
    this.#total += 1;
    const id = packet.decoded.id;

    let sighting = this.#seen.get(id);
    if (sighting === undefined) {
      sighting = {
        name: packet.name,
        fromClient: 0,
        fromServer: 0,
        failed: 0,
        undefinedId: this.#registry.schemaById(id) === undefined,
        undescribedBytes: 0,
        samples: [],
      };
      this.#seen.set(id, sighting);
    }

    if (origin === PacketOrigin.Client) sighting.fromClient += 1;
    else sighting.fromServer += 1;

    if (packet.decoded.schema === undefined && !sighting.undefinedId) {
      sighting.failed += 1;
      sighting.failure ??= packet.decoded.error?.message ?? 'unknown';
    }

    // The largest, not the count: the interesting number is how much of the
    // packet we cannot account for, and a variable-length body makes the
    // biggest sighting the one worth chasing.
    if (packet.decoded.trailing.length > sighting.undescribedBytes) {
      sighting.undescribedBytes = packet.decoded.trailing.length;
    }

    // Only the bytes no schema claimed, and only a few. What a described field
    // already holds is not evidence about anything — it is just the session.
    if (
      this.#sampling &&
      packet.decoded.trailing.length > 0 &&
      sighting.samples.length < PacketCensus.MAX_SAMPLES
    ) {
      sighting.samples.push(packet.decoded.trailing.toString('hex'));
    }
  }

  /** What was seen, with each id's verdict against its definition. */
  report(): CensusReport {
    const ids = [...this.#seen.entries()]
      .sort(([a], [b]) => a - b)
      .map(([id, sighting]) => {
        const definition = this.#registry.schemaById(id);
        // A definition claims one direction; traffic shows another. Reported
        // rather than corrected — a capture is evidence, not authority, and one
        // stray packet should not rewrite the protocol.
        let directionConflict: string | undefined;
        if (definition !== undefined) {
          if (definition.direction === PacketDirection.ClientToServer && sighting.fromServer > 0) {
            directionConflict = `defined c2s, seen ${String(sighting.fromServer)} from the server`;
          } else if (
            definition.direction === PacketDirection.ServerToClient &&
            sighting.fromClient > 0
          ) {
            directionConflict = `defined s2c, seen ${String(sighting.fromClient)} from the client`;
          }
        }

        return {
          id,
          name: sighting.name,
          fromClient: sighting.fromClient,
          fromServer: sighting.fromServer,
          failed: sighting.failed,
          ...(sighting.failure === undefined ? {} : { failure: sighting.failure }),
          undefinedId: sighting.undefinedId,
          undescribedBytes: sighting.undescribedBytes,
          ...(sighting.samples.length === 0 ? {} : { samples: [...sighting.samples] }),
          ...(directionConflict === undefined ? {} : { directionConflict }),
        };
      });

    return { totalPackets: this.#total, ids };
  }

  /** One line saying whether anything needs looking at. */
  summary(): string {
    const report = this.report();
    const unknown = report.ids.filter((row) => row.undefinedId).length;
    const failed = report.ids.filter((row) => row.failed > 0).length;
    const undescribed = report.ids.filter(
      (row) => !row.undefinedId && row.undescribedBytes > 0,
    ).length;
    const conflicts = report.ids.filter((row) => row.directionConflict !== undefined).length;
    return (
      `${String(report.totalPackets)} packets, ${String(report.ids.length)} distinct ids: ` +
      `${String(unknown)} undefined, ${String(failed)} failed to decode, ` +
      `${String(undescribed)} with bytes nobody describes, ` +
      `${String(conflicts)} with the wrong direction`
    );
  }
}
