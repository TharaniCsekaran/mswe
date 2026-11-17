# Contact form: setup on GoDaddy (cPanel) with Titan Mail

The form on `index.html` posts to `api/contact.php`, which emails each enquiry to
**info@mswe.in** through Titan Mail's SMTP server (`smtp.titan.email`). The
visitor's address is set as *Reply-To*, so pressing **Reply** in Titan answers them.

## One-time setup

1. **Upload the site** to `public_html` as usual, including the `api/` folder
   (`contact.php`, `.htaccess`, `mail-config.sample.php`).
2. **PHP version:** cPanel → *Select PHP Version* → **7.4 or newer** (8.x recommended).
3. **Create the real config file, outside the public folder:**
   - cPanel → *File Manager* → go to your **home folder** (the one that *contains* `public_html`).
   - Copy `public_html/api/mail-config.sample.php` there and rename it to **`mswe-mail-config.php`**.
   - Edit it and set `'smtp_pass'` to the **info@mswe.in** mailbox password.
   - This file is never inside `public_html`, so it can't be downloaded, and it is git-ignored.
4. **Domains:** if the site is not yet on `https://mswe.in`, add the address you are
   testing on to `'allowed_origins'` in that file, for example `'https://your-temp-domain.com'`.
   Submissions from any other website are rejected.

## Test it

Open the live site, fill in the form and press **Send Message**. You should see
"Thanks …! Your message has been sent." and the email should arrive in info@mswe.in
within a minute. Check the spam folder the first time.

## If it doesn't work

| Message the visitor sees | Cause | Fix |
|---|---|---|
| "Our contact form is being set up…" | config file not found, or `smtp_pass` empty | step 3: check the file name and location |
| "Sorry, we could not send your message…" | SMTP problem | see the error log (cPanel → *Errors*, or `error_log` in `public_html/api/`): lines start with `[mswe-contact]` |
| "This form can only be submitted from the MSWE website." | domain not in `allowed_origins` | step 4 |

Common SMTP errors in the log:

- `AUTH password failed`: wrong mailbox password in the config file.
- `connect ... failed`: GoDaddy blocked port 465. In the config set
  `'smtp_port' => 587` and `'smtp_secure' => 'tls'`.

## Built-in protection

- Hidden "honeypot" field silently drops simple spam bots.
- At most 5 messages per visitor IP every 10 minutes.
- All fields are validated again on the server; topics must be one of the five offered.
- Only the form's own website can submit; the mailbox password never reaches the browser.
