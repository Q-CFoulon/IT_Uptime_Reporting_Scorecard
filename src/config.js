import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, isAbsolute } from 'node:path';
import { getSecret } from './secrets.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

function envInt(name, fallback) {
  const v = process.env[name];
  const n = v === undefined ? NaN : parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig() {
  const path = process.env.CONFIG_PATH || join(ROOT, 'config', 'collector.json');
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    console.error(`[config] could not read ${path}: ${e.message}`);
    process.exit(1);
  }

  cfg.http.port = envInt('HTTP_PORT', cfg.http.port);
  cfg.syslog.udpPort = envInt('SYSLOG_UDP_PORT', cfg.syslog.udpPort);
  cfg.syslog.tcpPort = envInt('SYSLOG_TCP_PORT', cfg.syslog.tcpPort);
  if (process.env.SYSLOG_ENABLED !== undefined) cfg.syslog.enabled = process.env.SYSLOG_ENABLED === 'true';
  if (process.env.DB_PATH) cfg.database.path = process.env.DB_PATH;
  if (process.env.AUTH_ENABLED !== undefined) cfg.auth.enabled = process.env.AUTH_ENABLED === 'true';

  const abs = (p) => (isAbsolute(p) ? p : join(ROOT, p));
  cfg.database.path = abs(cfg.database.path);
  if (cfg.reporting?.destinations?.local?.dir) cfg.reporting.destinations.local.dir = abs(cfg.reporting.destinations.local.dir);

  // Credentials: env first, then the wizard-managed secrets store. Never the JSON config file.
  const c = cfg.connectors;
  c.defender.creds = {
    tenantId: process.env.GRAPH_TENANT_ID || getSecret('defender.tenantId') || '',
    clientId: process.env.GRAPH_CLIENT_ID || getSecret('defender.clientId') || '',
    clientSecret: process.env.GRAPH_CLIENT_SECRET || getSecret('defender.clientSecret') || ''
  };
  if (process.env.CONNECTOR_DEFENDER_ENABLED !== undefined) c.defender.enabled = process.env.CONNECTOR_DEFENDER_ENABLED === 'true';
  else if (getSecret('defender.enabled') != null) c.defender.enabled = !!getSecret('defender.enabled');

  c.perch.creds = {
    base: process.env.PERCH_API_BASE || getSecret('perch.base') || '',
    token: process.env.PERCH_API_TOKEN || getSecret('perch.token') || ''
  };
  if (process.env.CONNECTOR_PERCH_ENABLED !== undefined) c.perch.enabled = process.env.CONNECTOR_PERCH_ENABLED === 'true';

  const az = c.azureMonitor;
  az.creds = {
    tenantId: process.env.AZURE_TENANT_ID || getSecret('azureMonitor.tenantId') || c.defender.creds.tenantId || '',
    clientId: process.env.AZURE_CLIENT_ID || getSecret('azureMonitor.clientId') || '',
    clientSecret: process.env.AZURE_CLIENT_SECRET || getSecret('azureMonitor.clientSecret') || ''
  };
  if (process.env.AZURE_WORKSPACE_ID) az.workspaceId = process.env.AZURE_WORKSPACE_ID;
  else if (getSecret('azureMonitor.workspaceId')) az.workspaceId = getSecret('azureMonitor.workspaceId');
  if (process.env.CONNECTOR_AZUREMONITOR_ENABLED !== undefined) az.enabled = process.env.CONNECTOR_AZUREMONITOR_ENABLED === 'true';
  else if (getSecret('azureMonitor.enabled') != null) az.enabled = !!getSecret('azureMonitor.enabled');

  cfg.reporting.smtp.password = process.env.SMTP_PASSWORD || getSecret('smtp.password') || '';

  cfg.root = ROOT;
  return cfg;
}
