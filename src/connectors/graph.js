// Microsoft Defender event metrics via the Microsoft Graph Security API.
// Maps to the scorecard "Microsoft Defender" source:
//   Data Points   = incidents with status New/InProgress/Resolved, severity Low/Med/High
//   Escalations   = incidents with severity Medium/High
//   Interventions = incidents/alerts classified truePositive
// Requires an Entra app registration with SecurityIncident.Read.All (application).
import { upsertEventMetric } from '../db.js';
import { currentPeriod } from '../util/time.js';

async function getToken(creds) {
  const url = `https://login.microsoftonline.com/${creds.tenantId}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials'
  });
  const res = await fetch(url, { method: 'POST', body });
  if (!res.ok) throw new Error(`token ${res.status}: ${await res.text()}`);
  return (await res.json()).access_token;
}

async function countIncidents(token, filter) {
  let url = `https://graph.microsoft.com/v1.0/security/incidents?$filter=${encodeURIComponent(filter)}&$top=100&$count=true`;
  let total = 0;
  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, ConsistencyLevel: 'eventual' } });
    if (!res.ok) throw new Error(`incidents ${res.status}: ${await res.text()}`);
    const j = await res.json();
    total += (j.value || []).length;
    url = j['@odata.nextLink'] || null;
  }
  return total;
}

// Live connection test for the onboarding wizard: token + a 1-row incidents probe.
export async function testDefender(creds) {
  if (!creds.tenantId || !creds.clientId || !creds.clientSecret)
    return { ok: false, error: 'tenantId, clientId and clientSecret are all required' };
  try {
    const token = await getToken(creds);
    const res = await fetch('https://graph.microsoft.com/v1.0/security/incidents?$top=1', {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) return { ok: false, error: `Graph returned ${res.status}: ${(await res.text()).slice(0, 200)}` };
    return { ok: true, message: 'Token acquired and Security API reachable.' };
  } catch (e) { return { ok: false, error: e.message }; }
}

export async function pollDefender(cfg) {
  const c = cfg.connectors.defender;
  if (!c.enabled) return { skipped: 'disabled' };
  if (!c.creds.tenantId || !c.creds.clientId || !c.creds.clientSecret)
    return { skipped: 'missing GRAPH_* credentials' };

  const period = currentPeriod(cfg.businessHours.timezoneOffsetMinutes);
  const [y, m] = period.split('-').map(Number);
  const from = new Date(Date.UTC(y, m - 1, 1)).toISOString();
  const base = `createdDateTime ge ${from}`;

  const token = await getToken(c.creds);
  const dataPoints = await countIncidents(token,
    `${base} and (status eq 'active' or status eq 'inProgress' or status eq 'resolved')`);
  const escalations = await countIncidents(token,
    `${base} and (severity eq 'medium' or severity eq 'high')`);
  const interventions = await countIncidents(token,
    `${base} and classification eq 'truePositive'`);

  upsertEventMetric(period, 'defender', dataPoints, escalations, interventions, 'defender-api');
  return { period, dataPoints, escalations, interventions };
}
