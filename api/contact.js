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

const crypto = require('crypto');
const {
  getConfig, cleanLine, cleanText, EMAIL_RE, makeRateLimiter, clientIp, requestOrigin,
  encodeWord, displayName, smtpSend, send, readBody, passwordWarnings, HINTS, debugInfo, failureCode,
} = require('./_lib/mail');

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

/* ------------------------------------------------------------------ */
/* validation                                                          */
/* ------------------------------------------------------------------ */

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

const rateLimited = makeRateLimiter(RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
const hits = rateLimited.hits;

/* ------------------------------------------------------------------ */
/* email building                                                      */
/* ------------------------------------------------------------------ */

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
/* HTTP handler                                                        */
/* ------------------------------------------------------------------ */

async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return send(res, 405, 'Method not allowed.');
  }

  const cfg = getConfig();

  // Only accept posts from the MSWE site itself (browsers send Origin on POST)
  const origin = requestOrigin(req);
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

  const ip = clientIp(req);
  if (rateLimited(ip)) {
    return send(res, 429, 'Too many messages from your connection. Please try again in a few minutes, or email info@mswe.in.');
  }

  if (!cfg.pass) {
    console.error('[mswe-contact] SMTP_PASS is not set in Vercel environment variables');
    const code = 'smtp_not_configured';
    return send(res, 503, 'Our contact form is being set up. Please email us directly at info@mswe.in.', code,
      { ...debugInfo(cfg, null), hint: HINTS[code] });
  }

  try {
    const { raw } = buildMessage(cfg, data, origin, ip);
    await smtpSend(cfg, raw);
  } catch (e) {
    const code = failureCode(e.message);
    const debug = { ...debugInfo(cfg, e), hint: HINTS[code] };
    console.error(`[mswe-contact] ${code} at step "${debug.step}": ${e.message} | ${debug.smtp} region=${debug.region}`);
    return send(res, 502, 'Sorry, we could not send your message right now. Please try again, or email info@mswe.in.', code, debug);
  }

  const first = data.name.split(' ')[0];
  return send(res, 200, `Thanks ${first}! Your message has been sent. We'll reply within one business day.`);
}

module.exports = handler;
// exposed for local tests only
module.exports._internal = { passwordWarnings, validate, buildMessage, smtpSend, getConfig, rateLimited, hits };
