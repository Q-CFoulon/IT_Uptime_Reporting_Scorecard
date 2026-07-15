// Minimal, dependency-free SMTP client. Supports plain relay, STARTTLS, implicit TLS,
// and AUTH LOGIN. Intended for internal relays and authenticated smart hosts.
import net from 'node:net';
import tls from 'node:tls';

function reader(sock) {
  let buf = '';
  const waiters = [];
  sock.on('data', (d) => {
    buf += d.toString('utf8');
    let idx;
    // A complete reply ends with a line "NNN <sp> ..." (space, not hyphen).
    while ((idx = buf.indexOf('\r\n')) > -1) {
      // Accumulate full multiline reply before resolving.
      const lines = buf.split('\r\n');
      const complete = [];
      let done = false, consumed = 0;
      for (const ln of lines) {
        if (ln === '') break;
        complete.push(ln); consumed += ln.length + 2;
        if (/^\d{3} /.test(ln)) { done = true; break; }
      }
      if (!done) return;
      buf = buf.slice(consumed);
      const code = parseInt(complete[complete.length - 1].slice(0, 3), 10);
      const w = waiters.shift();
      if (w) w({ code, text: complete.join('\n') });
      return;
    }
  });
  return { expect: () => new Promise((res) => waiters.push(res)) };
}

async function cmd(sock, rd, line, okCodes) {
  if (line != null) sock.write(line + '\r\n');
  const r = await rd.expect();
  if (okCodes && !okCodes.includes(r.code)) throw new Error(`SMTP: expected ${okCodes} got ${r.code} — ${r.text}`);
  return r;
}

export async function sendMail(smtp, { from, to, subject, text, html }) {
  const port = smtp.port || (smtp.secure === 'tls' ? 465 : 25);
  const recipients = Array.isArray(to) ? to : [to];

  let sock = smtp.secure === 'tls'
    ? tls.connect({ host: smtp.host, port, servername: smtp.host })
    : net.connect({ host: smtp.host, port });
  sock.setEncoding('utf8');
  await new Promise((res, rej) => { sock.once(smtp.secure === 'tls' ? 'secureConnect' : 'connect', res); sock.once('error', rej); });

  let rd = reader(sock);
  await cmd(sock, rd, null, [220]);
  await cmd(sock, rd, `EHLO scorecard`, [250]);

  if (smtp.secure === 'starttls') {
    await cmd(sock, rd, 'STARTTLS', [220]);
    sock = tls.connect({ socket: sock, servername: smtp.host });
    sock.setEncoding('utf8');
    await new Promise((res, rej) => { sock.once('secureConnect', res); sock.once('error', rej); });
    rd = reader(sock);
    await cmd(sock, rd, `EHLO scorecard`, [250]);
  }

  if (smtp.authUser && smtp.password) {
    await cmd(sock, rd, 'AUTH LOGIN', [334]);
    await cmd(sock, rd, Buffer.from(smtp.authUser).toString('base64'), [334]);
    await cmd(sock, rd, Buffer.from(smtp.password).toString('base64'), [235]);
  }

  await cmd(sock, rd, `MAIL FROM:<${from}>`, [250]);
  for (const r of recipients) await cmd(sock, rd, `RCPT TO:<${r}>`, [250, 251]);
  await cmd(sock, rd, 'DATA', [354]);

  const boundary = 'b_' + Math.abs(subject.length * 2654435761 % 1e9).toString(36);
  const headers = [
    `From: ${from}`, `To: ${recipients.join(', ')}`, `Subject: ${subject}`,
    'MIME-Version: 1.0'
  ];
  let body;
  if (html) {
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    body = `--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text || ''}\r\n` +
           `--${boundary}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${html}\r\n--${boundary}--`;
  } else {
    headers.push('Content-Type: text/plain; charset=utf-8');
    body = text || '';
  }
  const msg = headers.join('\r\n') + '\r\n\r\n' + body.replace(/\r?\n\./g, '\n..'); // dot-stuffing
  await cmd(sock, rd, msg + '\r\n.', [250]);
  await cmd(sock, rd, 'QUIT');
  sock.end();
  return { ok: true, recipients };
}
