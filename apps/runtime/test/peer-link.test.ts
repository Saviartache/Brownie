import { CLIENT_KEY, SERVER_KEY } from '@brownie/protocol';
import { describe, expect, it } from 'vitest';
import { PeerLink } from '../src/proxy/PeerLink.js';
import { FakeTransport, PeerCiphers, frameOf } from './fakes.js';

/** A link set up the way a session sets up its client side. */
function clientSideLink(): { link: PeerLink; transport: FakeTransport; frames: Buffer[] } {
  const transport = new FakeTransport();
  const link = new PeerLink({ transport, receiveKey: CLIENT_KEY, sendKey: SERVER_KEY });
  const frames: Buffer[] = [];
  link.onFrame((frame) => frames.push(frame));
  return { link, transport, frames };
}

describe('PeerLink', () => {
  it('deciphers what the peer sends', () => {
    const { transport, frames } = clientSideLink();
    const peer = PeerCiphers.gameClient();

    const plain = frameOf(42, Buffer.from('payload'));
    transport.receive(peer.encipher(plain));

    expect(frames).toHaveLength(1);
    expect(frames[0]!.equals(plain)).toBe(true);
  });

  it('keeps the keystream running across packets', () => {
    const { transport, frames } = clientSideLink();
    const peer = PeerCiphers.gameClient();

    for (let i = 0; i < 5; i++) {
      transport.receive(peer.encipher(frameOf(i, Buffer.from(`body-${String(i)}`))));
    }

    expect(frames.map((f) => f.readUInt8(4))).toEqual([0, 1, 2, 3, 4]);
    expect(frames[4]!.subarray(5).toString()).toBe('body-4');
  });

  it('reassembles frames split across chunks', () => {
    const { transport, frames } = clientSideLink();
    const peer = PeerCiphers.gameClient();
    const wire = Buffer.concat([
      peer.encipher(frameOf(1, Buffer.from('aaaa'))),
      peer.encipher(frameOf(2, Buffer.from('bbbb'))),
    ]);

    for (const byte of wire) transport.receive(Buffer.from([byte]));

    expect(frames.map((f) => f.readUInt8(4))).toEqual([1, 2]);
  });

  it('enciphers what it sends, so the peer can read it back', () => {
    const { link, transport } = clientSideLink();
    const peer = PeerCiphers.gameClient();

    const plain = frameOf(7, Buffer.from('to-the-client'));
    link.send(plain);

    expect(transport.sent).toHaveLength(1);
    expect(peer.decipher(transport.sent[0]!).equals(plain)).toBe(true);
  });

  it('does not mutate the buffer it was asked to forward', () => {
    const { link, transport } = clientSideLink();
    const plain = frameOf(7, Buffer.from('original'));
    const snapshot = Buffer.from(plain);

    link.send(plain);

    // The packet's original bytes stay readable for later stages and logs.
    expect(plain.equals(snapshot)).toBe(true);
    expect(transport.sent[0]!.equals(snapshot)).toBe(false);
  });

  it('enciphers in place when the caller hands over ownership', () => {
    const { link, transport } = clientSideLink();
    const peer = PeerCiphers.gameClient();
    const built = frameOf(9, Buffer.from('freshly-encoded'));
    const expected = Buffer.from(built);

    link.sendOwned(built);

    expect(transport.sent[0]).toBe(built); // no copy was made
    expect(peer.decipher(transport.sent[0]!).equals(expected)).toBe(true);
  });

  it('reports a desynchronised stream instead of throwing into the socket handler', () => {
    const { transport } = clientSideLink();
    const errors: string[] = [];
    // Re-register: the link created in the helper has no error listener.
    const link = new PeerLink({ transport, receiveKey: CLIENT_KEY, sendKey: SERVER_KEY });
    link.onError((error) => errors.push(error.message));

    // A length field that cannot be a frame, whatever it deciphers to.
    const garbage = Buffer.alloc(8);
    garbage.writeInt32BE(-1, 0);
    expect(() => transport.receive(garbage)).not.toThrow();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/desynchronised/);
  });

  it('surfaces transport errors', () => {
    const { link, transport } = clientSideLink();
    const errors: string[] = [];
    link.onError((error) => errors.push(error.message));

    transport.fail(new Error('EPIPE'));

    expect(errors).toEqual(['EPIPE']);
  });

  it('closing the link closes its transport', () => {
    const { link, transport } = clientSideLink();
    link.close();
    expect(transport.closed).toBe(true);
    expect(link.closed).toBe(true);
  });
});
