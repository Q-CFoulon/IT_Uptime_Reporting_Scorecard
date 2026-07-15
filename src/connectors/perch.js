// Perch / ConnectWise SIEM event metrics for the scorecard "Intrusion Detection System" source:
//   Data Points   = Analyzed Logs (SOC activity)
//   Escalations   = Escalated Alerts
//   Interventions = escalations promoted to an incident
// Perch's public API surface varies by tenant/reseller, so the response mapping below is
// intentionally defensive. Set PERCH_API_BASE + PERCH_API_TOKEN and adjust the field names
// to match your tenant's report payload.
import { upsertEventMetric } from '../db.js';
import { previousPeriod } from '../util/time.js';

export async function pollPerch(cfg) {
  const c = cfg.connectors.perch;
  if (!c.enabled) return { skipped: 'disabled' };
  if (!c.creds.base || !c.creds.token) return { skipped: 'missing PERCH_API_* credentials' };

  // "Last Month" range, matching the Hero dashboard convention in the runbook.
  const period = previousPeriod(cfg.businessHours.timezoneOffsetMinutes);
  const url = `${c.creds.base.replace(/\/$/, '')}/reports/soc-activity?range=last_month`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${c.creds.token}` } });
  if (!res.ok) throw new Error(`perch ${res.status}: ${await res.text()}`);
  const j = await res.json();

  const dataPoints = j.analyzed_logs ?? j.analyzedLogs ?? 0;
  const escalations = j.escalated_alerts ?? j.escalatedAlerts ?? 0;
  const interventions = j.incidents ?? j.interventions ?? 0;

  upsertEventMetric(period, 'ids', dataPoints, escalations, interventions, 'perch-api');
  return { period, dataPoints, escalations, interventions };
}
