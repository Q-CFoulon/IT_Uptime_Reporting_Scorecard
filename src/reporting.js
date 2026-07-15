import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getDb } from './db.js';
import { buildScorecard } from './aggregate.js';
import { previousPeriod, currentPeriod } from './util/time.js';
import { sendMail } from './smtp.js';
import { fail, warn } from './selfmonitor.js';

let CFG;
export function initReporting(cfg) { CFG = cfg; }

// ---- cron (min hour dom month dow) ----
function fieldMatch(field, val, min, max) {
  if (field === '*') return true;
  for (const part of field.split(',')) {
    const step = part.split('/');
    const range = step[0];
    const s = step[1] ? parseInt(step[1], 10) : 1;
    let lo, hi;
    if (range === '*') { lo = min; hi = max; }
    else if (range.includes('-')) { [lo, hi] = range.split('-').map(Number); }
    else { lo = hi = parseInt(range, 10); }
    for (let v = lo; v <= hi; v += s) if (v === val) return true;
  }
  return false;
}
export function cronMatch(expr, date) {
  const [mi, ho, dom, mo, dow] = expr.trim().split(/\s+/);
  return fieldMatch(mi, date.getMinutes(), 0, 59) && fieldMatch(ho, date.getHours(), 0, 23) &&
    fieldMatch(dom, date.getDate(), 1, 31) && fieldMatch(mo, date.getMonth() + 1, 1, 12) &&
    fieldMatch(dow, date.getDay(), 0, 6);
}

// ---- report generation ----
export function generateReport(period) {
  const sc = buildScorecard(CFG, period);
  return { period, json: sc, html: renderHtml(sc) };
}
function renderHtml(sc) {
  const rag = (v, g, w) => v >= g ? '#1a9e5f' : v >= w ? '#c9820a' : '#cf3838';
  const slaRows = (sc.slas || []).map((s) => `<tr><td>${s.name}</td><td>T${s.tier}</td><td>${s.target}%</td>
    <td style="color:${s.uptimePct == null ? '#888' : s.breached ? '#cf3838' : '#1a9e5f'}">${s.uptimePct == null ? '—' : s.uptimePct + '%'} ${s.breached ? '⚠ BREACH' : ''}</td></tr>`).join('');
  return `<!doctype html><meta charset=utf-8><title>IT Scorecard ${sc.period}</title>
<body style="font-family:Segoe UI,Arial,sans-serif;max-width:820px;margin:24px auto;color:#1a2330">
<h1 style="color:#0a4b78">${sc.org} — IT Uptime &amp; Security Scorecard</h1>
<p>Period <b>${sc.period}</b> · generated ${new Date(sc.generatedAt).toLocaleString()}</p>
<h2>Health Index: <span style="color:${rag(sc.health.index, 90, 75)}">${sc.health.index}</span>/100</h2>
<ul>
<li>System uptime: <b>${sc.uptime.uptimePct}%</b> (${sc.uptime.hrsDown}h down of ${sc.uptime.hrsAvailability}h)</li>
<li>Outage notices: <b>${sc.incidents.total}</b> (T1 ${sc.incidents.tiers[1] || 0} / T2 ${sc.incidents.tiers[2] || 0} / T3 ${sc.incidents.tiers[3] || 0})</li>
<li>Events analyzed: <b>${sc.events.totals.dp.toLocaleString()}</b> · escalations ${sc.events.totals.esc} · interventions ${sc.events.totals.int}</li>
<li>Peak disk: <b>${sc.disks.worst.pct == null ? '—' : sc.disks.worst.pct + '%'}</b> (${sc.disks.worst.name})</li>
<li>Fleet: ${sc.fleet.up}/${sc.fleet.total} up · ${sc.fleet.down} down (${sc.fleet.criticalDown} critical)</li>
</ul>
<h3>SLA attainment</h3><table border=1 cellpadding=6 style="border-collapse:collapse">
<tr><th>SLA</th><th>Tier</th><th>Target</th><th>Actual</th></tr>${slaRows}</table>
</body>`;
}

// ---- delivery ----
export async function deliver(report, targets) {
  const d = CFG.reporting.destinations;
  const results = {};
  if (targets.includes('local') && d.local.enabled) {
    try {
      mkdirSync(d.local.dir, { recursive: true });
      writeFileSync(join(d.local.dir, `scorecard-${report.period}.html`), report.html);
      writeFileSync(join(d.local.dir, `scorecard-${report.period}.json`), JSON.stringify(report.json, null, 2));
      results.local = 'ok';
    } catch (e) { results.local = 'error'; fail('reporting:local', 'write', e.message); }
  }
  if (targets.includes('http') && d.http.enabled && d.http.url) {
    try {
      const res = await fetch(d.http.url, { method: d.http.method || 'PUT',
        headers: { 'Content-Type': 'application/json', ...(process.env.REPORT_HTTP_TOKEN ? { Authorization: `Bearer ${process.env.REPORT_HTTP_TOKEN}` } : {}) },
        body: JSON.stringify(report.json) });
      results.http = res.ok ? 'ok' : `http ${res.status}`;
      if (!res.ok) fail('reporting:http', 'upload', `status ${res.status}`);
    } catch (e) { results.http = 'error'; fail('reporting:http', 'upload', e.message); }
  }
  if (targets.includes('email') && d.email.enabled) {
    try {
      await sendMail({ ...CFG.reporting.smtp }, { from: d.email.from, to: d.email.to,
        subject: `${d.email.subjectPrefix || ''} Scorecard ${report.period}`.trim(),
        text: `Health Index ${report.json.health.index}/100. See attached HTML.`, html: report.html });
      results.email = 'ok';
    } catch (e) { results.email = 'error'; fail('reporting:email', 'send', e.message, { critical: false }); }
  }
  return results;
}

// ---- alerts (deduped) ----
export async function alert(subject, body, key) {
  const d = CFG.reporting.destinations, gap = (CFG.alerts.minMinutesBetweenSame || 60) * 60000;
  const last = getDb().prepare('SELECT MAX(ts) t FROM alerts_sent WHERE key=?').get(key)?.t || 0;
  if (Date.now() - last < gap) return { skipped: 'deduped' };
  getDb().prepare('INSERT INTO alerts_sent(ts,key,detail) VALUES(?,?,?)').run(Date.now(), key, subject);
  if (!d.email.enabled || !CFG.reporting.smtp.host) { warn('alerts', 'no-channel', `alert not delivered (email disabled): ${subject}`); return { logged: true }; }
  try {
    await sendMail({ ...CFG.reporting.smtp }, { from: d.email.from, to: d.email.to,
      subject: `${d.email.subjectPrefix || ''} ${subject}`.trim(), text: body });
    return { ok: true };
  } catch (e) { fail('alerts:email', 'send', e.message); return { error: e.message }; }
}

// ---- scheduler ----
export function startScheduler() {
  const seen = new Set();
  const tick = async () => {
    const now = new Date(Date.now() + CFG.businessHours.timezoneOffsetMinutes * 60000);
    const stamp = `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}-${now.getUTCHours()}-${now.getUTCMinutes()}`;
    for (const sch of CFG.reporting.schedules || []) {
      const local = new Date(now.getTime());
      // cronMatch uses local getters; build a Date in business tz via UTC accessors shim
      const d = { getMinutes: () => local.getUTCMinutes(), getHours: () => local.getUTCHours(),
        getDate: () => local.getUTCDate(), getMonth: () => local.getUTCMonth(), getDay: () => local.getUTCDay() };
      const guard = `${sch.name}@${stamp}`;
      if (cronMatch(sch.cron, d) && !seen.has(guard)) {
        seen.add(guard); if (seen.size > 100) seen.clear();
        const period = sch.period === 'current' ? currentPeriod(CFG.businessHours.timezoneOffsetMinutes) : previousPeriod(CFG.businessHours.timezoneOffsetMinutes);
        try {
          const rep = generateReport(period);
          const res = await deliver(rep, sch.deliver || ['local']);
          getDb().prepare('INSERT INTO report_runs(ts,schedule,period,status,detail) VALUES(?,?,?,?,?)')
            .run(Date.now(), sch.name, period, 'ok', JSON.stringify(res));
          console.log(`[reporting] ran "${sch.name}" for ${period}:`, res);
        } catch (e) {
          getDb().prepare('INSERT INTO report_runs(ts,schedule,period,status,detail) VALUES(?,?,?,?,?)')
            .run(Date.now(), sch.name, period, 'error', e.message);
          fail('reporting:schedule', 'run', e.message);
        }
      }
    }
  };
  setInterval(tick, 60000);
  console.log(`[reporting] scheduler active (${(CFG.reporting.schedules || []).length} schedule(s))`);
}
