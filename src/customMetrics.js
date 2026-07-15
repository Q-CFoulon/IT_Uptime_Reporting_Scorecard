// User-defined metrics derived from already-ingested logs. A definition matches events
// by any of {source, category, eventId, severity, host LIKE, message REGEXP-ish} and
// counts them for the period. Lets users build new metrics without new collection.
import { getDb } from './db.js';

export function evalMetric(def, startMs, endMs) {
  const m = def.match || {};
  const where = ['ts>=?', 'ts<?'], args = [startMs, endMs];
  if (m.source) { where.push('source=?'); args.push(m.source); }
  if (m.category) { where.push('category=?'); args.push(m.category); }
  if (m.eventId != null) { where.push('event_id=?'); args.push(m.eventId); }
  if (m.severityMax != null) { where.push('severity<=?'); args.push(m.severityMax); }
  if (m.hostLike) { where.push('host LIKE ?'); args.push(`%${m.hostLike}%`); }
  if (m.messageLike) { where.push('message LIKE ?'); args.push(`%${m.messageLike}%`); }
  const value = getDb().prepare(`SELECT COUNT(*) n FROM events WHERE ${where.join(' AND ')}`).get(...args).n;
  return { id: def.id, name: def.name, unit: def.unit || 'events', value };
}

export function evalAll(cfg, startMs, endMs) {
  return (cfg.customMetrics || []).map((d) => evalMetric(d, startMs, endMs));
}
