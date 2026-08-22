import { describe, expect, it } from 'vitest';
import { SocketTransport } from '../src/proxy/Transport.js';
import { FakeSocket } from './fakes.js';

describe('SocketTransport', () => {
  it('writes straight through while the peer keeps up', () => {
    const socket = new FakeSocket();
    const transport = new SocketTransport(socket.asSocket());

    transport.send(Buffer.from('one'));
    transport.send(Buffer.from('two'));

    expect(socket.written.map(String)).toEqual(['one', 'two']);
    expect(transport.pending).toBe(0);
  });

  it('queues once the peer stops keeping up, and flushes in order on drain', () => {
    const socket = new FakeSocket();
    const transport = new SocketTransport(socket.asSocket());

    socket.writeAccepts = false;
    transport.send(Buffer.from('a')); // accepted by Node, but it wants a pause
    transport.send(Buffer.from('b')); // queued
    transport.send(Buffer.from('c')); // queued

    expect(socket.written.map(String)).toEqual(['a']);
    expect(transport.pending).toBe(2);

    socket.drain();

    expect(socket.written.map(String)).toEqual(['a', 'b', 'c']);
    expect(transport.pending).toBe(0);
  });

  it('never lets a later send overtake queued bytes', () => {
    const socket = new FakeSocket();
    const transport = new SocketTransport(socket.asSocket());

    socket.writeAccepts = false;
    transport.send(Buffer.from('first'));
    socket.writeAccepts = true; // Node would accept it now…
    transport.send(Buffer.from('second')); // …but ordering must hold

    expect(socket.written.map(String)).toEqual(['first']);
    socket.drain();
    expect(socket.written.map(String)).toEqual(['first', 'second']);
  });

  it('holds everything until resume, for the connect window', () => {
    const socket = new FakeSocket();
    const transport = new SocketTransport(socket.asSocket(), { startPaused: true });

    transport.send(Buffer.from('during-connect-1'));
    transport.send(Buffer.from('during-connect-2'));
    expect(socket.written).toHaveLength(0);
    expect(transport.pending).toBe(32);

    transport.resume();

    expect(socket.written.map(String)).toEqual(['during-connect-1', 'during-connect-2']);
    expect(transport.pending).toBe(0);
  });

  it('holds again after it has been running, and lets go in order', () => {
    const socket = new FakeSocket();
    const transport = new SocketTransport(socket.asSocket());

    transport.send(Buffer.from('before'));
    transport.pause();
    transport.send(Buffer.from('held-1'));
    transport.send(Buffer.from('held-2'));

    // What was already written stays written — a hold stops the next byte, not
    // the last one.
    expect(socket.written.map(String)).toEqual(['before']);

    transport.resume();

    // In order, which is the whole point: these are enciphered frames, and the
    // game's own tick acknowledgements. A gap in either is unrecoverable.
    expect(socket.written.map(String)).toEqual(['before', 'held-1', 'held-2']);
    expect(transport.pending).toBe(0);
  });

  it('resumes are idempotent', () => {
    const socket = new FakeSocket();
    const transport = new SocketTransport(socket.asSocket(), { startPaused: true });
    transport.send(Buffer.from('x'));
    transport.resume();
    transport.resume();
    expect(socket.written.map(String)).toEqual(['x']);
  });

  it('closes rather than buffering an unbounded amount', () => {
    const socket = new FakeSocket();
    const transport = new SocketTransport(socket.asSocket(), { maxPendingBytes: 16 });
    const errors: Error[] = [];
    transport.onError((error) => errors.push(error));

    socket.writeAccepts = false;
    transport.send(Buffer.alloc(4)); // goes to the socket, triggers backpressure
    transport.send(Buffer.alloc(10));
    transport.send(Buffer.alloc(10)); // now 20 pending > 16

    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toMatch(/bytes behind/);
    expect(transport.closed).toBe(true);
    expect(socket.destroyed).toBe(true);
  });

  it('reports closure and stops accepting sends', () => {
    const socket = new FakeSocket();
    const transport = new SocketTransport(socket.asSocket());
    let closed = 0;
    transport.onClose(() => closed++);

    transport.close();
    transport.close();
    transport.send(Buffer.from('ignored'));

    expect(closed).toBe(1);
    expect(socket.written).toHaveLength(0);
    expect(transport.closed).toBe(true);
  });

  it('forwards incoming data and errors', () => {
    const socket = new FakeSocket();
    const transport = new SocketTransport(socket.asSocket());
    const chunks: string[] = [];
    const errors: string[] = [];
    transport.onData((chunk) => chunks.push(chunk.toString()));
    transport.onError((error) => errors.push(error.message));

    socket.emit('data', Buffer.from('hello'));
    socket.emit('error', new Error('ECONNRESET'));

    expect(chunks).toEqual(['hello']);
    expect(errors).toEqual(['ECONNRESET']);
  });
});
