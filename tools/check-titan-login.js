#!/usr/bin/env node
/*
 * Checks the info@mswe.in Titan login from YOUR computer, using exactly the same
 * code as the website's contact form (api/contact.js).
 *
 *   node tools/check-titan-login.js
 *
 * It asks for the mailbox password (typing is hidden), logs in to GoDaddy's mail server (smtpout.secureserver.net),
 * and sends one test email to info@mswe.in. The password is not saved, printed or
 * sent anywhere except to Titan.
 *
 *   - Works here but fails on the website -> the value saved in Vercel (SMTP_PASS) is different.
 *   - Fails here too                      -> the password is wrong, or Titan blocks mail-app logins.
 */
'use strict';
const path = require('path');
const { _internal } = require(path.join(__dirname, '..', 'api', 'contact.js'));

function askHidden(question) {
  return new Promise((resolve) => {
    const { stdin, stdout } = process;
    stdout.write(question);
    if (!stdin.isTTY) { // piped input
      let data = '';
      stdin.on('data', (c) => { data += c; });
      stdin.on('end', () => resolve(data.replace(/\r?\n$/, '')));
      return;
    }
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onKey = (key) => {
      for (const ch of key) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false); stdin.pause(); stdin.removeListener('data', onKey);
          stdout.write('\n');
          return resolve(value);
        }
        if (ch === '\u0003') { stdout.write('\n'); process.exit(130); } // Ctrl+C
        if (ch === '\u007f' || ch === '\b') { value = value.slice(0, -1); continue; }
        value += ch;
      }
    };
    stdin.on('data', onKey);
  });
}

(async () => {
  const cfg = _internal.getConfig({ ...process.env, SMTP_PASS: 'placeholder' });
  console.log(`Checking login ${cfg.user} at ${cfg.host}:${cfg.port} (${cfg.secure})`);
  cfg.pass = await askHidden(`Password for ${cfg.user} (hidden): `);
  if (!cfg.pass) { console.log('No password entered.'); process.exit(1); }

  const warnings = _internal.passwordWarnings(cfg.pass);
  if (warnings.length) console.log(`Note: what you typed ${warnings.join('; ')}.`);

  const { raw } = _internal.buildMessage(cfg, {
    name: 'MSWE login check', email: cfg.user, company: 'MSWE', position: '', phone: '',
    topics: ['Others'], topic_other: 'SMTP login check', message: 'Test email from tools/check-titan-login.js. You can delete it.',
  }, 'local check', 'local');

  try {
    await _internal.smtpSend(cfg, raw);
    console.log('\nOK: Titan accepted the password and a test email was sent to ' + cfg.to + '.');
    console.log('So the password is right. Put exactly this password in Vercel SMTP_PASS (Production), then Redeploy.');
  } catch (e) {
    console.log(`\nFAILED at step "${e.stage || 'unknown'}": ${e.reply || e.message}`);
    if (/AUTH/.test(e.stage || '')) {
      console.log('Titan rejected this password from your computer too, so the website code is not the problem.');
      console.log('Check: can you log in at https://secureserver.titan.email with it? If yes, Titan is blocking mail-app');
      console.log('logins: look for 2-step verification (use an app password) or a security alert in Titan.');
    }
    process.exit(1);
  }
})();
