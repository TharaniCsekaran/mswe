/**
 * Shared helpers for the MSWE serverless functions: settings, input cleaning,
 * a minimal SMTP client (GoDaddy / Titan, no npm packages), email building and
 * JSON responses.
 *
 * Files in api/_lib are NOT deployed as their own endpoints by Vercel
 * (folders starting with "_" are ignored); the functions require() them.
 */

'use strict';

const net = require('net');
const tls = require('tls');
const crypto = require('crypto');

const SMTP_TIMEOUT_MS = 15e3;

/* ------------------------------------------------------------------ */
/* config                                                              */
/* ------------------------------------------------------------------ */

function getConfig(env = process.env) {
  const origins = (env.ALLOWED_ORIGINS || 'https://mswe.in,https://www.mswe.in')
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  // Vercel's own deployment URLs (preview + production) are always allowed
  for (const host of [env.VERCEL_URL, env.VERCEL_BRANCH_URL, env.VERCEL_PROJECT_PRODUCTION_URL]) {
    if (host) origins.push(`https://${host}`);
  }
  return {
    host: env.SMTP_HOST || 'smtpout.secureserver.net', // GoDaddy's SMTP for Titan mailboxes (mswe.in MX is secureserver.net)
    port: Number(env.SMTP_PORT || 465),
    secure: (env.SMTP_SECURE || 'ssl').toLowerCase(), // 'ssl' (465) | 'tls' (587 STARTTLS) | 'none' (local tests only)
    user: (env.SMTP_USER || 'info@mswe.in').trim(),
    // strip a trailing newline that pasting into the Vercel dashboard can add
    pass: (env.SMTP_PASS || '').replace(/[\r\n]+$/, ''),
    to: env.MAIL_TO || 'info@mswe.in',
    from: env.MAIL_FROM || env.SMTP_USER || 'info@mswe.in', // Titan only sends as the logged-in mailbox
    fromName: env.MAIL_FROM_NAME || 'MSWE Website',
    // public address of the site, used for links inside emails
    siteUrl: (env.SITE_URL || 'https://www.mswe.in').replace(/\/+$/, ''),
    origins,
  };
}

/* ------------------------------------------------------------------ */
/* input cleaning                                                      */
/* ------------------------------------------------------------------ */

/** One line: removes control characters (prevents email header injection), trims, caps length. */
function cleanLine(v, max) {
  return (typeof v === 'string' ? v : '').replace(/[\x00-\x1F\x7F]+/g, ' ').trim().slice(0, max);
}

/** Multi-line text: keeps line breaks, removes other control characters. */
function cleanText(v, max) {
  return (typeof v === 'string' ? v : '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0B-\x1F\x7F]+/g, '')
    .trim()
    .slice(0, max);
}

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

/* ------------------------------------------------------------------ */
/* rate limit (in-memory: per warm serverless instance, best effort)   */
/* ------------------------------------------------------------------ */

function makeRateLimiter(max, windowMs) {
  const hits = new Map();
  function limited(key, now = Date.now()) {
    const recent = (hits.get(key) || []).filter((t) => t > now - windowMs);
    if (recent.length >= max) {
      hits.set(key, recent);
      return true;
    }
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 5000) hits.clear(); // keep memory bounded
    return false;
  }
  limited.hits = hits;
  return limited;
}

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
}

/** Origin of the request without a trailing slash ('' when the browser sent none). */
function requestOrigin(req) {
  return String(req.headers.origin || '').replace(/\/+$/, '');
}

/* ------------------------------------------------------------------ */
/* email building                                                      */
/* ------------------------------------------------------------------ */

const NON_ASCII = /[^\x20-\x7E]/;
const encodeWord = (s) => (NON_ASCII.test(s) ? `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=` : s);
/** Display name for From/Reply-To: encoded if non-ASCII, quoted if it has special characters. */
function displayName(s) {
  if (NON_ASCII.test(s)) return encodeWord(s);
  if (/[()<>[\]:;@\\,."]/.test(s)) return `"${s.replace(/(["\\])/g, '\\$1')}"`;
  return s;
}
// base64 in 76-char lines: no line can start with "." so no SMTP dot-stuffing is needed
const b64Lines = (s) => (Buffer.isBuffer(s) ? s : Buffer.from(s, 'utf8')).toString('base64').match(/.{1,76}/g).join('\r\n');

/** Attachment file names: plain ASCII only, so every mail program shows them correctly. */
const safeFilename = (n) => (String(n || 'file').normalize('NFKD').replace(/[^A-Za-z0-9._ -]+/g, '_').replace(/^[._ ]+/, '').slice(-100) || 'file');

/**
 * Builds a complete email (headers + body).
 *   { fromName, from, to, subject, text, html?, replyTo?, headers?: {Name: value},
 *     attachments?: [{ filename, contentType, content: Buffer }] }
 * text only -> text/plain; with html -> multipart/alternative; with attachments ->
 * multipart/mixed around either of those.
 */
function buildEmail(m) {
  const headers = [
    `Date: ${new Date().toUTCString()}`,
    `From: ${displayName(m.fromName)} <${m.from}>`,
    `To: <${m.to}>`,
  ];
  if (m.replyTo) headers.push(`Reply-To: ${m.replyTo}`);
  headers.push(
    `Subject: ${encodeWord(m.subject)}`,
    `Message-ID: <${crypto.randomBytes(12).toString('hex')}@mswe.in>`,
    'MIME-Version: 1.0',
  );
  for (const [k, v] of Object.entries(m.headers || {})) headers.push(`${k}: ${cleanLine(v, 900)}`);

  const newBoundary = () => `=_mswe_${crypto.randomBytes(10).toString('hex')}`;
  const textPart = (type, body) => ({
    head: [`Content-Type: ${type}; charset=UTF-8`, 'Content-Transfer-Encoding: base64'],
    body: b64Lines(body),
  });
  const multipart = (subtype, parts) => {
    const boundary = newBoundary();
    return {
      head: [`Content-Type: multipart/${subtype}; boundary="${boundary}"`],
      body: [
        ...parts.map((p) => `--${boundary}\r\n${p.head.join('\r\n')}\r\n\r\n${p.body}`),
        `--${boundary}--`,
      ].join('\r\n'),
    };
  };

  let main = m.html
    ? multipart('alternative', [textPart('text/plain', m.text), textPart('text/html', m.html)])
    : textPart('text/plain', m.text);
  if (m.attachments && m.attachments.length) {
    main = multipart('mixed', [main, ...m.attachments.map((a) => {
      const name = safeFilename(a.filename);
      return {
        head: [
          `Content-Type: ${a.contentType || 'application/octet-stream'}; name="${name}"`,
          `Content-Disposition: attachment; filename="${name}"`,
          'Content-Transfer-Encoding: base64',
        ],
        body: b64Lines(a.content),
      };
    })]);
  }
  return `${headers.join('\r\n')}\r\n${main.head.join('\r\n')}\r\n\r\n${main.body}`;
}

/* ------------------------------------------------------------------ */
/* minimal SMTP client                                                 */
/* ------------------------------------------------------------------ */

/**
 * Connects and logs in. Resolves to a session that can send several emails over
 * one connection: `await s.sendMail(from, to, raw)` ... `s.quit()`.
 * Errors carry `.stage` (the SMTP step) and, when the server answered, `.reply`.
 */
function openSmtp(cfg) {
  return new Promise((resolve, reject) => {
    let socket;
    let buffer = '';
    let waiter = null;
    let failed = null;
    let closing = false;
    let stage = 'connect';

    const fail = (err) => {
      if (failed || closing) return;
      if (!err.stage) err.stage = stage;
      failed = err;
      clearTimeout(connectTimer);
      if (waiter) {
        const w = waiter;
        waiter = null;
        w.reject(err);
      }
      if (socket) socket.destroy();
      reject(err); // no effect once the session was handed out
    };
    const connectTimer = setTimeout(() => fail(new Error('SMTP timeout')), SMTP_TIMEOUT_MS);

    // a reply is complete when a line has "NNN " (space after the 3-digit code)
    const tryReply = () => {
      if (!waiter) return;
      const lines = buffer.split('\r\n');
      for (let i = 0; i < lines.length - 1; i++) {
        if (/^\d{3} /.test(lines[i]) || /^\d{3}$/.test(lines[i])) {
          const text = lines.slice(0, i + 1).join('\n');
          buffer = lines.slice(i + 1).join('\r\n');
          const w = waiter;
          waiter = null;
          w.resolve({ code: Number(text.slice(0, 3)), text });
          return;
        }
      }
    };
    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      tryReply();
    };
    const read = () => new Promise((res, rej) => {
      if (failed) return rej(failed);
      const t = setTimeout(() => fail(new Error('SMTP timeout')), SMTP_TIMEOUT_MS);
      waiter = {
        resolve: (r) => { clearTimeout(t); res(r); },
        reject: (e) => { clearTimeout(t); rej(e); },
      };
      tryReply();
    });
    const attach = (s) => {
      socket = s;
      s.on('data', onData);
      s.on('error', (e) => fail(new Error(`SMTP connection error: ${e.message}`)));
      s.on('close', () => fail(new Error('SMTP connection closed unexpectedly')));
    };
    // label is used in errors instead of the command (never log the password)
    const cmd = async (line, expect, label) => {
      stage = label;
      if (failed) throw failed;
      if (line !== null) socket.write(`${line}\r\n`);
      const r = await read();
      if (!expect.includes(r.code)) {
        const e = new Error(`SMTP ${label} failed: ${r.text}`);
        e.stage = label;
        e.reply = r.text; // the mail server's own words, e.g. "535 5.7.8 Authentication failed"
        e.smtpCode = r.code;
        throw e;
      }
      return r;
    };

    const session = {
      /** Sends one email. A refused recipient throws but leaves the session usable. */
      async sendMail(from, to, raw) {
        await cmd(`MAIL FROM:<${from}>`, [250], 'MAIL FROM');
        try {
          await cmd(`RCPT TO:<${to}>`, [250, 251], 'RCPT TO');
        } catch (e) {
          if (!failed) await cmd('RSET', [250], 'RSET').catch(() => {});
          throw e;
        }
        await cmd('DATA', [354], 'DATA');
        await cmd(`${raw}\r\n.`, [250], 'message body');
      },
      get broken() { return Boolean(failed); },
      quit() {
        if (failed || closing || !socket) return;
        closing = true;
        socket.end('QUIT\r\n'); // polite close; the reply is not needed
      },
    };

    const login = async () => {
      clearTimeout(connectTimer);
      await cmd(null, [220], 'greeting');
      await cmd('EHLO mswe.in', [250], 'EHLO');
      if (cfg.secure === 'tls') {
        await cmd('STARTTLS', [220], 'STARTTLS');
        const plain = socket;
        plain.removeListener('data', onData);
        await new Promise((res, rej) => {
          const secured = tls.connect({ socket: plain, servername: cfg.host, minVersion: 'TLSv1.2' }, res);
          secured.once('error', rej);
          attach(secured);
        });
        await cmd('EHLO mswe.in', [250], 'EHLO');
      }
      await cmd('AUTH LOGIN', [334], 'AUTH');
      await cmd(Buffer.from(cfg.user).toString('base64'), [334], 'AUTH user');
      await cmd(Buffer.from(cfg.pass).toString('base64'), [235], 'AUTH password');
      resolve(session);
    };
    const onConnect = () => {
      stage = 'greeting';
      login().catch(fail);
    };
    if (cfg.secure === 'ssl') {
      attach(tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host, minVersion: 'TLSv1.2' }, onConnect));
    } else {
      attach(net.connect({ host: cfg.host, port: cfg.port }, onConnect));
    }
  });
}

/** Sends one email to cfg.to (the MSWE inbox) over a fresh connection. */
async function smtpSend(cfg, raw, to = cfg.to) {
  const s = await openSmtp(cfg);
  try {
    await s.sendMail(cfg.from, to, raw);
  } finally {
    s.quit();
  }
}

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                        */
/* ------------------------------------------------------------------ */

function send(res, status, message, code, debug, extra) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const body = { message, ...(extra || {}) };
  if (code) body.code = code;
  if (debug) body.debug = debug;
  res.end(JSON.stringify(body));
}

async function readBody(req, maxBytes = 20000) {
  if (req.body && typeof req.body === 'object') return req.body; // Vercel already parsed JSON
  if (typeof req.body === 'string') return JSON.parse(req.body);
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > maxBytes) throw new Error('too large');
  }
  return JSON.parse(raw || 'null');
}

/* ------------------------------------------------------------------ */
/* failure reporting (non-secret)                                      */
/* ------------------------------------------------------------------ */

/**
 * Common copy-paste mistakes in the saved password. Reports only which mistake
 * it looks like, never the password, its length or any of its characters.
 */
function passwordWarnings(pass) {
  const w = [];
  if (/^\s|\s$/.test(pass)) w.push('starts or ends with a space');
  if (/^(["'`]).*\1$/s.test(pass)) w.push('is wrapped in quotes');
  if (/^\s*SMTP_PASS\s*=/.test(pass)) w.push('includes "SMTP_PASS=" (paste only the password)');
  if (/[\r\n\t]/.test(pass)) w.push('contains a line break or tab');
  return w;
}

/** Plain-English hint for each failure code, shown with the error. */
const HINTS = {
  smtp_auth: 'GoDaddy rejected the info@mswe.in login: check SMTP_PASS in Vercel (Production), or Titan security / 2FA settings.',
  smtp_timeout: 'The mail server did not answer in time: try SMTP_PORT=587 and SMTP_SECURE=tls.',
  smtp_connect: 'Could not connect to the mail server: check SMTP_HOST / SMTP_PORT.',
  smtp_rejected: 'The mail server refused the sender or recipient: SMTP_USER and MAIL_FROM must both be info@mswe.in.',
  smtp_not_configured: 'SMTP_PASS is not set for this deployment: add it in Vercel and redeploy.',
};

/**
 * Non-secret details about where sending failed. Never includes the password,
 * its length, or anything derived from it.
 */
function debugInfo(cfg, err) {
  const oneLine = (v) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const info = {
    step: err ? err.stage || 'unknown' : 'config',
    server_reply: err && err.reply ? oneLine(err.reply) : undefined,
    error: err ? oneLine(err.message.replace(/^SMTP .+? failed: /, '')) : undefined,
    smtp: `${cfg.host}:${cfg.port} (${cfg.secure})`,
    user: cfg.user,
    password_check: undefined,
    region: process.env.VERCEL_REGION || 'local',
    env: process.env.VERCEL_ENV || 'local',
  };
  if (err && /AUTH/.test(err.stage || '')) {
    const w = passwordWarnings(cfg.pass);
    info.password_check = w.length ? `saved SMTP_PASS ${w.join('; ')}` : 'no copy-paste problems found';
  }
  Object.keys(info).forEach((k) => info[k] === undefined && delete info[k]);
  return info;
}

/** Short, non-secret reason for a mail failure (visible in the browser Network tab). */
function failureCode(msg) {
  if (/AUTH password failed|AUTH user failed/.test(msg)) return 'smtp_auth';     // wrong mailbox password / user
  if (/timeout/i.test(msg)) return 'smtp_timeout';                                 // port blocked or server slow
  if (/connection error|closed unexpectedly|greeting/.test(msg)) return 'smtp_connect';
  return 'smtp_rejected';                                                          // e.g. sender/recipient refused
}

module.exports = {
  getConfig, cleanLine, cleanText, EMAIL_RE, makeRateLimiter, clientIp, requestOrigin,
  encodeWord, displayName, safeFilename, buildEmail, openSmtp, smtpSend, send, readBody,
  passwordWarnings, HINTS, debugInfo, failureCode,
};
