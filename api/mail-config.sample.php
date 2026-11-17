<?php
/**
 * TEMPLATE for the contact form's mail settings. Contains NO password.
 *
 * On the GoDaddy server (cPanel > File Manager):
 *   1. Copy this file to the folder ABOVE public_html, i.e. your home folder:
 *        /home/<your-cpanel-user>/mswe-mail-config.php
 *      (outside the public web folder, so it can never be downloaded)
 *   2. Put the info@mswe.in mailbox password in 'smtp_pass' below.
 *   3. Never commit the real file to git.
 *
 * Titan Mail SMTP: smtp.titan.email, port 465 (SSL). If GoDaddy blocks 465,
 * use port 587 with 'smtp_secure' => 'tls'.
 */

return [
    'smtp_host'   => 'smtp.titan.email',
    'smtp_port'   => 465,
    'smtp_secure' => 'ssl',
    'smtp_user'   => 'info@mswe.in',
    'smtp_pass'   => '',               // <-- the info@mswe.in mailbox password goes here, on the server only

    'mail_to'        => 'info@mswe.in', // where enquiries are delivered
    'mail_from'      => 'info@mswe.in', // must be the same mailbox as smtp_user (Titan rule)
    'mail_from_name' => 'MSWE Website',

    // Sites allowed to submit the form. Add your temporary GoDaddy domain here while testing.
    'allowed_origins' => ['https://mswe.in', 'https://www.mswe.in'],
];
