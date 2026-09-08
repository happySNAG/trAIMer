#!/usr/bin/env node
/**
 * RELEASE GATE — helper↔renderer clock synchronization, against the REAL
 * Windows helper binary.
 *
 * Every other test of this path uses a scripted stand-in. This one starts the
 * freshly built `traimer_capture_helper.exe`, speaks the real loopback
 * WebSocket protocol to it, and proves on the actual hardware path that:
 *
 *   - the helper answers `time-sync` at all (an old helper cannot, and must
 *     therefore never carry a measurement);
 *   - its `welcome` advertises `supportsTimeSync` and the pinned version;
 *   - the reply ids round-trip, so no answer can be attributed to the wrong
 *     probe;
 *   - its monotonic clock only ever moves forward;
 *   - the offset estimate's PROVEN bound (half the minimum round trip) lands
 *     inside MAX_CLOCK_SYNC_UNCERTAINTY_MS on a real machine;
 *   - the estimate is stable: the offset recovered from the first half of the
 *     exchanges and from the second half agree to within their own bounds.
 *
 * See docs/CLOCK-DOMAINS.md. No `ws` dependency: the helper implements a
 * minimal RFC 6455 server, so this speaks a minimal RFC 6455 client.
 */
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { performance } from "node:perf_hooks";

const MAX_CLOCK_SYNC_UNCERTAINTY_MS = 2;
const MIN_CLOCK_SYNC_SAMPLES = 5;
const PROBES = 12;
const PORT = 48771;

/**
 * Hard deadlines. A gate that HANGS is worse than one that fails: the first
 * run of this script sat for twenty minutes against a helper that had
 * silently stopped reading its socket, and told nobody why. Every wait below
 * is bounded, and every timeout names what it was waiting for.
 */
const UPGRADE_TIMEOUT_MS = 10_000;
const MESSAGE_TIMEOUT_MS = 10_000;
const OVERALL_TIMEOUT_MS = 90_000;

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

// ---------------------------------------------------------------------------
// Minimal RFC 6455 client
// ---------------------------------------------------------------------------

function encodeTextFrame(text) {
  const payload = Buffer.from(text, "utf8");
  const mask = randomBytes(4);
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, 0x80 | payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    fail("frame too large for this client");
  }
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

/** Returns [messages, remainingBuffer]. Server frames are never masked. */
function decodeFrames(buffer) {
  const messages = [];
  let offset = 0;
  for (;;) {
    if (buffer.length - offset < 2) break;
    const opcode = buffer[offset] & 0x0f;
    const masked = (buffer[offset + 1] & 0x80) !== 0;
    let length = buffer[offset + 1] & 0x7f;
    let cursor = offset + 2;
    if (length === 126) {
      if (buffer.length - cursor < 2) break;
      length = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (length === 127) {
      if (buffer.length - cursor < 8) break;
      length = Number(buffer.readBigUInt64BE(cursor));
      cursor += 8;
    }
    if (masked) cursor += 4;
    if (buffer.length - cursor < length) break;
    const payload = buffer.subarray(cursor, cursor + length);
    if (opcode === 0x1) messages.push(payload.toString("utf8"));
    offset = cursor + length;
  }
  return [messages, buffer.subarray(offset)];
}

function withTimeout(promise, ms, what) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out after ${ms} ms waiting for ${what}`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function openSocket(port) {
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString("base64");
    const expectedAccept = createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    const socket = connect(port, "127.0.0.1");
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    const listeners = [];
    socket.on("error", reject);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end === -1) return;
        const head = buffer.subarray(0, end).toString("utf8");
        buffer = buffer.subarray(end + 4);
        if (!head.startsWith("HTTP/1.1 101")) {
          reject(new Error(`helper refused the upgrade: ${head.split("\r\n")[0]}`));
          return;
        }
        if (!head.includes(expectedAccept)) {
          reject(new Error("helper returned a wrong Sec-WebSocket-Accept"));
          return;
        }
        upgraded = true;
        resolve({
          send: (text) => socket.write(encodeTextFrame(text)),
          onMessage: (cb) => listeners.push(cb),
          close: () => socket.destroy(),
        });
      }
      const [messages, rest] = decodeFrames(buffer);
      buffer = rest;
      for (const message of messages) for (const cb of listeners) cb(message);
    });
    socket.on("connect", () => {
      socket.write(
        [
          `GET / HTTP/1.1`,
          `Host: 127.0.0.1:${port}`,
          `Upgrade: websocket`,
          `Connection: Upgrade`,
          `Sec-WebSocket-Key: ${key}`,
          `Sec-WebSocket-Version: 13`,
          ``,
          ``,
        ].join("\r\n"),
      );
    });
  });
}

// ---------------------------------------------------------------------------

async function main() {
  const helperPath =
    process.argv[2] ?? "native/windows/traimer_capture_helper.exe";
  if (!existsSync(helperPath)) fail(`helper not found at ${helperPath}`);

  const token = randomBytes(16).toString("hex");
  const helper = spawn(helperPath, ["--token", token, "--port", String(PORT)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  helper.stdout.on("data", (d) => process.stdout.write(`[helper] ${d}`));
  helper.stderr.on("data", (d) => process.stderr.write(`[helper] ${d}`));

  const cleanup = () => {
    try {
      helper.kill();
    } catch {
      /* already gone */
    }
  };
  process.on("exit", cleanup);

  // Retry the connect rather than sleeping a guessed amount: a cold CI runner
  // can take longer than any constant to bind, and a flaky gate is a gate
  // nobody trusts.
  let socket = null;
  const connectDeadline = Date.now() + UPGRADE_TIMEOUT_MS;
  let lastConnectError = null;
  while (socket === null && Date.now() < connectDeadline) {
    if (helper.exitCode !== null) {
      fail(`helper exited with code ${helper.exitCode} before accepting a client`);
    }
    try {
      socket = await withTimeout(
        openSocket(PORT),
        2000,
        "the helper's WebSocket upgrade",
      );
    } catch (err) {
      lastConnectError = err;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  if (socket === null) {
    fail(
      `helper never accepted a client on 127.0.0.1:${PORT}: ${String(lastConnectError?.message ?? lastConnectError)}`,
    );
  }
  const inbox = [];
  const waiters = [];
  socket.onMessage((raw) => {
    const parsed = JSON.parse(raw);
    const waiter = waiters.shift();
    if (waiter) waiter(parsed);
    else inbox.push(parsed);
  });
  const next = (what) =>
    withTimeout(
      new Promise((resolve) => {
        const queued = inbox.shift();
        if (queued) resolve(queued);
        else waiters.push(resolve);
      }),
      MESSAGE_TIMEOUT_MS,
      what,
    );

  socket.send(
    JSON.stringify({
      type: "hello",
      protocolVersion: 1,
      sessionToken: token,
      appVersion: "verify-clock-sync",
    }),
  );

  let welcome = await next("the helper's welcome");
  while (welcome.type === "lifecycle") welcome = await next("the helper's welcome");
  if (welcome.type !== "welcome") fail(`expected welcome, got ${welcome.type}`);
  console.log(
    `welcome: ${welcome.helperVersion} protocol=${welcome.protocolVersion} device=${welcome.deviceId}`,
  );
  if (welcome.supportsTimeSync !== true) {
    fail("helper does not advertise supportsTimeSync — it cannot carry a measurement");
  }
  if (typeof welcome.timeOriginNote !== "string" || welcome.timeOriginNote.length === 0) {
    fail("helper did not describe its time origin");
  }

  const samples = [];
  for (let i = 0; i < PROBES; i++) {
    const id = `probe-${i}`;
    const t0 = performance.now();
    socket.send(JSON.stringify({ type: "time-sync", id }));
    let reply = await next(`a time-sync reply for ${id}`);
    // Raw input can interleave frames with the reply.
    while (reply.type !== "time-sync-reply") {
      reply = await next(`a time-sync reply for ${id}`);
    }
    const t2 = performance.now();
    if (reply.id !== id) fail(`reply id mismatch: sent ${id}, got ${reply.id}`);
    if (typeof reply.helperMonotonicMs !== "number" || !Number.isFinite(reply.helperMonotonicMs)) {
      fail(`malformed helperMonotonicMs: ${String(reply.helperMonotonicMs)}`);
    }
    samples.push({ t0, helperMs: reply.helperMonotonicMs, t2 });
    await new Promise((r) => setTimeout(r, 25));
  }
  socket.close();

  if (samples.length < MIN_CLOCK_SYNC_SAMPLES) {
    fail(`only ${samples.length} exchanges completed`);
  }

  for (let i = 1; i < samples.length; i++) {
    if (samples[i].helperMs <= samples[i - 1].helperMs) {
      fail(
        `helper clock did not advance: ${samples[i - 1].helperMs} then ${samples[i].helperMs}`,
      );
    }
    if (samples[i].t2 < samples[i].t0) fail("client clock went backwards");
  }

  const estimate = (list) => {
    let best = list[0];
    for (const s of list) if (s.t2 - s.t0 < best.t2 - best.t0) best = s;
    const rtt = best.t2 - best.t0;
    return { offsetMs: best.t0 + rtt / 2 - best.helperMs, boundMs: rtt / 2, rttMs: rtt };
  };

  const all = estimate(samples);
  const firstHalf = estimate(samples.slice(0, Math.floor(samples.length / 2)));
  const secondHalf = estimate(samples.slice(Math.floor(samples.length / 2)));

  console.log(
    `offset ${all.offsetMs.toFixed(3)} ms  ±${all.boundMs.toFixed(3)} ms  (min RTT ${all.rttMs.toFixed(3)} ms over ${samples.length} exchanges)`,
  );
  console.log(
    `first half ${firstHalf.offsetMs.toFixed(3)} ±${firstHalf.boundMs.toFixed(3)} · second half ${secondHalf.offsetMs.toFixed(3)} ±${secondHalf.boundMs.toFixed(3)}`,
  );

  if (all.boundMs > MAX_CLOCK_SYNC_UNCERTAINTY_MS) {
    fail(
      `offset could only be bounded to ±${all.boundMs.toFixed(3)} ms (limit ±${MAX_CLOCK_SYNC_UNCERTAINTY_MS} ms)`,
    );
  }
  const drift = Math.abs(firstHalf.offsetMs - secondHalf.offsetMs);
  const allowed =
    firstHalf.boundMs + secondHalf.boundMs + MAX_CLOCK_SYNC_UNCERTAINTY_MS;
  if (drift > allowed) {
    fail(
      `offset drifted ${drift.toFixed(3)} ms between halves (allowed ${allowed.toFixed(3)} ms)`,
    );
  }

  // The helper's own origin is its process start, so a freshly started helper
  // must report a SMALL monotonic value — proof that it is not reporting wall
  // clock or the renderer's clock by accident.
  if (samples[0].helperMs > 120_000) {
    fail(
      `helper reported ${samples[0].helperMs.toFixed(0)} ms since its own start moments after launch — that is not a process-start origin`,
    );
  }

  console.log("clock-sync gate: all checks passed");
  clearTimeout(overall);
  cleanup();
}

const overall = setTimeout(() => {
  console.error(
    `FAIL: clock-sync gate did not finish within ${OVERALL_TIMEOUT_MS} ms`,
  );
  process.exit(1);
}, OVERALL_TIMEOUT_MS);
overall.unref?.();

main().catch((err) => {
  console.error(String(err?.message ?? err));
  process.exitCode = process.exitCode || 1;
  process.exit(process.exitCode);
});
