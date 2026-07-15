// Fail-out-loud + self-learning. Records the collector's own failures, surfaces them,
// applies adaptive backoff to chronically failing components, and derives insights.
import { getDb, recordSysEvent } from './db.js';

let CFG;
let alertFn = null;
const track = new Map(); // component -> { fails, firstTs, lastTs }

export function initSelfMonitor(cfg, onAlert) { CFG = cfg; alertFn = onAlert; }

export function fail(component, code, message, { critical = false } = {}) {
  recordSysEvent('error', component, code, message);
  console.error(`[FAIL:${component}] ${code}: ${message}`);
  const t = track.get(component) || { fails: 0, firstTs: Date.now() };
  t.fails++; t.lastTs = Date.now();
  track.set(component, t);
  if (critical && alertFn) alertFn(`Collector failure: ${component}`, `${code}\n\n${message}`, `fail:${component}`);
  return backoffSec(component);
}

export function ok(component) {
  const t = track.get(component);
  if (t && t.fails) recordSysEvent('info', component, 'recovered', `recovered after ${t.fails} failures`);
  track.delete(component);
}

export function warn(component, code, message) {
  recordSysEvent('warn', component, code, message);
  console.warn(`[WARN:${component}] ${code}: ${message}`);
}

// Exponential backoff based on consecutive failures for a component.
export function backoffSec(component) {
  const t = track.get(component);
  const fails = t?.fails || 0;
  if (fails === 0) return 0;
  const sec = Math.min(CFG.selfMonitor.backoffMaxSec, CFG.selfMonitor.backoffBaseSec * 2 ** (fails - 1));
  return sec;
}

// Current active problems for the fail-out-loud banner.
export function problems() {
  const since = Date.now() - 3600000;
  const rows = getDb().prepare(
    `SELECT component, code, message, COUNT(*) n, MAX(ts) last
     FROM system_events WHERE level='error' AND ts>=? GROUP BY component, code
     ORDER BY last DESC`
  ).all(since);
  return rows.map((r) => ({ ...r, recurring: r.n >= CFG.selfMonitor.recurringThreshold }));
}

// "Learn from failures": recurring components over 24h + a plain suggestion.
export function insights() {
  const since = Date.now() - 86400000;
  const rows = getDb().prepare(
    `SELECT component, code, COUNT(*) n, MIN(ts) first, MAX(ts) last
     FROM system_events WHERE level='error' AND ts>=? GROUP BY component, code
     HAVING n >= ? ORDER BY n DESC`
  ).all(since, CFG.selfMonitor.recurringThreshold);
  return rows.map((r) => ({
    component: r.component, code: r.code, count: r.n,
    windowHrs: +((r.last - r.first) / 3600000).toFixed(1),
    suggestion: suggestionFor(r.component, r.code)
  }));
}

function suggestionFor(component, code) {
  if (component.startsWith('connector:defender')) return 'Check Entra app permissions/secret expiry in the Onboarding wizard, then re-test.';
  if (component.startsWith('connector:perch')) return 'Verify PERCH_API_BASE/TOKEN; the report endpoint or field names may have changed.';
  if (component.startsWith('connector:snmp') || component === 'snmp') return 'Confirm SNMP community, reachability (UDP 161), and the configured OIDs.';
  if (component === 'smtp' || component === 'reporting:email') return 'Verify SMTP host/port/auth and that the relay accepts this sender.';
  if (component === 'syslog') return 'Port 514 may be in use or blocked; check bind address and privileges.';
  if (component === 'prober') return 'Many targets failing at once usually means a network/DNS issue on the collector host.';
  return 'Review recent system events for this component.';
}

export function recentSystemEvents(limit = 100) {
  return getDb().prepare('SELECT ts,level,component,code,message FROM system_events ORDER BY ts DESC LIMIT ?').all(limit);
}
