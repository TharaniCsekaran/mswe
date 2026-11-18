/**
 * Newsletter admin API, used by /admin.html. POST /api/admin  { action, ... }
 * Requires the header  Authorization: Bearer <ADMIN_PASSWORD>  (a Vercel env var).
 *
 * actions:
 *   overview                      -> { subscribers, sends }
 *   preview  { content }          -> { html }   (rendered case-study email)
 *   send     { content, test }    -> sends one test copy to info@mswe.in
 *   send     { content, recipients: [emails] } -> sends to up to 25 subscribers per call
 *   log      { subject, sent, failed }          -> records a finished campaign
 *   remove   { email }            -> removes a subscriber
 *
 * content = { subject, headline, body, ctaLabel?, ctaUrl?, imageUrl? }
 */

'use strict';

const crypto = require('crypto');
const {
  getConfig, cleanLine, cleanText, EMAIL_RE, makeRateLimiter, clientIp, requestOrigin,
  openSmtp, send, readBody, failureCode, HINTS, debugInfo,
} = require('./_lib/mail');
const { getStore } = require('./_lib/store');
const { caseStudyEmail, safeUrl } = require('./_lib/newsletter');

const BATCH_MAX = 25;
const badLogin = makeRateLimiter(10, 15 * 60e3); // wrong passwords allowed per IP per 15 minutes

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
function passwordOk(given, expected) {
  return crypto.timingSafeEqual(sha(given), sha(expected)); // constant time, any length
}

function readContent(c) {
  c = c && typeof c === 'object' ? c : {};
  const content = {
    subject: cleanLine(c.subject, 150),
    headline: cleanLine(c.headline, 150),
    body: cleanText(c.body, 10000),
    ctaLabel: cleanLine(c.ctaLabel, 40),
    ctaUrl: cleanLine(c.ctaUrl, 500),
    imageUrl: cleanLine(c.imageUrl, 500),
  };
  let error = null;
  if (content.subject.length < 3) error = 'Add an email subject.';
  else if (content.headline.length < 3) error = 'Add a headline.';
  else if (content.body.length < 20) error = 'Write the case study text (at least 20 characters).';
  else if (content.ctaUrl && !safeUrl(content.ctaUrl)) error = 'The button link must start with https://';
  else if (content.imageUrl && !safeUrl(content.imageUrl)) error = 'The image link must start with https://';
  return { content, error };
}

/** Sends one email per subscriber over a shared connection; reconnects once if it drops. */
async function sendBatch(cfg, subs, content) {
  const sent = [];
  const failed = [];
  let session = null;
  let reconnects = 0;
  for (const sub of subs) {
    try {
      if (!session || session.broken) {
        if (session && reconnects++ >= 1) throw Object.assign(new Error('connection lost again'), { stage: 'connect' });
        session = await openSmtp(cfg);
      }
      await session.sendMail(cfg.from, sub.email, caseStudyEmail(cfg, sub, content).raw);
      sent.push(sub.email);
    } catch (e) {
      // login problems affect everyone: stop and report them
      if (/AUTH|greeting|connect/.test(e.stage || '') && !sent.length) throw e;
      failed.push({ email: sub.email, reason: (e.reply || e.message).slice(0, 160) });
    }
  }
  if (session) session.quit();
  return { sent, failed };
}

async function handler(req, res) {
  res.setHeader('X-Robots-Tag', 'noindex');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return send(res, 405, 'Method not allowed.');
  }
  const cfg = getConfig();
  const origin = requestOrigin(req);
  if (origin && !cfg.origins.includes(origin)) return send(res, 403, 'Not allowed from this website.');

  const expected = (process.env.ADMIN_PASSWORD || '').replace(/[\r\n]+$/, '');
  if (!expected) {
    return send(res, 503, 'The admin page is not set up yet: add ADMIN_PASSWORD in Vercel → Settings → Environment Variables, then redeploy.', 'admin_not_configured');
  }
  const ip = clientIp(req);
  const given = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!passwordOk(given, expected)) {
    if (badLogin(ip)) return send(res, 429, 'Too many wrong passwords. Wait 15 minutes and try again.');
    return send(res, 401, 'Wrong admin password.', 'bad_password');
  }

  let input;
  try {
    input = await readBody(req, 60000);
  } catch {
    return send(res, 400, 'Invalid request.');
  }
  if (!input || typeof input !== 'object') return send(res, 400, 'Invalid request.');

  const store = getStore();
  if (!store) {
    return send(res, 503, 'The subscriber database is not connected: in Vercel → Storage, create an Upstash Redis database, connect it to this project, then redeploy.', 'store_not_configured');
  }

  try {
    switch (input.action) {
      case 'overview': {
        const [subscribers, sends] = await Promise.all([store.list(), store.sends()]);
        return send(res, 200, 'ok', null, null, {
          subscribers: subscribers.map(({ email, subscribedAt, source }) => ({ email, subscribedAt, source })),
          sends,
          from: cfg.from,
          testTo: cfg.to,
        });
      }

      case 'preview': {
        const { content, error } = readContent(input.content);
        if (error) return send(res, 422, error);
        const { html } = caseStudyEmail(cfg, { email: cfg.to, id: '0'.repeat(32) }, content);
        return send(res, 200, 'ok', null, null, { html });
      }

      case 'send': {
        const { content, error } = readContent(input.content);
        if (error) return send(res, 422, error);
        if (!cfg.pass) return send(res, 503, 'SMTP_PASS is not set, so emails cannot be sent.', 'smtp_not_configured');

        let subs;
        let requested = 1;
        if (input.test) {
          subs = [{ email: cfg.to, id: '0'.repeat(32) }];
          content.subject = `[TEST] ${content.subject}`;
        } else {
          const list = (Array.isArray(input.recipients) ? input.recipients : []).map(String).slice(0, BATCH_MAX);
          if (!list.length) return send(res, 422, 'No recipients in this batch.');
          requested = list.length;
          // only addresses that are still subscribed (each needs its own unsubscribe id)
          subs = (await Promise.all(list.map((e) => store.get(e)))).filter(Boolean);
        }
        try {
          const result = await sendBatch(cfg, subs, content);
          return send(res, 200, 'ok', null, null, { ...result, skipped: requested - subs.length });
        } catch (e) {
          const code = failureCode(e.message);
          console.error(`[mswe-admin] send failed (${code}) at "${e.stage}": ${e.message}`);
          return send(res, 502, 'Could not send: the mail server refused the login or connection.', code, { ...debugInfo(cfg, e), hint: HINTS[code] });
        }
      }

      case 'log': {
        await store.logSend({
          subject: cleanLine(input.subject, 150),
          sent: Number(input.sent) || 0,
          failed: Number(input.failed) || 0,
        });
        return send(res, 200, 'ok');
      }

      case 'remove': {
        const email = cleanLine(input.email, 150);
        if (!EMAIL_RE.test(email)) return send(res, 422, 'Invalid email address.');
        const removed = await store.remove(email);
        return send(res, 200, removed ? `${email} was removed.` : `${email} was not on the list.`);
      }

      default:
        return send(res, 400, 'Unknown action.');
    }
  } catch (e) {
    console.error(`[mswe-admin] ${input.action} failed: ${e.message}`);
    return send(res, 502, 'The subscriber database did not answer. Please try again.', 'store_error');
  }
}

module.exports = handler;
module.exports._internal = { readContent, sendBatch, passwordOk };
