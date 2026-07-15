// Minimal, dependency-free SNMP v2c GET (ASN.1 BER). Enough to read scalar capacity
// OIDs from SANs / hosts. For a full hrStorageTable walk use SNMP tooling upstream;
// here the operator supplies explicit OIDs (see connectors/san.js).
import dgram from 'node:dgram';

// ---- BER encoding ----
function encLength(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  while (n > 0) { bytes.unshift(n & 0xff); n >>= 8; }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
function tlv(tag, content) { return Buffer.concat([Buffer.from([tag]), encLength(content.length), content]); }
function encInt(n) {
  const bytes = [];
  let v = n;
  do { bytes.unshift(v & 0xff); v >>= 8; } while (v !== 0 && v !== -1);
  if (n >= 0 && (bytes[0] & 0x80)) bytes.unshift(0);           // pad positive with high bit
  return tlv(0x02, Buffer.from(bytes));
}
function encOID(oid) {
  const p = oid.replace(/^\./, '').split('.').map(Number);
  const out = [40 * p[0] + p[1]];
  for (let i = 2; i < p.length; i++) {
    let v = p[i]; const stack = [v & 0x7f]; v >>= 7;
    while (v > 0) { stack.unshift((v & 0x7f) | 0x80); v >>= 7; }
    out.push(...stack);
  }
  return tlv(0x06, Buffer.from(out));
}
function encStr(s) { return tlv(0x04, Buffer.from(s, 'utf8')); }
function encNull() { return tlv(0x05, Buffer.alloc(0)); }

function buildGet(community, reqId, oids) {
  const varbinds = oids.map((o) => tlv(0x30, Buffer.concat([encOID(o), encNull()])));
  const vblist = tlv(0x30, Buffer.concat(varbinds));
  const pdu = tlv(0xa0, Buffer.concat([encInt(reqId), encInt(0), encInt(0), vblist])); // GetRequest
  return tlv(0x30, Buffer.concat([encInt(1), encStr(community), pdu]));                 // version 1 = v2c
}

// ---- BER decoding ----
function readTLV(buf, pos) {
  const tag = buf[pos++];
  let len = buf[pos++];
  if (len & 0x80) { const n = len & 0x7f; len = 0; for (let i = 0; i < n; i++) len = (len << 8) | buf[pos++]; }
  return { tag, len, val: buf.subarray(pos, pos + len), next: pos + len };
}
function decodeOID(buf) {
  const first = buf[0];
  const parts = [Math.floor(first / 40), first % 40];
  let v = 0;
  for (let i = 1; i < buf.length; i++) { v = (v << 7) | (buf[i] & 0x7f); if (!(buf[i] & 0x80)) { parts.push(v); v = 0; } }
  return parts.join('.');
}
function decodeInt(buf) { let v = 0; for (const b of buf) v = v * 256 + b; return v; } // unsigned (counters/gauges)

export function parseResponse(buf) {
  const msg = readTLV(buf, 0);              // SEQUENCE
  let p = 0; const body = msg.val;
  const ver = readTLV(body, p); p = ver.next;
  const comm = readTLV(body, p); p = comm.next;
  const pdu = readTLV(body, p);             // response PDU (0xa2)
  let pp = 0; const pb = pdu.val;
  const reqId = readTLV(pb, pp); pp = reqId.next;
  const errStatus = readTLV(pb, pp); pp = errStatus.next;
  const errIndex = readTLV(pb, pp); pp = errIndex.next;
  const vbl = readTLV(pb, pp);
  const varbinds = [];
  let vp = 0;
  while (vp < vbl.val.length) {
    const vb = readTLV(vbl.val, vp); vp = vb.next;
    let q = 0;
    const oidT = readTLV(vb.val, q); q = oidT.next;
    const valT = readTLV(vb.val, q);
    let value;
    if (valT.tag === 0x06) value = decodeOID(valT.val);
    else if (valT.tag === 0x04) value = valT.val.toString('utf8');
    else if ([0x02, 0x41, 0x42, 0x43, 0x46].includes(valT.tag)) value = decodeInt(valT.val);
    else value = null; // noSuchObject/instance/endOfMibView (0x80/0x81/0x82) or unknown
    varbinds.push({ oid: decodeOID(oidT.val), type: valT.tag, value });
  }
  return { reqId: decodeInt(reqId.val), error: decodeInt(errStatus.val), varbinds };
}

export function snmpGet(host, community, oids, { port = 161, timeoutMs = 2000 } = {}) {
  return new Promise((resolve, reject) => {
    const reqId = (Date.now() & 0x7fffffff) ^ (oids.length << 16);
    const sock = dgram.createSocket('udp4');
    const timer = setTimeout(() => { sock.close(); reject(new Error(`SNMP timeout ${host}`)); }, timeoutMs);
    sock.on('message', (buf) => {
      clearTimeout(timer); sock.close();
      try {
        const r = parseResponse(buf);
        if (r.error) return reject(new Error(`SNMP error status ${r.error}`));
        const map = {};
        for (const vb of r.varbinds) map[vb.oid] = vb.value;
        resolve(map);
      } catch (e) { reject(e); }
    });
    sock.on('error', (e) => { clearTimeout(timer); sock.close(); reject(e); });
    const pkt = buildGet(community, reqId, oids);
    sock.send(pkt, port, host);
  });
}

// exported for self-test
export const _internal = { buildGet, parseResponse, encOID, decodeOID: (hex) => decodeOID(Buffer.from(hex, 'hex')) };
