/**
 * Newsletter sign-up: POST /api/subscribe  { email, website (honeypot), source }
 *
 * Saves the address in Upstash Redis and sends a welcome email from info@mswe.in.
 * See api/README.md for the one-time setup.
 */

'use strict';

const {
  getConfig, cleanLine, EMAIL_RE, makeRateLimiter, clientIp, requestOrigin,
  smtpSend, send, readBody, failureCode, HINTS, debugInfo,
} = require('./_lib/mail');
const { getStore } = require('./_lib/store');
const { welcomeEmail } = require('./_lib/newsletter');

const rateLimited = makeRateLimiter(5, 10 * 60e3); // 5 sign-ups per IP per 10 minutes

async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return send(res, 405, 'Method not allowed.');
  }
  const cfg = getConfig();
  const origin = requestOrigin(req);
  if (origin && !cfg.origins.includes(origin)) {
    return send(res, 403, 'This form can only be submitted from the MSWE website.');
  }

  let input;
  try {
    input = await readBody(req, 2000);
  } catch {
    return send(res, 400, 'Invalid request.');
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return send(res, 400, 'Invalid request.');

  // Honeypot: pretend success for bots
  if (String(input.website || '').trim() !== '') return send(res, 200, "You're subscribed!");

  const email = cleanLine(input.email, 150);
  if (!EMAIL_RE.test(email)) return send(res, 422, 'Please enter a valid email address.');
  const source = cleanLine(input.source, 60) || 'website';

  if (rateLimited(clientIp(req))) {
    return send(res, 429, 'Too many sign-ups from your connection. Please try again in a few minutes.');
  }

  const store = getStore();
  if (!store) {
    console.error('[mswe-newsletter] subscriber database is not connected (KV_REST_API_URL / KV_REST_API_TOKEN missing)');
    return send(res, 503, 'Newsletter sign-up is being set up. Please try again soon.', 'store_not_configured',
      { hint: 'Connect an Upstash Redis database to the project in Vercel → Storage, then redeploy.' });
  }

  let result;
  try {
    result = await store.add(email, source);
  } catch (e) {
    console.error(`[mswe-newsletter] store error: ${e.message}`);
    return send(res, 502, 'Sorry, we could not subscribe you right now. Please try again later.', 'store_error',
      { hint: 'The subscriber database did not answer: check the Upstash database in Vercel → Storage.' });
  }
  if (!result.added) return send(res, 200, "You're already subscribed. Thanks for staying with us!", null, null, { already: true });

  // Welcome email. The subscription is kept even if this fails.
  if (!cfg.pass) {
    console.error('[mswe-newsletter] SMTP_PASS is not set: welcome email not sent');
    return send(res, 200, "You're subscribed! Thanks for joining MSWE Insights.");
  }
  try {
    await smtpSend(cfg, welcomeEmail(cfg, result.sub).raw, result.sub.email);
  } catch (e) {
    const code = failureCode(e.message);
    console.error(`[mswe-newsletter] welcome email failed (${code}) at "${e.stage}": ${e.message}`);
    return send(res, 200, "You're subscribed! (We couldn't send the welcome email just now.)", code,
      { ...debugInfo(cfg, e), hint: HINTS[code] });
  }
  return send(res, 200, `You're subscribed! A welcome email is on its way to ${result.sub.email}.`);
}

module.exports = handler;
