// Azure Monitor / Log Analytics ingestion. Pulls machine data collected by the Azure
// Monitor Agent (AMA) from a Log Analytics workspace via the query API (KQL):
//   Heartbeat -> machine_status (fleet availability for cloud/Arc hosts we can't TCP-probe)
//   Event     -> events table  (Windows Event Log, classified by EventID)
//   Syslog    -> events table  (Linux syslog, classified by message)
// Auth: Entra app (client credentials) with "Log Analytics Reader" on the workspace.
// Scope: https://api.loganalytics.io/.default
import { recordEvent, upsertMachine } from '../db.js';
import { classifyLog } from '../ingest/syslog.js';

const state = { lastPoll: 0 };

async function getToken(creds) {
  const url = `https://login.microsoftonline.com/${creds.tenantId}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: creds.clientId, client_secret: creds.clientSecret,
    scope: 'https://api.loganalytics.io/.default', grant_type: 'client_credentials'
  });
  const res = await fetch(url, { method: 'POST', body });
  if (!res.ok) throw new Error(`token ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).access_token;
}

async function query(token, workspaceId, kql, timespan) {
  const res = await fetch(`https://api.loganalytics.io/v1/workspaces/${workspaceId}/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: kql, timespan })
  });
  if (!res.ok) throw new Error(`query ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  const t = (j.tables || [])[0];
  if (!t) return [];
  const idx = {}; t.columns.forEach((c, i) => { idx[c.name] = i; });
  return t.rows.map((r) => { const o = {}; for (const c in idx) o[c] = r[idx[c]]; return o; });
}

// Live test for the wizard.
export async function testAzureMonitor(creds, workspaceId) {
  if (!creds.tenantId || !creds.clientId || !creds.clientSecret || !workspaceId)
    return { ok: false, error: 'tenantId, clientId, clientSecret and workspaceId are all required' };
  try {
    const token = await getToken(creds);
    const rows = await query(token, workspaceId, 'Heartbeat | summarize n=count(), machines=dcount(Computer)', 'P1D');
    const r = rows[0] || {};
    return { ok: true, message: `Workspace reachable — ${r.machines ?? 0} machines heartbeating (last 24h).` };
  } catch (e) { return { ok: false, error: e.message }; }
}

export async function pollAzureMonitor(cfg) {
  const c = cfg.connectors.azureMonitor;
  if (!c.enabled) return { skipped: 'disabled' };
  if (!c.creds.tenantId || !c.creds.clientId || !c.creds.clientSecret || !c.workspaceId)
    return { skipped: 'missing AZURE_* credentials or workspaceId' };

  const now = Date.now();
  const startMs = state.lastPoll || (now - (c.initialLookbackMin || 60) * 60000);
  const timespan = `${new Date(startMs).toISOString()}/${new Date(now).toISOString()}`;
  const token = await getToken(c.creds);
  const tables = c.tables || ['Heartbeat', 'Event', 'Syslog'];
  const out = { window: timespan, heartbeat: 0, events: 0 };

  // --- Heartbeat -> machine_status ---
  if (tables.includes('Heartbeat')) {
    const rows = await query(token, c.workspaceId,
      'Heartbeat | summarize LastSeen=max(TimeGenerated), OSType=take_any(OSType) by Computer', timespan);
    const downMs = (c.heartbeatDownAfterMin || 15) * 60000;
    for (const r of rows) {
      const last = Date.parse(r.LastSeen);
      const up = (now - last) < downMs ? 1 : 0;
      upsertMachine({ name: r.Computer, host: r.Computer, port: 0, grp: c.group || 'Azure Monitor',
        critical: 0, os: (r.OSType || '').toLowerCase(), up, latency: null,
        fails: up ? 0 : 1, lastChange: last, lastSeen: last, sinceUp: up ? last : null });
      out.heartbeat++;
    }
  }

  // --- Windows Event -> events ---
  if (tables.includes('Event')) {
    const rows = await query(token, c.workspaceId,
      'Event | project TimeGenerated, Computer, EventID, EventLog, RenderedDescription | order by TimeGenerated asc | take 5000', timespan);
    for (const r of rows) {
      const msg = r.RenderedDescription || `${r.EventLog} event ${r.EventID}`;
      const { category } = classifyLog(msg, 'azure-windows', r.EventID);
      recordEvent({ ts: Date.parse(r.TimeGenerated) || now, host: r.Computer, source: 'azure-windows',
        facility: null, severity: null, event_id: r.EventID ?? null, category, message: msg.slice(0, 1000), raw: 'azure-monitor:Event' });
      out.events++;
    }
  }

  // --- Linux Syslog -> events ---
  if (tables.includes('Syslog')) {
    const rows = await query(token, c.workspaceId,
      'Syslog | project TimeGenerated, Computer, Facility, SeverityLevel, SyslogMessage | order by TimeGenerated asc | take 5000', timespan);
    for (const r of rows) {
      const { category } = classifyLog(r.SyslogMessage || '', 'azure-linux', null);
      recordEvent({ ts: Date.parse(r.TimeGenerated) || now, host: r.Computer, source: 'azure-linux',
        facility: null, severity: null, event_id: null, category, message: (r.SyslogMessage || '').slice(0, 1000), raw: 'azure-monitor:Syslog' });
      out.events++;
    }
  }

  state.lastPoll = now;
  return out;
}

// exported for tests
export const _internal = { mapRows: (table) => {
  const idx = {}; table.columns.forEach((c, i) => { idx[c.name] = i; });
  return table.rows.map((r) => { const o = {}; for (const c in idx) o[c] = r[idx[c]]; return o; });
} };
