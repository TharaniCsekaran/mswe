/**
 * Newsletter emails sent from info@mswe.in: the welcome email and case-study
 * emails. Each has a plain-text and an HTML version, plus one-click unsubscribe
 * headers (Gmail / Yahoo require them for bulk mail).
 */

'use strict';

const { buildEmail } = require('./mail');

const BRAND = '#6E6BFF';
const BRAND_2 = '#1AA8E0';
const INK = '#0B0E14';
const MUTED = '#5B6475';
const ADDRESS = 'MSWE Technology Solutions Pvt. Ltd., New No. 58, 3rd Main Road, Kasturibai Nagar, Adyar, Chennai 600020, India';

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const unsubscribeUrl = (cfg, sub) => `${cfg.siteUrl}/api/unsubscribe?id=${sub.id}`;

/** Only http(s) links are allowed in buttons and images. */
function safeUrl(u) {
  try {
    const url = new URL(String(u || '').trim());
    return /^https?:$/.test(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

/**
 * Turns the admin's plain text into HTML:
 *   - a blank line starts a new paragraph
 *   - lines starting with "- " or "• " become bullet points
 *   - a short line (no full stop) followed by more lines in the same block, such
 *     as "The challenge" or "What we did", becomes a small heading
 */
const P = `margin:0 0 18px;color:${INK};font-size:16px;line-height:1.6`;
const isBullet = (l) => /^[-•*]\s+/.test(l);
function textToHtml(text) {
  return String(text || '').replace(/\r\n?/g, '\n').split(/\n\s*\n/).map((block) => {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    let html = '';
    if (lines.length > 1 && !isBullet(lines[0]) && lines[0].length <= 60 && !/[.!?:;,]$/.test(lines[0])) {
      html += `<h2 style="margin:0 0 8px;color:${INK};font-size:18px;line-height:1.35;font-weight:700">${esc(lines.shift())}</h2>`;
    }
    // group consecutive bullet lines into one list, other lines into one paragraph
    for (let i = 0; i < lines.length;) {
      const bullet = isBullet(lines[i]);
      const run = [];
      while (i < lines.length && isBullet(lines[i]) === bullet) run.push(lines[i++]);
      html += bullet
        ? `<ul style="margin:0 0 18px;padding-left:20px;color:${INK};font-size:16px;line-height:1.6">${run.map((l) => `<li style="margin:0 0 8px">${esc(l.replace(/^[-•*]\s+/, ''))}</li>`).join('')}</ul>`
        : `<p style="${P}">${run.map(esc).join('<br>')}</p>`;
    }
    return html;
  }).join('');
}

/** Shared HTML frame: logo header, content card, footer with address + unsubscribe. */
function frame(cfg, { preheader, eyebrow, headline, inner, unsub }) {
  const logo = `${cfg.siteUrl}/assets/images/mswe-dark.png`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><title>${esc(headline)}</title></head>
<body style="margin:0;padding:0;background:#F3F4F8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preheader || '')}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F3F4F8">
<tr><td align="center" style="padding:28px 12px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px">
    <tr><td style="padding:0 4px 18px">
      <a href="${cfg.siteUrl}" style="text-decoration:none"><img src="${logo}" width="48" height="48" alt="MSWE" style="display:block;border:0;border-radius:10px"></a>
    </td></tr>
    <tr><td style="background:#FFFFFF;border-radius:16px;overflow:hidden;border:1px solid #E6E8EF">
      <div style="height:4px;background:${BRAND};background-image:linear-gradient(90deg,${BRAND},${BRAND_2})"></div>
      <div style="padding:32px 28px 12px">
        ${eyebrow ? `<p style="margin:0 0 10px;font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:${BRAND}">${esc(eyebrow)}</p>` : ''}
        <h1 style="margin:0 0 18px;font-size:26px;line-height:1.25;color:${INK};font-weight:700">${esc(headline)}</h1>
        ${inner}
      </div>
    </td></tr>
    <tr><td style="padding:20px 8px;color:${MUTED};font-size:12px;line-height:1.6">
      ${esc(ADDRESS)}<br>
      You are receiving this because you subscribed to MSWE Insights at <a href="${cfg.siteUrl}" style="color:${MUTED}">mswe.in</a>.
      <a href="${unsub}" style="color:${MUTED};text-decoration:underline">Unsubscribe</a>
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;
}

const button = (href, label) => `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px 0 22px"><tr>
<td style="border-radius:999px;background:${BRAND};background-image:linear-gradient(90deg,${BRAND},${BRAND_2})">
<a href="${href}" style="display:inline-block;padding:13px 24px;color:#FFFFFF;font-weight:600;font-size:15px;text-decoration:none;border-radius:999px">${esc(label)}</a>
</td></tr></table>`;

function listHeaders(cfg, sub) {
  return {
    'List-Unsubscribe': `<${unsubscribeUrl(cfg, sub)}>, <mailto:${cfg.from}?subject=unsubscribe>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}

function textFooter(cfg, sub) {
  return ['', '--', ADDRESS, 'You are receiving this because you subscribed to MSWE Insights at mswe.in.',
    `Unsubscribe: ${unsubscribeUrl(cfg, sub)}`].join('\n');
}

/* ---- welcome ------------------------------------------------------- */

function welcomeEmail(cfg, sub) {
  const subject = 'Welcome to MSWE Insights';
  const unsub = unsubscribeUrl(cfg, sub);
  const points = [
    'Case studies from our cybersecurity, AI and platform work',
    'Practical security and AI strategies you can apply',
    'Technology trends shaping digital business',
  ];
  const inner = `
    <p style="margin:0 0 18px;color:${INK};font-size:16px;line-height:1.6">Thanks for subscribing. You'll hear from us when we have something worth your time, usually no more than a couple of emails a month.</p>
    <p style="margin:0 0 10px;color:${INK};font-size:16px;line-height:1.6"><strong>What you'll get:</strong></p>
    <ul style="margin:0 0 20px;padding-left:20px;color:${INK};font-size:16px;line-height:1.6">${points.map((p) => `<li style="margin:0 0 8px">${esc(p)}</li>`).join('')}</ul>
    ${button(cfg.siteUrl, 'Explore mswe.in')}
    <p style="margin:0 0 18px;color:${MUTED};font-size:14px;line-height:1.6">Have a project in mind? Just reply to this email; it comes straight to our team.</p>`;
  const html = frame(cfg, { preheader: 'Case studies and insights from the MSWE team.', eyebrow: 'MSWE Insights', headline: 'Welcome aboard!', inner, unsub });
  const text = [
    'Welcome aboard!', '',
    "Thanks for subscribing to MSWE Insights. You'll hear from us when we have something worth your time, usually no more than a couple of emails a month.", '',
    "What you'll get:", ...points.map((p) => `- ${p}`), '',
    `Explore mswe.in: ${cfg.siteUrl}`, '',
    'Have a project in mind? Just reply to this email; it comes straight to our team.',
    textFooter(cfg, sub),
  ].join('\n');
  return { subject, raw: buildEmail({ fromName: 'MSWE', from: cfg.from, to: sub.email, subject, text, html, headers: listHeaders(cfg, sub) }) };
}

/* ---- case study ---------------------------------------------------- */

/**
 * content: { subject, headline, body, ctaLabel?, ctaUrl?, imageUrl? }
 * Returns { subject, raw, html }.
 */
function caseStudyEmail(cfg, sub, content) {
  const unsub = unsubscribeUrl(cfg, sub);
  const ctaUrl = safeUrl(content.ctaUrl);
  const imageUrl = safeUrl(content.imageUrl);
  const ctaLabel = content.ctaLabel || 'Read the case study';
  const inner = `
    ${imageUrl ? `<img src="${esc(imageUrl)}" width="544" alt="" style="display:block;width:100%;max-width:544px;height:auto;border:0;border-radius:12px;margin:0 0 22px">` : ''}
    ${textToHtml(content.body)}
    ${ctaUrl ? button(esc(ctaUrl), ctaLabel) : ''}`;
  const html = frame(cfg, { preheader: content.body.split('\n')[0].slice(0, 140), eyebrow: 'Case Study', headline: content.headline, inner, unsub });
  const text = [
    content.headline, '',
    content.body, '',
    ctaUrl ? `${ctaLabel}: ${ctaUrl}` : '',
    textFooter(cfg, sub),
  ].join('\n');
  return {
    subject: content.subject,
    html,
    raw: buildEmail({ fromName: 'MSWE', from: cfg.from, to: sub.email, subject: content.subject, text, html, headers: listHeaders(cfg, sub) }),
  };
}

module.exports = { welcomeEmail, caseStudyEmail, unsubscribeUrl, safeUrl, esc };
