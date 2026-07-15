import dgram from 'node:dgram';
import net from 'node:net';
import { recordEvent, recordDisk } from '../db.js';

let stats = { udp: 0, tcp: 0, parsed: 0, byCategory: {} };
export function syslogStats() { return stats; }

// --- classification ------------------------------------------------------
// Windows Event IDs that matter to the scorecard (forwarded via WEF/NXLog/Winlogbeat).
const WIN_EVENTS = {
  6005: 'boot',                 // Event Log service started (~boot)
  6006: 'shutdown_planned',     // clean shutdown
  6008: 'shutdown_unexpected',  // previous shutdown was unexpected
  6013: 'uptime_heartbeat',     // daily uptime report
  1074: 'shutdown_planned',     // user/process initiated restart
  1076: 'shutdown_unexpected',  // reason for unexpected shutdown
  41:   'shutdown_unexpected',  // Kernel-Power: rebooted without cleanly shutting down
  109:  'shutdown_planned',     // Kernel-Power: kernel initiated shutdown
  2013: 'disk_capacity',        // disk at or near capacity
  4625: 'security',             // failed logon
  4740: 'security',             // account lockout
  4688: 'security'              // process creation
};

const DISK_KEYWORDS = /(capacity|space\s*util|volume\s*usage|disk\s*(is\s*)?(at|near|full)|out\s*of\s*space|pool\s*usage|% ?(used|full))/i;
const REBOOT_KEYWORDS = /\b(reboot|restart|shutting\s*down|system\s*startup|has\s*started|kernel-?power)\b/i;
const LINUX_BOOT = /\b(startup finished|reached target (multi-user|graphical)|kernel: linux version)\b/i;
const LINUX_DOWN = /\b(reached target (shutdown|poweroff|reboot)|systemd-shutdown|entering runlevel 0)\b/i;

// Shared classifier — used by on-wire syslog AND the Azure Monitor connector so both
// paths categorize identically. eventId may be supplied (Windows Event) or extracted.
export function classifyLog(message, source, eventId = null) {
  const msg = message || '';
  if (eventId == null) {
    const idm = msg.match(/\bEvent(?:ID)?\s*[:=]\s*(\d+)/i) || msg.match(/\[(\d{2,5})\]/);
    eventId = idm ? parseInt(idm[1], 10) : null;
  }
  if (eventId != null && WIN_EVENTS[eventId]) return { category: WIN_EVENTS[eventId], eventId };

  if (source === 'nimble' || source === 'msa') {
    if (DISK_KEYWORDS.test(msg)) return { category: 'disk_capacity', eventId };
    return { category: 'san_other', eventId };
  }
  if (DISK_KEYWORDS.test(msg)) return { category: 'disk_capacity', eventId };
  if (LINUX_BOOT.test(msg)) return { category: 'boot', eventId };
  if (LINUX_DOWN.test(msg)) return { category: 'shutdown_planned', eventId };
  if (REBOOT_KEYWORDS.test(msg)) return { category: 'reboot_related', eventId };
  return { category: 'other', eventId };
}
function classify(msg, host, source) { return classifyLog(msg, source, null); }

function sourceForHost(host, cfg) {
  const h = (host || '').toLowerCase();
  for (const s of cfg.sans) if (h.includes(s.name.toLowerCase()) || h.includes(s.type)) return s.type;
  return null;
}

// --- RFC 3164 / 5424 parsing --------------------------------------------
export function parseSyslog(line, cfg) {
  const raw = line.trim();
  if (!raw) return null;
  let facility = null, severity = null, rest = raw;

  const pri = raw.match(/^<(\d{1,3})>/);
  if (pri) {
    const p = parseInt(pri[1], 10);
    facility = p >> 3; severity = p & 7;
    rest = raw.slice(pri[0].length);
  }

  let host = null, message = rest, version5424 = /^\d\s/.test(rest);

  if (version5424) {
    // <PRI>VER TIMESTAMP HOST APP PROCID MSGID SD MSG
    const parts = rest.split(' ');
    host = parts[2] && parts[2] !== '-' ? parts[2] : null;
    const sdEnd = rest.indexOf('] ');
    message = sdEnd > -1 ? rest.slice(sdEnd + 2) : parts.slice(6).join(' ');
  } else {
    // RFC 3164: "Mmm dd hh:mm:ss HOST TAG: MSG"
    const m = rest.match(/^[A-Z][a-z]{2}\s+\d{1,2}\s[\d:]{8}\s+(\S+)\s+(.*)$/);
    if (m) { host = m[1]; message = m[2]; }
  }

  const src = sourceForHost(host, cfg) ||
    (/win|dc\d|srv|desktop/i.test(host || '') ? 'windows' : 'linux');
  const { category, eventId } = classify(message, host, src);

  return {
    ts: Date.now(), host: host || 'unknown', source: src,
    facility, severity, event_id: eventId, category, message, raw
  };
}

// Try to pull a used/total figure out of a SAN capacity message, e.g.
// "space utilization 78% (16.2TB of 20.8TB)".
function tryDiskFromMessage(ev) {
  const m = ev.message.match(/([\d.]+)\s*TB[^0-9]+([\d.]+)\s*TB/i);
  if (m) {
    const used = parseFloat(m[1]) * 1e12, total = parseFloat(m[2]) * 1e12;
    if (total > 0) recordDisk(ev.ts, ev.host, used, total);
  }
}

function handle(line, cfg) {
  const ev = parseSyslog(line, cfg);
  if (!ev) return;
  recordEvent(ev);
  stats.parsed++;
  stats.byCategory[ev.category] = (stats.byCategory[ev.category] || 0) + 1;
  if (ev.category === 'disk_capacity') tryDiskFromMessage(ev);
}

export function startSyslog(cfg) {
  if (!cfg.syslog.enabled) { console.log('[syslog] disabled'); return; }
  const { udpPort, tcpPort, bind } = cfg.syslog;

  const udp = dgram.createSocket('udp4');
  udp.on('message', (buf) => { stats.udp++; handle(buf.toString('utf8'), cfg); });
  udp.on('error', (e) => console.error('[syslog udp]', e.message));
  udp.bind(udpPort, bind, () => console.log(`[syslog] UDP listening on ${bind}:${udpPort}`));

  const tcp = net.createServer((sock) => {
    let acc = '';
    sock.on('data', (d) => {
      acc += d.toString('utf8');
      let i;
      while ((i = acc.indexOf('\n')) > -1) { stats.tcp++; handle(acc.slice(0, i), cfg); acc = acc.slice(i + 1); }
    });
    sock.on('error', () => {});
  });
  tcp.on('error', (e) => console.error('[syslog tcp]', e.message));
  tcp.listen(tcpPort, bind, () => console.log(`[syslog] TCP listening on ${bind}:${tcpPort}`));

  return { udp, tcp };
}
