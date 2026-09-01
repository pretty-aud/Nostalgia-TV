'use strict';

/**
 * Talk to a running mpv over its JSON IPC pipe.
 *
 * mpv is the player on this branch: it decodes everything the library holds
 * (E-AC3, DTS, Matroska, image subtitles), switches audio tracks instantly,
 * and renders into a native window we give it — which is what removes the
 * whole conversion pipeline. This module is the control channel: newline-
 * delimited JSON over a named pipe, requests correlated by request_id,
 * spontaneous events (end-file, property-change) arriving interleaved.
 *
 * Deliberately transport-only. It knows the PROTOCOL — framing, correlation,
 * observers, teardown — and nothing about players, schedules or windows.
 * That is what makes it fully testable against a fake mpv on a real pipe:
 * the protocol is the part that silently corrupts when it drifts, and the
 * part no integration test would isolate.
 *
 * Two rules learned elsewhere in this codebase apply here:
 *  - A failure must never look like a success: every pending request is
 *    REJECTED on disconnect, never left hanging (an unresolved await in the
 *    renderer is a player that quietly stops responding).
 *  - A torn line must not kill the pipe: JSON.parse failures on a partial or
 *    junk line are skipped, because one bad message ending the session would
 *    turn a glitch into a dead player.
 */

const net = require('node:net');

/** How long to keep re-trying while mpv starts up and creates its pipe. */
const DEFAULT_CONNECT_TIMEOUT_MS = 8000;
const CONNECT_RETRY_MS = 150;

/** mpv answers every request; this is a watchdog for a wedged process. */
const DEFAULT_COMMAND_TIMEOUT_MS = 10000;

function connectOnce(pipePath) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipePath);
    const onError = (error) => reject(error);
    socket.once('connect', () => {
      socket.removeListener('error', onError);
      resolve(socket);
    });
    socket.once('error', onError);
  });
}

/**
 * Connect to mpv's IPC pipe, retrying until it exists.
 *
 * mpv creates the pipe some time after its process starts, so the first
 * connect attempts routinely fail — that is startup, not an error. Only a
 * pipe that never appears within the deadline is one.
 */
async function connectMpv(pipePath, options = {}) {
  const deadline = Date.now() + (options.connectTimeoutMs || DEFAULT_CONNECT_TIMEOUT_MS);
  for (;;) {
    try {
      return createClient(await connectOnce(pipePath), options);
    } catch (error) {
      if (Date.now() >= deadline) {
        throw new Error(`mpv IPC pipe never appeared at ${pipePath}: ${error && error.message}`);
      }
      await new Promise((resolve) => setTimeout(resolve, CONNECT_RETRY_MS));
    }
  }
}

function createClient(socket, options = {}) {
  const commandTimeoutMs = options.commandTimeoutMs || DEFAULT_COMMAND_TIMEOUT_MS;

  let nextRequestId = 1;
  let nextObserverId = 1;
  let closed = false;
  let buffered = '';

  /** request_id -> { resolve, reject, timer } */
  const pending = new Map();
  /** observer id -> handler(value, propertyName) */
  const observers = new Map();
  /** event name -> Set<handler> */
  const eventHandlers = new Map();

  socket.setEncoding('utf8');

  socket.on('data', (chunk) => {
    buffered += chunk;
    const lines = buffered.split('\n');
    buffered = lines.pop() || '';   // an unterminated tail waits for its next chunk
    for (const line of lines) {
      const text = line.trim();
      if (!text) continue;
      let message;
      try {
        message = JSON.parse(text);
      } catch {
        continue; // junk on the pipe is mpv's problem, not a reason to die
      }
      dispatch(message);
    }
  });

  function emit(name, payload) {
    const handlers = eventHandlers.get(name);
    if (!handlers) return;
    // Copied so a handler unsubscribing mid-dispatch cannot skip its sibling.
    for (const handler of [...handlers]) {
      try { handler(payload); } catch { /* a listener must not kill the pipe */ }
    }
  }

  function dispatch(message) {
    if (message.request_id !== undefined && pending.has(message.request_id)) {
      const entry = pending.get(message.request_id);
      pending.delete(message.request_id);
      clearTimeout(entry.timer);
      if (message.error === 'success') entry.resolve(message.data);
      else entry.reject(new Error(String(message.error)));
      return;
    }
    if (message.event === 'property-change' && observers.has(message.id)) {
      const handler = observers.get(message.id);
      try { handler(message.data, message.name); } catch { /* as above */ }
      return;
    }
    if (typeof message.event === 'string') emit(message.event, message);
  }

  function failAllPending(reason) {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    pending.clear();
  }

  function teardown(reason) {
    if (closed) return;
    closed = true;
    failAllPending(reason);
    emit('disconnect', { reason });
  }

  socket.on('error', (error) => teardown(`mpv connection error: ${error && error.message}`));
  socket.on('close', () => teardown('mpv connection closed'));

  /**
   * Send one command; resolve with mpv's data or reject with its error.
   * Usage mirrors mpv's own docs: command('set_property', 'pause', true).
   */
  function command(...args) {
    if (closed) return Promise.reject(new Error('mpv connection closed'));
    const requestId = nextRequestId++;
    const payload = `${JSON.stringify({ command: args, request_id: requestId })}\n`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`mpv did not answer ${JSON.stringify(args[0])} within ${commandTimeoutMs}ms`));
      }, commandTimeoutMs);
      pending.set(requestId, { resolve, reject, timer });
      socket.write(payload, (error) => {
        if (error && pending.has(requestId)) {
          pending.delete(requestId);
          clearTimeout(timer);
          reject(error);
        }
      });
    });
  }

  /**
   * Watch a property (time-pos, duration, track-list, eof-reached…).
   *
   * The handler is registered BEFORE the observe_property command is sent,
   * because mpv emits the current value immediately on registration and that
   * first event can arrive before the command's own reply. Returns an async
   * unsubscribe. A failed registration takes its handler back out.
   */
  async function observe(property, handler) {
    const id = nextObserverId++;
    observers.set(id, handler);
    try {
      await command('observe_property', id, property);
    } catch (error) {
      observers.delete(id);
      throw error;
    }
    return async () => {
      observers.delete(id);
      await command('unobserve_property', id).catch(() => { /* pipe may be gone */ });
    };
  }

  /** Subscribe to a named mpv event ('end-file', 'file-loaded', 'disconnect'…). */
  function on(eventName, handler) {
    if (!eventHandlers.has(eventName)) eventHandlers.set(eventName, new Set());
    eventHandlers.get(eventName).add(handler);
    return () => {
      const handlers = eventHandlers.get(eventName);
      if (handlers) handlers.delete(handler);
    };
  }

  function close() {
    teardown('mpv connection closed by this app');
    socket.destroy();
  }

  return { command, observe, on, close, isClosed: () => closed };
}

module.exports = { connectMpv };
