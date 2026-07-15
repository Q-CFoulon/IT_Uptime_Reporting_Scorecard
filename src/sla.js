import { getDb } from './db.js';

// Resolve an SLA scope ({groups:[], targets:[]}) to the set of probe-target names.
export function resolveMembers(cfg, sla) {
  const names = new Set(sla.scope?.targets || []);
  const groups = new Set(sla.scope?.groups || []);
  for (const t of cfg.probe.targets) if (groups.has(t.group)) names.add(t.name);
  return [...names];
}

// Uptime for one SLA across its members during business hours in [startMs,endMs).
// The service is "down" in a sample interval if ANY in-scope member was down.
export function computeSlaUptime(cfg, sla, startMs, endMs) {
  const members = resolveMembers(cfg, sla);
  const avail = cfg.businessHours.standardMonthlyHours;
  const intervalHrs = cfg.probe.intervalSec / 3600;
  if (!members.length) return { name: sla.name, tier: sla.tier, target: sla.uptimeTarget, members: 0, uptimePct: null, hrsDown: 0, breached: false };

  const placeholders = members.map(() => '?').join(',');
  const row = getDb().prepare(
    `SELECT COUNT(*) AS n, SUM(CASE WHEN all_up=0 THEN 1 ELSE 0 END) AS down
     FROM (SELECT ts, MIN(up) AS all_up FROM avail_samples
           WHERE target IN (${placeholders}) AND in_hours=1 AND ts>=? AND ts<? GROUP BY ts)`
  ).get(...members, startMs, endMs);

  const hrsDown = (row?.down || 0) * intervalHrs;
  const uptimePct = avail > 0 ? Math.max(0, Math.min(100, (avail - hrsDown) / avail * 100)) : null;
  return {
    name: sla.name, tier: sla.tier, target: sla.uptimeTarget, members: members.length,
    uptimePct: uptimePct == null ? null : +uptimePct.toFixed(3),
    hrsDown: +hrsDown.toFixed(2),
    breached: uptimePct != null && uptimePct < sla.uptimeTarget
  };
}

export function computeAllSlas(cfg, startMs, endMs) {
  return (cfg.slas || []).map((s) => computeSlaUptime(cfg, s, startMs, endMs));
}
