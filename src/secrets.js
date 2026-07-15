// Runtime secret store, kept OUT of the version-controlled config file.
// Written by the onboarding wizard; also readable by loadConfig(). Prefer env vars
// in production — anything set in the environment overrides this file.
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = process.env.SECRETS_PATH || join(ROOT, 'data', 'secrets.json');

let cache = null;
function loadAll() {
  if (cache) return cache;
  try { cache = JSON.parse(readFileSync(FILE, 'utf8')); }
  catch { cache = {}; }
  return cache;
}

// dot-path getter, e.g. getSecret('defender.tenantId')
export function getSecret(path) {
  const parts = path.split('.');
  let o = loadAll();
  for (const p of parts) { if (o == null) return undefined; o = o[p]; }
  return o;
}

export function setSecrets(patch) {
  const all = loadAll();
  for (const [k, v] of Object.entries(patch)) {
    const parts = k.split('.');
    let o = all;
    for (let i = 0; i < parts.length - 1; i++) o = (o[parts[i]] ??= {});
    o[parts[parts.length - 1]] = v;
  }
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(all, null, 2));
  try { chmodSync(FILE, 0o600); } catch {}
  cache = all;
}

export function secretsFile() { return FILE; }
