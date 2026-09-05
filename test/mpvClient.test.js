import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { connectMpv } from '../electron/mpvClient.js';

/**
 * The mpv control channel, exercised against a FAKE MPV on a REAL pipe.
 *
 * Not a mock of the client's internals: a net server speaking mpv's actual
 * wire protocol (newline-delimited JSON, request_id correlation, spontaneous
 * events), so the framing, correlation and teardown logic run exactly the
 * code paths the real player will. The protocol layer is where drift
 * corrupts silently — a response matched to the wrong request is a seek that
 * lands on the wrong episode with no error anywhere.
 */

let cleanups = [];
afterEach(async () => {
  for (const fn of cleanups.reverse()) {
    try { await fn(); } catch { /* already gone */ }
  }
  cleanups = [];
});

let pipeCounter = 0;
function freshPipePath() {
  pipeCounter += 1;
  const name = `ntv-mpv-test-${process.pid}-${pipeCounter}`;
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\${name}`
    : path.join(os.tmpdir(), `${name}.sock`);
}

/**
 * A fake mpv: accepts one connection, hands each received JSON line to
 * `onCommand(message, socket)`. Helpers on the socket-side send well-formed
 * replies and events. Returns { pipePath, sockets } once listening.
 */
function fakeMpv(onCommand) {
  const pipePath = freshPipePath();
  const sockets = [];
  const server = net.createServer((socket) => {
    sockets.push(socket);
    let buffered = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffered += chunk;
      const lines = buffered.split('\n');
      buffered = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        onCommand(JSON.parse(line), socket);
      }
    });
    socket.on('error', () => {});
  });
  const listening = new Promise((resolve) => server.listen(pipePath, resolve));
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  return listening.then(() => ({ pipePath, server, sockets }));
}

const reply = (socket, requestId, data) => {
  socket.write(`${JSON.stringify({ error: 'success', data, request_id: requestId })}\n`);
};
const replyError = (socket, requestId, error) => {
  socket.write(`${JSON.stringify({ error, request_id: requestId })}\n`);
};

async function connectTo(pipePath, options = {}) {
  const client = await connectMpv(pipePath, { connectTimeoutMs: 4000, ...options });
  cleanups.push(() => client.close());
  return client;
}

describe('mpv IPC client', () => {
  it('resolves a command with the data mpv answers', async () => {
    const { pipePath } = await fakeMpv((msg, socket) => {
      expect(msg.command).toEqual(['get_property', 'duration']);
      reply(socket, msg.request_id, 1441.5);
    });
    const client = await connectTo(pipePath);
    expect(await client.command('get_property', 'duration')).toBe(1441.5);
  });

  it('correlates out-of-order responses to their own requests', async () => {
    // mpv genuinely answers out of order (a slow loadfile vs a cheap
    // get_property). Matching by arrival order instead of request_id would
    // hand the seek position to the volume call — with no error anywhere.
    const held = [];
    const { pipePath } = await fakeMpv((msg, socket) => {
      held.push({ msg, socket });
      if (held.length === 2) {
        const [first, second] = held;
        reply(second.socket, second.msg.request_id, 'SECOND');
        reply(first.socket, first.msg.request_id, 'FIRST');
      }
    });
    const client = await connectTo(pipePath);
    const [a, b] = await Promise.all([
      client.command('get_property', 'a'),
      client.command('get_property', 'b'),
    ]);
    expect(a).toBe('FIRST');
    expect(b).toBe('SECOND');
  });

  it('rejects with mpv\'s own error text on a failed command', async () => {
    const { pipePath } = await fakeMpv((msg, socket) => {
      replyError(socket, msg.request_id, 'property not found');
    });
    const client = await connectTo(pipePath);
    await expect(client.command('get_property', 'nonsense'))
      .rejects.toThrow('property not found');
  });

  it('reassembles a response torn across chunks, and splits two sharing one', async () => {
    const { pipePath } = await fakeMpv((msg, socket) => {
      if (msg.command[1] === 'torn') {
        const whole = `${JSON.stringify({ error: 'success', data: 'reassembled', request_id: msg.request_id })}\n`;
        socket.write(whole.slice(0, 9));
        setTimeout(() => socket.write(whole.slice(9)), 20);
      } else {
        // Two complete replies in a single write: the second must not be lost.
        const one = JSON.stringify({ error: 'success', data: 'x', request_id: msg.request_id });
        const two = JSON.stringify({ event: 'file-loaded' });
        socket.write(`${one}\n${two}\n`);
      }
    });
    const client = await connectTo(pipePath);
    const loaded = new Promise((resolve) => client.on('file-loaded', resolve));
    expect(await client.command('get_property', 'torn')).toBe('reassembled');
    expect(await client.command('get_property', 'joined')).toBe('x');
    await loaded;   // the event that shared a chunk with a response arrived too
  });

  it('skips a junk line without killing the pipe', async () => {
    const { pipePath } = await fakeMpv((msg, socket) => {
      socket.write('this is not json\n');
      reply(socket, msg.request_id, 'still alive');
    });
    const client = await connectTo(pipePath);
    expect(await client.command('get_property', 'x')).toBe('still alive');
  });

  it('delivers named events to on() handlers, and unsubscribe removes them', async () => {
    let pushEvent = null;
    const { pipePath } = await fakeMpv((msg, socket) => {
      pushEvent = () => socket.write(`${JSON.stringify({ event: 'end-file', reason: 'eof' })}\n`);
      reply(socket, msg.request_id, null);
    });
    const client = await connectTo(pipePath);
    await client.command('get_property', 'x'); // ensures the server has a socket

    const seen = [];
    const off = client.on('end-file', (event) => seen.push(event.reason));
    pushEvent();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(seen).toEqual(['eof']);

    off();
    pushEvent();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(seen).toEqual(['eof']);   // unchanged: the handler is gone
  });

  it('routes property-change events to the right observer by id', async () => {
    const acks = [];
    const { pipePath } = await fakeMpv((msg, socket) => {
      if (msg.command[0] === 'observe_property') {
        acks.push({ id: msg.command[1], name: msg.command[2], socket });
        reply(socket, msg.request_id, null);
      } else if (msg.command[0] === 'unobserve_property') {
        reply(socket, msg.request_id, null);
      }
    });
    const client = await connectTo(pipePath);

    const times = [];
    const volumes = [];
    await client.observe('time-pos', (v) => times.push(v));
    const unobserveVolume = await client.observe('volume', (v) => volumes.push(v));
    expect(acks.map((a) => a.name)).toEqual(['time-pos', 'volume']);

    const push = (id, name, data) => acks[0].socket.write(
      `${JSON.stringify({ event: 'property-change', id, name, data })}\n`,
    );
    push(acks[0].id, 'time-pos', 12.5);
    push(acks[1].id, 'volume', 80);
    push(acks[0].id, 'time-pos', 13.0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(times).toEqual([12.5, 13.0]);
    expect(volumes).toEqual([80]);

    await unobserveVolume();
    push(acks[1].id, 'volume', 55);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(volumes).toEqual([80]);   // an unobserved property stays quiet
  });

  it('close() rejects everything pending and refuses new commands', async () => {
    const { pipePath } = await fakeMpv(() => { /* never answers */ });
    const client = await connectTo(pipePath);

    const hanging = client.command('get_property', 'never');
    client.close();
    await expect(hanging).rejects.toThrow('closed');
    await expect(client.command('get_property', 'after')).rejects.toThrow('closed');
    expect(client.isClosed()).toBe(true);
  });

  it('a dropped connection rejects pending commands and emits disconnect', async () => {
    // The failure that must never look like success: mpv crashing mid-request
    // has to surface as a rejection, not a promise that hangs forever while
    // the channel silently plays on with no player behind it.
    let serverSocket = null;
    const { pipePath } = await fakeMpv((msg, socket) => { serverSocket = socket; });
    const client = await connectTo(pipePath);

    const disconnected = new Promise((resolve) => client.on('disconnect', resolve));
    const hanging = client.command('get_property', 'never');
    await new Promise((resolve) => setTimeout(resolve, 30)); // let the command land
    serverSocket.destroy();

    await expect(hanging).rejects.toThrow(/closed|error/);
    await disconnected;
    expect(client.isClosed()).toBe(true);
  });

  it('keeps retrying until the pipe appears (mpv is still starting up)', async () => {
    const pipePath = freshPipePath();
    const clientPromise = connectMpv(pipePath, { connectTimeoutMs: 4000 });

    // The pipe comes into existence ~300ms AFTER the connect began — exactly
    // the window between spawning mpv and it creating its IPC endpoint.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const server = net.createServer((socket) => {
      socket.setEncoding('utf8');
      let buffered = '';
      socket.on('data', (chunk) => {
        buffered += chunk;
        const lines = buffered.split('\n');
        buffered = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          reply(socket, JSON.parse(line).request_id, 'late but here');
        }
      });
    });
    await new Promise((resolve) => server.listen(pipePath, resolve));
    cleanups.push(() => new Promise((resolve) => server.close(resolve)));

    const client = await clientPromise;
    cleanups.push(() => client.close());
    expect(await client.command('get_property', 'x')).toBe('late but here');
  });

  it('gives up when the pipe never appears', async () => {
    await expect(connectMpv(freshPipePath(), { connectTimeoutMs: 600 }))
      .rejects.toThrow('never appeared');
  });

  it('times out a command mpv never answers', async () => {
    const { pipePath } = await fakeMpv(() => { /* wedged */ });
    const client = await connectTo(pipePath, { commandTimeoutMs: 300 });
    await expect(client.command('loadfile', 'x.mkv'))
      .rejects.toThrow('did not answer');
  });
});
