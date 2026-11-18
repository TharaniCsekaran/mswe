/**
 * Careers application: POST /api/careers (JSON)
 *   { name, email, phone, location, area, experience, linkedin, message, consent,
 *     website (honeypot), resume: { name, type, data (base64) } }
 *
 * Emails the application, with the resume attached, to pmo@mswe.in (CAREERS_TO),
 * Reply-To the applicant, and sends the applicant a short confirmation from
 * info@mswe.in. Vercel accepts request bodies up to 4.5 MB, so resumes are capped
 * at 3 MB (about 4 MB once base64-encoded).
 */

'use strict';

const {
  getConfig, cleanLine, cleanText, EMAIL_RE, makeRateLimiter, clientIp, requestOrigin,
  buildEmail, displayName, openSmtp, send, readBody, failureCode, HINTS, debugInfo,
} = require('./_lib/mail');

const AREAS = [
  'Cybersecurity',
  'AI & Data',
  'Governance & Compliance (GaaS)',
  'SaaS & Enterprise Development',
  'Cloud & DevOps',
  'Industry Expert (SME) / Trainer',
  'Other',
];
const EXPERIENCE = ['Fresher (0-1 years)', '1-3 years', '3-5 years', '5-10 years', '10+ years'];
const MAX_RESUME_BYTES = 3 * 1024 * 1024;
const PHONE_RE = /^\+?[0-9][0-9 ()-]{5,23}$/;

// recognise the real file type from its first bytes (not just the name)
const FILE_TYPES = [
  { ext: 'pdf', type: 'application/pdf', magic: [0x25, 0x50, 0x44, 0x46] },                            // %PDF
  { ext: 'docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', magic: [0x50, 0x4b, 0x03, 0x04] }, // zip
  { ext: 'doc', type: 'application/msword', magic: [0xd0, 0xcf, 0x11, 0xe0] },                         // OLE
];

const rateLimited = makeRateLimiter(3, 30 * 60e3); // 3 applications per IP per 30 minutes

function validate(input) {
  const d = {
    name: cleanLine(input.name, 100),
    email: cleanLine(input.email, 150),
    phone: cleanLine(input.phone, 25),
    location: cleanLine(input.location, 100),
    area: cleanLine(input.area, 60),
    experience: cleanLine(input.experience, 40),
    linkedin: cleanLine(input.linkedin, 300),
    message: cleanText(input.message, 2000),
  };
  if (d.name.length < 2) return { error: 'Please enter your full name.' };
  if (!EMAIL_RE.test(d.email)) return { error: 'Please enter a valid email address.' };
  if (!PHONE_RE.test(d.phone)) return { error: 'Please enter a valid phone number.' };
  if (!AREAS.includes(d.area)) return { error: 'Please choose your area of interest.' };
  if (!EXPERIENCE.includes(d.experience)) return { error: 'Please choose your experience.' };
  if (d.linkedin && !/^https?:\/\/\S+\.\S+/.test(d.linkedin)) return { error: 'The LinkedIn / portfolio link must start with https://' };
  if (input.consent !== true) return { error: 'Please agree to us storing your details for recruitment.' };

  const r = input.resume && typeof input.resume === 'object' ? input.resume : null;
  if (!r || typeof r.data !== 'string' || !r.data) return { error: 'Please attach your resume (PDF or Word).' };
  const content = Buffer.from(r.data.replace(/^data:[^,]*,/, ''), 'base64');
  if (!content.length) return { error: 'The resume file is empty.' };
  if (content.length > MAX_RESUME_BYTES) return { error: 'The resume is larger than 3 MB. Please upload a smaller file.' };
  const kind = FILE_TYPES.find((t) => t.magic.every((b, i) => content[i] === b));
  if (!kind) return { error: 'The resume must be a PDF or Word document (.pdf, .doc, .docx).' };
  const base = cleanLine(r.name, 120).replace(/\.[A-Za-z0-9]{1,5}$/, '') || 'resume';
  d.resume = { filename: `${base}.${kind.ext}`, contentType: kind.type, content };
  return { data: d };
}

function applicationEmail(cfg, d, ip) {
  const to = process.env.CAREERS_TO || 'pmo@mswe.in';
  const subject = `Job application: ${d.name} - ${d.area} (${d.experience})`;
  const kb = Math.round(d.resume.content.length / 1024);
  const text = [
    'New job application from the MSWE website',
    '==========================================',
    '',
    `Name:        ${d.name}`,
    `Email:       ${d.email}`,
    `Phone:       ${d.phone}`,
    `Location:    ${d.location || '-'}`,
    `Area:        ${d.area}`,
    `Experience:  ${d.experience}`,
    `LinkedIn:    ${d.linkedin || '-'}`,
    `Resume:      ${d.resume.filename} (${kb} KB, attached)`,
    '',
    'Message:',
    d.message || '-',
    '',
    '--',
    `Received ${new Date().toUTCString()} | IP ${ip}`,
    `The applicant agreed to MSWE storing their details for recruitment. Reply to this email to contact ${d.name}.`,
  ].join('\n');
  return {
    to,
    raw: buildEmail({
      fromName: 'MSWE Careers', from: cfg.from, to, subject, text,
      replyTo: `${displayName(d.name)} <${d.email}>`,
      attachments: [d.resume],
    }),
  };
}

function confirmationEmail(cfg, d) {
  const first = d.name.split(' ')[0];
  const subject = 'We received your application - MSWE';
  const text = [
    `Hi ${first},`,
    '',
    `Thank you for your interest in joining MSWE. We have received your application for ${d.area} along with your resume.`,
    '',
    'Our team reviews every application. If your profile matches a current or upcoming role, we will contact you to discuss the next steps.',
    '',
    'Best regards,',
    'The MSWE Team',
    'https://www.mswe.in',
    '',
    '--',
    'You are receiving this one-time confirmation because you applied on mswe.in.',
  ].join('\n');
  return buildEmail({ fromName: 'MSWE Careers', from: cfg.from, to: d.email, subject, text });
}

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
    input = await readBody(req, 4.6e6);
  } catch {
    return send(res, 413, 'The upload is too large. Please attach a resume under 3 MB.');
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return send(res, 400, 'Invalid request.');

  if (String(input.website || '').trim() !== '') return send(res, 200, 'Thank you! Your application has been sent.');

  const { data, error } = validate(input);
  if (error) return send(res, 422, error);

  const ip = clientIp(req);
  if (rateLimited(ip)) {
    return send(res, 429, 'Too many applications from your connection. Please try again later, or email your resume to pmo@mswe.in.');
  }
  if (!cfg.pass) {
    console.error('[mswe-careers] SMTP_PASS is not set');
    return send(res, 503, 'Applications are being set up. Please email your resume to pmo@mswe.in.', 'smtp_not_configured',
      { ...debugInfo(cfg, null), hint: HINTS.smtp_not_configured });
  }

  let session;
  try {
    session = await openSmtp(cfg);
    const app = applicationEmail(cfg, data, ip);
    await session.sendMail(cfg.from, app.to, app.raw);
  } catch (e) {
    if (session) session.quit();
    const code = failureCode(e.message);
    console.error(`[mswe-careers] ${code} at "${e.stage}": ${e.message}`);
    return send(res, 502, 'Sorry, we could not send your application right now. Please try again, or email your resume to pmo@mswe.in.', code,
      { ...debugInfo(cfg, e), hint: HINTS[code] });
  }
  // confirmation to the applicant: nice to have, never blocks the application
  try {
    await session.sendMail(cfg.from, data.email, confirmationEmail(cfg, data));
  } catch (e) {
    console.error(`[mswe-careers] confirmation email failed: ${e.message}`);
  }
  session.quit();

  const first = data.name.split(' ')[0];
  return send(res, 200, `Thank you ${first}! Your application has been sent. We'll be in touch if your profile matches a role.`);
}

module.exports = handler;
module.exports._internal = { validate, AREAS, EXPERIENCE, MAX_RESUME_BYTES };
