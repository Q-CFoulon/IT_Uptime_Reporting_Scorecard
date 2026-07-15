// Persisted custom dashboards. A dashboard is a named list of widgets; each widget
// references a data key (built-in KPI or a customMetric id) and a render type.
import { getDb } from './db.js';
import { randomUUID } from 'node:crypto';

export function listDashboards() {
  return getDb().prepare('SELECT id,name,layout,updated FROM dashboards ORDER BY name').all()
    .map((r) => ({ id: r.id, name: r.name, updated: r.updated, widgets: JSON.parse(r.layout || '[]') }));
}
export function getDashboard(id) {
  const r = getDb().prepare('SELECT id,name,layout,updated FROM dashboards WHERE id=?').get(id);
  return r ? { id: r.id, name: r.name, updated: r.updated, widgets: JSON.parse(r.layout || '[]') } : null;
}
export function saveDashboard({ id, name, widgets }) {
  id = id || randomUUID();
  getDb().prepare(`INSERT INTO dashboards(id,name,layout,updated) VALUES(?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET name=excluded.name, layout=excluded.layout, updated=excluded.updated`)
    .run(id, name || 'Untitled', JSON.stringify(widgets || []), Date.now());
  return getDashboard(id);
}
export function deleteDashboard(id) { getDb().prepare('DELETE FROM dashboards WHERE id=?').run(id); }

// Widget catalog advertised to the builder UI.
export const WIDGET_CATALOG = [
  { key: 'health.index', label: 'Health Index', type: 'gauge' },
  { key: 'uptime.uptimePct', label: 'System Uptime %', type: 'stat' },
  { key: 'incidents.total', label: 'Outage Notices', type: 'stat' },
  { key: 'events.totals.dp', label: 'Events Analyzed', type: 'stat' },
  { key: 'events.totals.int', label: 'Interventions', type: 'stat' },
  { key: 'disks.worst.pct', label: 'Peak Disk %', type: 'stat' },
  { key: 'fleet.down', label: 'Machines Down', type: 'stat' },
  { key: 'sla', label: 'SLA Attainment', type: 'table' },
  { key: 'custom', label: 'Custom Metric', type: 'stat' }
];
