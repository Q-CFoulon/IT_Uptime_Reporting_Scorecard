import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

let db;

export function initDb(path) {
  mkdirSync(dirname(path), { recursive: true });
  db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS events(
      id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, host TEXT, source TEXT,
      facility INTEGER, severity INTEGER, event_id INTEGER, category TEXT, message TEXT, raw TEXT);
    CREATE INDEX IF NOT EXISTS idx_events_ts  ON events(ts);
    CREATE INDEX IF NOT EXISTS idx_events_cat ON events(category);
    CREATE INDEX IF NOT EXISTS idx_events_eid ON events(event_id);

    CREATE TABLE IF NOT EXISTS avail_samples(
      id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, target TEXT NOT NULL,
      up INTEGER NOT NULL, latency_ms REAL, in_hours INTEGER NOT NULL DEFAULT 1);
    CREATE INDEX IF NOT EXISTS idx_avail ON avail_samples(target, ts);

    -- Current state per machine (fast queries at thousands-of-hosts scale).
    CREATE TABLE IF NOT EXISTS machine_status(
      name TEXT PRIMARY KEY, host TEXT, port INTEGER, grp TEXT, critical INTEGER, os TEXT,
      up INTEGER, latency_ms REAL, consecutive_fails INTEGER DEFAULT 0,
      last_change INTEGER, last_seen INTEGER, since_up INTEGER);

    CREATE TABLE IF NOT EXISTS disk_samples(
      id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, array TEXT NOT NULL,
      used_bytes REAL, total_bytes REAL, origin TEXT DEFAULT 'manual');
    CREATE INDEX IF NOT EXISTS idx_disk ON disk_samples(array, ts);

    CREATE TABLE IF NOT EXISTS event_metrics(
      id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, period TEXT NOT NULL, source TEXT NOT NULL,
      data_points INTEGER DEFAULT 0, escalations INTEGER DEFAULT 0, interventions INTEGER DEFAULT 0,
      origin TEXT DEFAULT 'manual', UNIQUE(period, source));

    CREATE TABLE IF NOT EXISTS notices(
      id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, tier INTEGER NOT NULL, description TEXT);

    CREATE TABLE IF NOT EXISTS users(
      username TEXT PRIMARY KEY, pw_hash TEXT NOT NULL, salt TEXT NOT NULL,
      role TEXT DEFAULT 'admin', created INTEGER);

    -- Collector's own failures/warnings (fail-out-loud + self-learning).
    CREATE TABLE IF NOT EXISTS system_events(
      id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, level TEXT, component TEXT,
      code TEXT, message TEXT, resolved INTEGER DEFAULT 0);
    CREATE INDEX IF NOT EXISTS idx_sysev ON system_events(component, ts);

    CREATE TABLE IF NOT EXISTS dashboards(
      id TEXT PRIMARY KEY, name TEXT, layout TEXT, updated INTEGER);

    CREATE TABLE IF NOT EXISTS alerts_sent(
      id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, key TEXT, detail TEXT);
    CREATE INDEX IF NOT EXISTS idx_alerts ON alerts_sent(key, ts);

    CREATE TABLE IF NOT EXISTS report_runs(
      id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, schedule TEXT, period TEXT,
      status TEXT, detail TEXT);

    -- User-defined metrics created at runtime (merged with config customMetrics).
    CREATE TABLE IF NOT EXISTS custom_metrics(
      id TEXT PRIMARY KEY, name TEXT, match_json TEXT, unit TEXT, created INTEGER);
  `);
  return db;
}

export function getDb() { if (!db) throw new Error('db not initialised'); return db; }

const q = {};
function prep() {
  q.insEvent = db.prepare(`INSERT INTO events(ts,host,source,facility,severity,event_id,category,message,raw) VALUES(?,?,?,?,?,?,?,?,?)`);
  q.insAvail = db.prepare(`INSERT INTO avail_samples(ts,target,up,latency_ms,in_hours) VALUES(?,?,?,?,?)`);
  q.insDisk = db.prepare(`INSERT INTO disk_samples(ts,array,used_bytes,total_bytes,origin) VALUES(?,?,?,?,?)`);
  q.upsertMetric = db.prepare(`INSERT INTO event_metrics(ts,period,source,data_points,escalations,interventions,origin)
     VALUES(?,?,?,?,?,?,?) ON CONFLICT(period,source) DO UPDATE SET
       ts=excluded.ts, data_points=excluded.data_points, escalations=excluded.escalations,
       interventions=excluded.interventions, origin=excluded.origin`);
  q.insNotice = db.prepare(`INSERT INTO notices(ts,tier,description) VALUES(?,?,?)`);
  q.delNotice = db.prepare(`DELETE FROM notices WHERE id=?`);
  q.upsertMachine = db.prepare(`INSERT INTO machine_status(name,host,port,grp,critical,os,up,latency_ms,consecutive_fails,last_change,last_seen,since_up)
     VALUES(@name,@host,@port,@grp,@critical,@os,@up,@latency,@fails,@lastChange,@lastSeen,@sinceUp)
     ON CONFLICT(name) DO UPDATE SET host=@host,port=@port,grp=@grp,critical=@critical,os=@os,
       up=@up,latency_ms=@latency,consecutive_fails=@fails,last_change=@lastChange,last_seen=@lastSeen,since_up=@sinceUp`);
  q.insSysEvent = db.prepare(`INSERT INTO system_events(ts,level,component,code,message) VALUES(?,?,?,?,?)`);
}

export function recordEvent(ev) { if (!q.insEvent) prep();
  q.insEvent.run(ev.ts, ev.host, ev.source, ev.facility, ev.severity, ev.event_id ?? null, ev.category, ev.message, ev.raw); }
export function recordAvail(ts, target, up, latency, inHours) { if (!q.insAvail) prep();
  q.insAvail.run(ts, target, up ? 1 : 0, latency ?? null, inHours ? 1 : 0); }
export function recordDisk(ts, array, used, total, origin) { if (!q.insDisk) prep();
  q.insDisk.run(ts, array, used, total, origin || 'manual'); }
export function upsertEventMetric(period, source, dp, esc, intv, origin) { if (!q.upsertMetric) prep();
  q.upsertMetric.run(Date.now(), period, source, dp | 0, esc | 0, intv | 0, origin || 'manual'); }
export function addNotice(ts, tier, description) { if (!q.insNotice) prep();
  return q.insNotice.run(ts, tier, description).lastInsertRowid; }
export function deleteNotice(id) { if (!q.delNotice) prep(); q.delNotice.run(id); }
export function upsertMachine(m) { if (!q.upsertMachine) prep(); q.upsertMachine.run(m); }
export function recordSysEvent(level, component, code, message) { if (!q.insSysEvent) prep();
  q.insSysEvent.run(Date.now(), level, component, code, String(message).slice(0, 500)); }
