// SAN capacity polling via SNMP (preferred, dependency-free) or vendor REST.
// Per-array SNMP config lives on the sans[] entry in collector.json:
//   "snmpHost": "10.0.5.10",
//   "oids": { "used": "1.3.6.1...", "total": "1.3.6.1..." }
//        OR  { "size": "...hrStorageSize", "used": "...hrStorageUsed", "units": "...hrStorageAllocationUnits" }
// REST arrays use env: SAN_<NAME>_URL / SAN_<NAME>_TOKEN.
import { recordDisk } from '../db.js';
import { snmpGet } from '../ingest/snmp.js';

function envKey(name) { return name.toUpperCase().replace(/[^A-Z0-9]+/g, '_'); }

async function pollSnmp(s, snmpCfg) {
  const host = s.snmpHost;
  const oids = s.oids || {};
  const want = Object.values(oids);
  if (!host || !want.length) return { name: s.name, skipped: 'no snmpHost/oids' };
  const map = await snmpGet(host, snmpCfg.community, want, { timeoutMs: snmpCfg.timeoutMs });
  let used, total;
  if (oids.used && oids.total) { used = map[oids.used.replace(/^\./, '')]; total = map[oids.total.replace(/^\./, '')]; }
  else if (oids.size && oids.used && oids.units) {
    const u = map[oids.units.replace(/^\./, '')] || 1;
    total = (map[oids.size.replace(/^\./, '')] || 0) * u;
    used = (map[oids.used.replace(/^\./, '')] || 0) * u;
  }
  if (total > 0) { recordDisk(Date.now(), s.name, used, total, 'snmp'); return { name: s.name, used, total }; }
  return { name: s.name, skipped: 'no capacity in SNMP response' };
}

async function pollNimbleRest(url, token, name) {
  const res = await fetch(`${url.replace(/\/$/, '')}/v1/arrays/detail`, { headers: { 'X-Auth-Token': token } });
  if (!res.ok) throw new Error(`${name} ${res.status}`);
  const j = await res.json();
  const a = (j.data && j.data[0]) || {};
  const used = a.usage ?? a.used_bytes, total = a.usable_capacity_bytes ?? a.total_bytes;
  if (total > 0) recordDisk(Date.now(), name, used, total, 'rest');
  return { name, used, total };
}

export async function pollSans(cfg) {
  const c = cfg.connectors.snmp;
  const out = [];
  for (const s of cfg.sans) {
    const url = process.env[`SAN_${envKey(s.name)}_URL`];
    const token = process.env[`SAN_${envKey(s.name)}_TOKEN`];
    try {
      if (url && token && s.type === 'nimble') out.push(await pollNimbleRest(url, token, s.name));
      else if (c.enabled && s.snmpHost) out.push(await pollSnmp(s, c));
      else out.push({ name: s.name, skipped: 'no REST creds / SNMP not configured' });
    } catch (e) { out.push({ name: s.name, error: e.message }); }
  }
  const anyOk = out.some((o) => o.used != null);
  return { enabled: c.enabled, results: out, ...(anyOk ? {} : { skipped: 'no arrays returned capacity' }) };
}
