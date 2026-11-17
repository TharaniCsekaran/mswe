/**
 * MSWE website contact form: Vercel serverless function (POST /api/contact).
 *
 * Validates the JSON posted by the contact form on index.html and emails it to
 * info@mswe.in through Titan Mail (GoDaddy) SMTP. No npm packages: it uses
 * Node's built-in net/tls, so nothing needs installing.
 *
 * Settings come from Vercel environment variables (Project > Settings >
 * Environment Variables). Only SMTP_PASS is required; see api/README.md.
 */

'use strict';

const net = require('net');
const tls = require('tls');
const crypto = require('crypto');

// Topic values the form may send (must match <select id="cf-topics"> in index.html)
const ALLOWED_TOPICS = [
  'Cybersecurity',
  'AI Agents & Solutions',
  'GaaS (Governance-as-a-Service)',
  'SaaS & Enterprise Development',
  'Industry Experts & Training',
  'Others', // requires the free-text "topic_other" field
];

const RATE_LIMIT_MAX = 5;               // submissions allowed ...
const RATE_LIMIT_WINDOW_MS = 10 * 60e3; // ... per IP per 10 minutes (best effort per instance)
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
    host: env.SMTP_HOST || 'smtp.titan.email',
    port: Number(env.SMTP_PORT || 465),
    secure: (env.SMTP_SECURE || 'ssl').toLowerCase(), // 'ssl' (465) | 'tls' (587 STARTTLS) | 'none' (local tests only)
    user: (env.SMTP_USER || 'info@mswe.in').trim(),
    // strip a trailing newline that pasting into the Vercel dashboard can add
    pass: (env.SMTP_PASS || '').replace(/[\r\n]+$/, ''),
    to: env.MAIL_TO || 'info@mswe.in',
    from: env.MAIL_FROM || env.SMTP_USER || 'info@mswe.in', // Titan only sends as the logged-in mailbox
    fromName: env.MAIL_FROM_NAME || 'MSWE Website',
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
const PHONE_RE = /^\+?[0-9][0-9 ()-]{5,23}$/;

function validate(input) {
  const data = {
    name: cleanLine(input.name, 100),
    email: cleanLine(input.email, 150),
    company: cleanLine(input.company, 150),
    position: cleanLine(input.position, 100),
    phone: cleanLine(input.phone, 25),
    message: cleanText(input.message, 2000),
    topics: (Array.isArray(input.topics) ? input.topics : [])
      .map(String)
      .filter((t, i, a) => ALLOWED_TOPICS.includes(t) && a.indexOf(t) === i),
  };
  data.topicOther = data.topics.includes('Others') ? cleanLine(input.topic_other, 100) : '';

  let error = null;
  if (data.name.length < 2) error = 'Please enter your name.';
  else if (!EMAIL_RE.test(data.email)) error = 'Please enter a valid email address.';
  else if (!data.company) error = 'Please enter your company name.';
  else if (!PHONE_RE.test(data.phone)) error = 'Please enter a valid mobile number.';
  else if (!data.topics.length) error = 'Please select at least one topic.';
  else if (data.topics.includes('Others') && !data.topicOther) error = 'Please tell us the other topic.';
  else if (data.message.length < 10) error = 'Please enter a message of at least 10 characters.';
  return { data, error };
}

/* ------------------------------------------------------------------ */
/* rate limit (in-memory: per warm serverless instance, best effort)   */
/* ------------------------------------------------------------------ */

const hits = new Map();
function rateLimited(ip, now = Date.now()) {
  const recent = (hits.get(ip) || []).filter((t) => t > now - RATE_LIMIT_WINDOW_MS);
  if (recent.length >= RATE_LIMIT_MAX) {
    hits.set(ip, recent);
    return true;
  }
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear(); // keep memory bounded
  return false;
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

function buildMessage(cfg, d, origin, ip) {
  const topics = d.topics.map((t) => (t === 'Others' ? `Others: ${d.topicOther}` : t));
  const subject = `Website enquiry: ${d.name}${d.company ? ` - ${d.company}` : ''}`;
  const body = [
    'New enquiry from the MSWE website',
    '=================================',
    '',
    `Name:     ${d.name}`,
    `Email:    ${d.email}`,
    `Company:  ${d.company}`,
    `Position: ${d.position || '-'}`,
    `Phone:    ${d.phone}`,
    `Topics:   ${topics.join(', ')}`,
    '',
    'Message:',
    d.message,
    '',
    '--',
    `Sent ${new Date().toUTCString()} from ${origin || 'the website'} | IP ${ip}`,
    `Reply to this email to answer ${d.name} directly.`,
  ].join('\r\n');

  const headers = [
    `Date: ${new Date().toUTCString()}`,
    `From: ${displayName(cfg.fromName)} <${cfg.from}>`,
    `To: <${cfg.to}>`,
    `Reply-To: ${displayName(d.name)} <${d.email}>`,
    `Subject: ${encodeWord(subject)}`,
    `Message-ID: <${crypto.randomBytes(12).toString('hex')}@mswe.in>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    'X-Mailer: MSWE website contact form',
  ];
  // base64 body in 76-char lines: no line can start with "." so no dot-stuffing needed
  const b64 = Buffer.from(body, 'utf8').toString('base64').match(/.{1,76}/g).join('\r\n');
  return { subject, raw: `${headers.join('\r\n')}\r\n\r\n${b64}` };
}

/* ------------------------------------------------------------------ */
/* minimal SMTP client                                                 */
/* ------------------------------------------------------------------ */

function smtpSend(cfg, raw) {
  return new Promise((resolve, reject) => {
    let socket;
    let buffer = '';
    let waiter = null;
    let done = false;

    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (socket) {
        if (err) socket.destroy();
        else socket.end(); // polite close after QUIT
      }
      err ? reject(err) : resolve();
    };
    const timer = setTimeout(() => finish(new Error('SMTP timeout')), SMTP_TIMEOUT_MS);

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
          w({ code: Number(text.slice(0, 3)), text });
          return;
        }
      }
    };
    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      tryReply();
    };
    const read = () => new Promise((res) => { waiter = res; tryReply(); });
    const attach = (s) => {
      socket = s;
      s.on('data', onData);
      s.on('error', (e) => finish(new Error(`SMTP connection error: ${e.message}`)));
      s.on('close', () => finish(new Error('SMTP connection closed unexpectedly')));
    };
    // label is used in errors instead of the command (never log the password)
    const cmd = async (line, expect, label) => {
      if (line !== null) socket.write(`${line}\r\n`);
      const r = await read();
      if (!expect.includes(r.code)) throw new Error(`SMTP ${label} failed: ${r.text}`);
      return r;
    };

    const run = async () => {
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
      await cmd(`MAIL FROM:<${cfg.from}>`, [250], 'MAIL FROM');
      await cmd(`RCPT TO:<${cfg.to}>`, [250, 251], 'RCPT TO');
      await cmd('DATA', [354], 'DATA');
      await cmd(`${raw}\r\n.`, [250], 'message body');
      socket.write('QUIT\r\n');
      finish();
    };

    const onConnect = () => run().catch(finish);
    if (cfg.secure === 'ssl') {
      attach(tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host, minVersion: 'TLSv1.2' }, onConnect));
    } else {
      attach(net.connect({ host: cfg.host, port: cfg.port }, onConnect));
    }
  });
}

/* ------------------------------------------------------------------ */
/* HTTP handler                                                        */
/* ------------------------------------------------------------------ */

function send(res, status, message, code) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(code ? { message, code } : { message }));
}

/** Short, non-secret reason for a mail failure (visible in the browser Network tab). */
function failureCode(msg) {
  if (/AUTH password failed|AUTH user failed/.test(msg)) return 'smtp_auth';     // wrong mailbox password / user
  if (/timeout/i.test(msg)) return 'smtp_timeout';                                 // port blocked or server slow
  if (/connection error|closed unexpectedly|greeting/.test(msg)) return 'smtp_connect';
  return 'smtp_rejected';                                                          // e.g. sender/recipient refused
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body; // Vercel already parsed JSON
  if (typeof req.body === 'string') return JSON.parse(req.body);
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 20000) throw new Error('too large');
  }
  return JSON.parse(raw || 'null');
}

async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return send(res, 405, 'Method not allowed.');
  }

  const cfg = getConfig();

  // Only accept posts from the MSWE site itself (browsers send Origin on POST)
  const origin = String(req.headers.origin || '').replace(/\/+$/, '');
  if (origin && !cfg.origins.includes(origin)) {
    return send(res, 403, 'This form can only be submitted from the MSWE website.');
  }

  let input;
  try {
    input = await readBody(req);
  } catch {
    return send(res, 400, 'Invalid request.');
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return send(res, 400, 'Invalid request.');
  }

  // Honeypot: real visitors never fill the hidden "website" field. Pretend success for bots.
  if (String(input.website || '').trim() !== '') {
    return send(res, 200, 'Your message has been sent successfully.');
  }

  const { data, error } = validate(input);
  if (error) return send(res, 422, error);

  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  if (rateLimited(ip)) {
    return send(res, 429, 'Too many messages from your connection. Please try again in a few minutes, or email info@mswe.in.');
  }

  if (!cfg.pass) {
    console.error('[mswe-contact] SMTP_PASS is not set in Vercel environment variables');
    return send(res, 503, 'Our contact form is being set up. Please email us directly at info@mswe.in.');
  }

  try {
    const { raw } = buildMessage(cfg, data, origin, ip);
    await smtpSend(cfg, raw);
  } catch (e) {
    console.error(`[mswe-contact] ${e.message}`);
    return send(res, 502, 'Sorry, we could not send your message right now. Please try again, or email info@mswe.in.', failureCode(e.message));
  }

  const first = data.name.split(' ')[0];
  return send(res, 200, `Thanks ${first}! Your message has been sent. We'll reply within one business day.`);
}

module.exports = handler;
// exposed for local tests only
module.exports._internal = { validate, buildMessage, smtpSend, getConfig, rateLimited, hits };
