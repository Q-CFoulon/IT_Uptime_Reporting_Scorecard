import net from 'node:net';
import { recordAvail, upsertMachine } from '../db.js';
import { inBusinessHours } from '../util/time.js';

let lastCycle = { ts: 0, probed: 0, up: 0, down: 0, systemUp: true, durationMs: 0 };
export function proberStatus() { return lastCycle; }

const state = new Map(); // name -> { up, fails, lastChange, sinceUp }

function probeTcp(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const sock = new net.Socket();
    let done = false;
    const finish = (up) => { if (done) return; done = true; sock.destroy(); resolve({ up, latency: up ? Date.now() - start : null }); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(port, host);
  });
}

// Bounded-concurrency map over an array.
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  });
  await Promise.all(workers);
  return out;
}

async function cycle(cfg, onStateChange) {
  const t0 = Date.now();
  const { targets, timeoutMs, concurrency, downAfterFails } = cfg.probe;
  const ts = Date.now();
  const ih = inBusinessHours(ts, cfg.businessHours);
  let up = 0, down = 0;

  await pool(targets, concurrency || 100, async (t) => {
    const r = await probeTcp(t.host, t.port, timeoutMs);
    let s = state.get(t.name) || { up: true, fails: 0, lastChange: ts, sinceUp: ts };
    s.fails = r.up ? 0 : s.fails + 1;
    const effUp = s.fails < (downAfterFails || 2); // debounce brief blips
    if (effUp !== s.up) { s.lastChange = ts; if (effUp) s.sinceUp = ts; if (onStateChange) onStateChange(t, effUp); }
    s.up = effUp;
    state.set(t.name, s);
    effUp ? up++ : down++;
    recordAvail(ts, t.name, effUp, r.latency, ih);
    upsertMachine({ name: t.name, host: t.host, port: t.port, grp: t.group || null,
      critical: t.critical ? 1 : 0, os: t.os || null, up: effUp ? 1 : 0, latency: r.latency,
      fails: s.fails, lastChange: s.lastChange, lastSeen: ts, sinceUp: s.sinceUp });
  });

  const crit = targets.filter((t) => t.critical);
  const critDown = crit.filter((t) => !(state.get(t.name)?.up)).length;
  const systemUp = crit.length === 0 ? true : critDown === 0;
  recordAvail(ts, '__system__', systemUp, null, ih);

  lastCycle = { ts, probed: targets.length, up, down, systemUp, inHours: ih, durationMs: Date.now() - t0 };
}

export function startProber(cfg, { onStateChange, onError } = {}) {
  if (!cfg.probe.targets.length) { console.log('[prober] no targets configured'); return; }
  const run = () => cycle(cfg, onStateChange).catch((e) => { console.error('[prober]', e.message); onError?.(e); });
  run();
  const iv = setInterval(run, cfg.probe.intervalSec * 1000);
  console.log(`[prober] ${cfg.probe.targets.length} targets every ${cfg.probe.intervalSec}s (concurrency ${cfg.probe.concurrency || 100})`);
  return iv;
}
