import { getDb } from './db.js';

// Fleet summary — aggregates only, so the overview stays light at thousands of hosts.
export function fleetSummary() {
  const db = getDb();
  const r = db.prepare(`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN up=1 THEN 1 ELSE 0 END) AS up,
      SUM(CASE WHEN up=0 THEN 1 ELSE 0 END) AS down,
      SUM(CASE WHEN up=0 AND critical=1 THEN 1 ELSE 0 END) AS critical_down
    FROM machine_status`).get();
  const flapping = db.prepare(
    `SELECT COUNT(*) n FROM machine_status WHERE up=1 AND last_change > ?`
  ).get(Date.now() - 3600000).n; // recovered within the last hour
  return { total: r.total || 0, up: r.up || 0, down: r.down || 0, criticalDown: r.critical_down || 0, recentlyRecovered: flapping };
}

// Paginated, filterable list for investigation.
export function listMachines({ status, group, search, limit = 50, offset = 0, sort = 'critical' } = {}) {
  const where = [], args = [];
  if (status === 'down') where.push('up=0');
  else if (status === 'up') where.push('up=1');
  else if (status === 'critical-down') where.push('up=0 AND critical=1');
  if (group) { where.push('grp=?'); args.push(group); }
  if (search) { where.push('(name LIKE ? OR host LIKE ?)'); args.push(`%${search}%`, `%${search}%`); }
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const order = sort === 'name' ? 'name ASC'
    : sort === 'lastchange' ? 'last_change DESC'
    : 'up ASC, critical DESC, last_change DESC'; // problems first
  const db = getDb();
  const total = db.prepare(`SELECT COUNT(*) n FROM machine_status ${clause}`).get(...args).n;
  const rows = db.prepare(
    `SELECT name,host,port,grp,critical,os,up,latency_ms,consecutive_fails,last_change,last_seen,since_up
     FROM machine_status ${clause} ORDER BY ${order} LIMIT ? OFFSET ?`
  ).all(...args, Math.min(limit, 500), offset);
  return { total, limit, offset, rows };
}

export function machineDetail(name) {
  const db = getDb();
  const status = db.prepare('SELECT * FROM machine_status WHERE name=?').get(name);
  if (!status) return null;
  const events = db.prepare(
    `SELECT ts,source,category,event_id,severity,message FROM events
     WHERE host=? ORDER BY ts DESC LIMIT 50`
  ).all(name);
  // last 24h availability rollup
  const since = Date.now() - 86400000;
  const roll = db.prepare(
    `SELECT SUM(CASE WHEN up=1 THEN 1 ELSE 0 END) up_n, COUNT(*) n
     FROM avail_samples WHERE target=? AND ts>=?`
  ).get(name, since);
  return {
    status, events,
    availability24h: roll.n ? +(roll.up_n / roll.n * 100).toFixed(2) : null
  };
}

export function distinctGroups() {
  return getDb().prepare('SELECT DISTINCT grp FROM machine_status WHERE grp IS NOT NULL ORDER BY grp').all().map((r) => r.grp);
}
