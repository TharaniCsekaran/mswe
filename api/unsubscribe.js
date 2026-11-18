/**
 * Unsubscribe link from newsletter emails: /api/unsubscribe?id=<secret id>
 *
 *   GET  -> a small page asking to confirm (link scanners in mail systems open
 *           links automatically, so a GET alone never unsubscribes anyone)
 *   POST -> removes the subscriber. Also used by Gmail/Outlook's built-in
 *           "Unsubscribe" button (List-Unsubscribe-Post one-click).
 */

'use strict';

const { getConfig } = require('./_lib/mail');
const { getStore } = require('./_lib/store');
const { esc } = require('./_lib/newsletter');

function page(res, status, title, bodyHtml) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)} | MSWE</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#F3F4F8;color:#0B0E14;
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;padding:16px}
  .card{max-width:440px;width:100%;background:#fff;border:1px solid #E6E8EF;border-radius:16px;padding:32px 28px;text-align:center}
  img{width:56px;height:56px;border-radius:12px}
  h1{font-size:22px;margin:18px 0 10px}
  p{color:#5B6475;line-height:1.6;margin:0 0 20px}
  button,a.btn{display:inline-block;border:0;border-radius:999px;padding:12px 24px;font-size:15px;font-weight:600;font-family:inherit;cursor:pointer;
    color:#fff;background:linear-gradient(90deg,#6E6BFF,#1AA8E0);text-decoration:none}
  a{color:#6E6BFF}
</style></head><body><main class="card">
<img src="/assets/images/mswe-dark.png" alt="MSWE">
<h1>${esc(title)}</h1>${bodyHtml}</main></body></html>`);
}

async function readForm(req) {
  if (req.body !== undefined) return req.body; // already parsed by Vercel
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 2000) break;
  }
  return raw;
}

async function handler(req, res) {
  const cfg = getConfig();
  const url = new URL(req.url || '/', 'http://local');
  const id = String((req.query && req.query.id) || url.searchParams.get('id') || '');
  const home = `<p><a href="${cfg.siteUrl}">Back to mswe.in</a></p>`;

  if (req.method === 'GET' || req.method === 'HEAD') {
    if (!/^[a-f0-9]{32}$/.test(id)) {
      return page(res, 400, 'Link not valid', `<p>This unsubscribe link is incomplete. Please use the link from the bottom of our email, or reply to it and we'll remove you.</p>${home}`);
    }
    return page(res, 200, 'Unsubscribe from MSWE Insights?', `<p>You'll stop receiving our case studies and insights by email.</p>
<form method="post" action="/api/unsubscribe?id=${id}"><button type="submit">Yes, unsubscribe me</button></form>`);
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return page(res, 405, 'Not allowed', home);
  }

  await readForm(req).catch(() => '');
  const store = getStore();
  if (!store) return page(res, 503, 'Please try again later', `<p>We could not process this right now. Reply to any of our emails and we'll remove you.</p>${home}`);
  try {
    await store.removeById(id); // unknown or already-used ids are treated as done
  } catch (e) {
    console.error(`[mswe-newsletter] unsubscribe failed: ${e.message}`);
    return page(res, 502, 'Please try again later', `<p>We could not process this right now. Reply to any of our emails and we'll remove you.</p>${home}`);
  }
  return page(res, 200, "You're unsubscribed", `<p>You won't receive any more newsletter emails from MSWE. Changed your mind? You can subscribe again on our website anytime.</p>${home}`);
}

module.exports = handler;
