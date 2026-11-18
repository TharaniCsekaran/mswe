# Contact form + newsletter: setup on Vercel with Titan Mail

The form on `index.html` posts to **`/api/contact`**. On Vercel, `api/contact.js`
runs automatically as a serverless function. It validates the enquiry and emails
it to **info@mswe.in** through GoDaddy's SMTP server for Titan mailboxes (`smtpout.secureserver.net`).
The visitor's address is set as *Reply-To*, so pressing **Reply** in Titan answers them.

No npm packages are needed: the function uses only Node's built-in modules.

## One-time setup

1. **Deploy the site to Vercel** as usual (the `api/` folder must be included).
2. **Add the mailbox password as an environment variable:**
   Vercel → your project → **Settings → Environment Variables** → *Add*:

   | Name | Value | Environments |
   |---|---|---|
   | `SMTP_PASS` | the **info@mswe.in** mailbox password | Production (and Preview if you test there) |

   Mark it **Sensitive**. It is stored encrypted by Vercel and never reaches the browser or git.
3. **Redeploy** (Deployments → ⋯ → *Redeploy*) so the new variable is picked up.

That's it. Everything else has working defaults.

### Optional settings (only if you need to change a default)

| Variable | Default | When to change |
|---|---|---|
| `SMTP_PORT` / `SMTP_SECURE` | `465` / `ssl` | if port 465 is ever blocked, use `587` / `tls` |
| `MAIL_TO` | `info@mswe.in` | deliver enquiries to a different inbox |
| `SMTP_USER`, `MAIL_FROM` | `info@mswe.in` | sending from a different Titan mailbox (both must match) |
| `ALLOWED_ORIGINS` | `https://mswe.in,https://www.mswe.in` | the site moves to another domain. Vercel's own `*.vercel.app` URLs for this project are always allowed. |

## Server region

`vercel.json` runs the function in Vercel's **Mumbai** region (`bom1`), so Titan sees
logins to info@mswe.in coming from India (fewer "suspicious sign-in" blocks) and
Indian visitors get a faster response. After deploying, check the `x-vercel-id`
response header: its **second** part is where the function ran. It should read
`bom1::bom1::...` (before this change it was `bom1::iad1::...`, i.e. Washington).

## Test it

Open the live site, fill in the form and press **Send Message**. You should see
"Thanks …! Your message has been sent." and the email should arrive in info@mswe.in
within a minute. Check the spam folder the first time.

**Deliverability:** mswe.in's mail is hosted by GoDaddy, so keep GoDaddy's records in
the DNS (Vercel → Domains → mswe.in → DNS): **MX** `smtp.secureserver.net` (0) and
`mailstore1.secureserver.net` (10), and **SPF** TXT `v=spf1 include:secureserver.net -all`.

**Check the login from your own computer** (same code as the form, the password is typed hidden):
`node tools/check-titan-login.js`. If it fails there too, the problem is the password or the
mailbox, not Vercel.

## If it doesn't work

| Message the visitor sees | Cause | Fix |
|---|---|---|
| "Our contact form is being set up…" | `SMTP_PASS` missing | step 2, then redeploy |
| "Sorry, we could not send your message…" | SMTP problem | Vercel → project → **Logs**: lines start with `[mswe-contact]` |
| "This form can only be submitted from the MSWE website." | site served from a domain not in `ALLOWED_ORIGINS` | add it to `ALLOWED_ORIGINS` |

When sending fails (HTTP 502), the response also carries a short `code`, visible in the
browser: DevTools → **Network** → `contact` → **Response**. It has the same meaning as the log line:

| `code` | Log line | Fix |
|---|---|---|
| `smtp_auth` | `SMTP AUTH password failed` | `SMTP_PASS` is wrong. Use the **info@mswe.in mailbox password** (the one you use at secureserver.titan.email), not your GoDaddy account password. Re-enter it, check it's set for **Production**, then **Redeploy**. |
| `smtp_timeout` / `smtp_connect` | `SMTP timeout` / `SMTP connection error` | set `SMTP_PORT=587` and `SMTP_SECURE=tls`, then redeploy |
| `smtp_rejected` | `SMTP MAIL FROM/RCPT TO failed` | `SMTP_USER` and `MAIL_FROM` must both be `info@mswe.in` |

## Built-in protection

- Hidden "honeypot" field silently drops simple spam bots.
- At most 5 messages per visitor IP every 10 minutes (per running instance).
- All fields are validated again on the server; topics must be one of the options offered, and "Others" needs its text filled in.
- Line breaks are stripped from single-line fields, so nobody can inject extra email headers.
- Only the MSWE site can submit; the mailbox password never reaches the browser and is never logged.

---

# Newsletter

* **Subscribe** (home page form) → `api/subscribe.js` saves the address and sends a
  **welcome email** from info@mswe.in.
* **Admin page** `https://www.mswe.in/admin.html` → write a case study, preview it,
  send a test to info@mswe.in, then send it to every subscriber (`api/admin.js`).
* **Unsubscribe** → every email has a personal unsubscribe link (`api/unsubscribe.js`)
  and the one-click unsubscribe headers Gmail and Outlook show as a button.

## One-time setup

1. **Subscriber database:** Vercel → your project → **Storage** → *Create Database* →
   **Upstash for Redis** (free plan) → connect it to this project (all environments).
   Vercel adds `KV_REST_API_URL` and `KV_REST_API_TOKEN` automatically.
2. **Admin password:** Settings → Environment Variables → add `ADMIN_PASSWORD` (Production),
   a long password only the admin knows. Mark it **Sensitive**.
3. **Redeploy.**

`SMTP_PASS` (from the contact form setup) is used for these emails too.

## Sending a case study

1. Open `/admin.html`, sign in with `ADMIN_PASSWORD`.
2. Fill in subject, headline and text. A short first line such as *The challenge* becomes a
   heading; lines starting with `- ` become bullet points. Button and image links are optional
   (must start with `https://`).
3. **Preview**, then **Send test** and check info@mswe.in.
4. **Send to all subscribers.** Emails go out in batches of 25 with a progress bar; anyone the
   mail server refuses is listed at the end. Keep the page open until it says *Done*.

GoDaddy limits how many emails one mailbox can send per day. That is fine for a growing list;
if the list reaches several hundred, move sending to a newsletter service.

| Message | Cause | Fix |
|---|---|---|
| "Newsletter sign-up is being set up" / `store_not_configured` | database not connected | step 1, then redeploy |
| "The admin page is not set up yet" | `ADMIN_PASSWORD` missing | step 2, then redeploy |
| "Wrong admin password" | typo | after 10 wrong tries, wait 15 minutes |
| "You're subscribed! (We couldn't send the welcome email…)" | SMTP problem | see the `code` table above |

---

# Careers applications

The **Apply now** button in the Careers section opens a popup form that posts to `api/careers.js`, which emails the
application to **pmo@mswe.in** with the resume attached (Reply-To is the applicant, so
**Reply** answers them). The applicant also gets a short "we received your application"
email from info@mswe.in.

* Resume: PDF, DOC or DOCX, up to 3 MB. The file's content is checked, not just its name.
* Fields: name, email, phone, location, area of interest, experience, LinkedIn/portfolio,
  message, and a required consent tick for storing their details.
* Uses the same `SMTP_PASS` as the contact form; nothing else to set up.
* To deliver applications to a different inbox, set `CAREERS_TO` (e.g. `hr@mswe.in`).
