<?php
/**
 * MSWE website contact form endpoint.
 *
 * Receives the JSON posted by the contact form on index.html, validates it,
 * and emails it to info@mswe.in through Titan Mail (GoDaddy) SMTP.
 *
 * The SMTP password is NOT in this file. It is read from a config file that
 * lives OUTSIDE the public web folder (see api/mail-config.sample.php).
 */

declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-store');

// Topic values the form is allowed to send (must match <select id="cf-topics">).
const ALLOWED_TOPICS = [
    'Cybersecurity',
    'AI Agents & Solutions',
    'GaaS (Governance-as-a-Service)',
    'SaaS & Enterprise Development',
    'Industry Experts & Training',
];

const RATE_LIMIT_MAX    = 5;    // submissions allowed ...
const RATE_LIMIT_WINDOW = 600;  // ... per IP in this many seconds (10 min)
const MAX_BODY_BYTES    = 20000;

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function respond(int $status, string $message): void
{
    http_response_code($status);
    echo json_encode(['message' => $message], JSON_UNESCAPED_UNICODE);
    exit;
}

function load_config(): array
{
    $defaults = [
        'smtp_host'       => 'smtp.titan.email',
        'smtp_port'       => 465,
        'smtp_secure'     => 'ssl',            // 'ssl' (port 465) or 'tls' (STARTTLS, port 587)
        'smtp_user'       => 'info@mswe.in',
        'smtp_pass'       => '',
        'mail_to'         => 'info@mswe.in',
        'mail_from'       => 'info@mswe.in',   // Titan only sends as the logged-in mailbox
        'mail_from_name'  => 'MSWE Website',
        'allowed_origins' => ['https://mswe.in', 'https://www.mswe.in'],
    ];

    // 1) path from an environment variable, 2) one level above the web root
    //    (recommended), 3) next to this script (protected by api/.htaccess).
    $candidates = [
        (string) getenv('MSWE_MAIL_CONFIG'),
        dirname(__DIR__, 2) . '/mswe-mail-config.php',
        __DIR__ . '/mail-config.php',
    ];
    foreach ($candidates as $file) {
        if ($file !== '' && is_file($file)) {
            $cfg = require $file;
            if (is_array($cfg)) {
                return array_merge($defaults, $cfg);
            }
        }
    }
    return $defaults;
}

/** One line of text: trims, removes control characters (stops header injection). */
function clean_line($value, int $max): string
{
    $value = is_string($value) ? $value : '';
    $value = preg_replace('/[\x00-\x1F\x7F]+/u', ' ', $value) ?? '';
    return mb_substr(trim($value), 0, $max);
}

/** Multi-line text: keeps line breaks, removes other control characters. */
function clean_text($value, int $max): string
{
    $value = is_string($value) ? $value : '';
    $value = str_replace(["\r\n", "\r"], "\n", $value);
    $value = preg_replace('/[\x00-\x08\x0B-\x1F\x7F]+/u', '', $value) ?? '';
    return mb_substr(trim($value), 0, $max);
}

function client_ip(): string
{
    return (string) ($_SERVER['REMOTE_ADDR'] ?? 'unknown');
}

/** Simple per-IP limit using a small file in the system temp folder. */
function rate_limited(string $ip): bool
{
    $file = sys_get_temp_dir() . '/mswe_contact_' . sha1($ip);
    $now  = time();
    $hits = [];
    if (is_file($file)) {
        $hits = array_filter(
            array_map('intval', explode(',', (string) file_get_contents($file))),
            fn ($t) => $t > $now - RATE_LIMIT_WINDOW
        );
    }
    if (count($hits) >= RATE_LIMIT_MAX) {
        return true;
    }
    $hits[] = $now;
    @file_put_contents($file, implode(',', $hits), LOCK_EX);
    return false;
}

function encode_header(string $text): string
{
    return preg_match('/[^\x20-\x7E]/', $text)
        ? '=?UTF-8?B?' . base64_encode($text) . '?='
        : $text;
}

/** Display name for From/Reply-To: encoded if non-ASCII, quoted if it has special characters. */
function display_name(string $name): string
{
    if (preg_match('/[^\x20-\x7E]/', $name)) {
        return encode_header($name);
    }
    if (preg_match('/[()<>\[\]:;@\\\\,."]/', $name)) {
        return '"' . addcslashes($name, '"\\') . '"';
    }
    return $name;
}

/* ------------------------------------------------------------------ */
/* minimal SMTP client (Titan: smtp.titan.email, 465/SSL or 587/TLS)   */
/* ------------------------------------------------------------------ */

function smtp_read($fp): array
{
    $text = '';
    while (($line = fgets($fp, 1024)) !== false) {
        $text .= $line;
        if (strlen($line) < 4 || $line[3] === ' ') {
            break;
        }
    }
    if ($text === '') {
        throw new RuntimeException('SMTP: no response from server');
    }
    return [(int) substr($text, 0, 3), trim($text)];
}

function smtp_cmd($fp, string $command, array $expect, string $label = ''): string
{
    if ($command !== '') {
        fwrite($fp, $command . "\r\n");
    }
    [$code, $text] = smtp_read($fp);
    if (!in_array($code, $expect, true)) {
        // never log the command itself: it may be the base64 password
        throw new RuntimeException('SMTP ' . ($label ?: strtok($command, ' ')) . " failed: $text");
    }
    return $text;
}

function smtp_send(array $cfg, string $to, string $subject, string $body, string $replyTo, string $replyName): void
{
    $host   = (string) $cfg['smtp_host'];
    $port   = (int) $cfg['smtp_port'];
    $secure = (string) $cfg['smtp_secure'];

    $context = stream_context_create(['ssl' => [
        'verify_peer'      => true,
        'verify_peer_name' => true,
        'peer_name'        => $host,
    ]]);
    $scheme = $secure === 'ssl' ? 'ssl' : 'tcp';
    $fp = @stream_socket_client("$scheme://$host:$port", $errno, $errstr, 15, STREAM_CLIENT_CONNECT, $context);
    if (!$fp) {
        throw new RuntimeException("SMTP connect to $host:$port failed: $errstr ($errno)");
    }
    stream_set_timeout($fp, 15);

    try {
        $ehloHost = preg_replace('/[^A-Za-z0-9.\-]/', '', (string) ($_SERVER['SERVER_NAME'] ?? 'mswe.in')) ?: 'mswe.in';

        smtp_cmd($fp, '', [220], 'greeting');
        smtp_cmd($fp, "EHLO $ehloHost", [250]);

        if ($secure === 'tls') {
            smtp_cmd($fp, 'STARTTLS', [220]);
            if (!stream_socket_enable_crypto($fp, true, STREAM_CRYPTO_METHOD_TLSv1_2_CLIENT | STREAM_CRYPTO_METHOD_TLSv1_3_CLIENT)) {
                throw new RuntimeException('SMTP: STARTTLS negotiation failed');
            }
            smtp_cmd($fp, "EHLO $ehloHost", [250]);
        }

        smtp_cmd($fp, 'AUTH LOGIN', [334]);
        smtp_cmd($fp, base64_encode((string) $cfg['smtp_user']), [334], 'AUTH user');
        smtp_cmd($fp, base64_encode((string) $cfg['smtp_pass']), [235], 'AUTH password');

        $from = (string) $cfg['mail_from'];
        smtp_cmd($fp, "MAIL FROM:<$from>", [250]);
        smtp_cmd($fp, "RCPT TO:<$to>", [250, 251]);
        smtp_cmd($fp, 'DATA', [354]);

        $headers = [
            'Date: ' . date('r'),
            'From: ' . display_name((string) $cfg['mail_from_name']) . " <$from>",
            "To: <$to>",
            'Reply-To: ' . display_name($replyName) . " <$replyTo>",
            'Subject: ' . encode_header($subject),
            'Message-ID: <' . bin2hex(random_bytes(12)) . '@mswe.in>',
            'MIME-Version: 1.0',
            'Content-Type: text/plain; charset=UTF-8',
            'Content-Transfer-Encoding: base64',
            'X-Mailer: MSWE website contact form',
        ];
        // base64 body: lines never start with "." so no dot-stuffing is needed
        $data = implode("\r\n", $headers) . "\r\n\r\n"
              . rtrim(chunk_split(base64_encode($body), 76, "\r\n")) . "\r\n.";
        smtp_cmd($fp, $data, [250], 'message body');
        @fwrite($fp, "QUIT\r\n");
    } finally {
        fclose($fp);
    }
}

/* ------------------------------------------------------------------ */
/* request handling                                                    */
/* ------------------------------------------------------------------ */

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    header('Allow: POST');
    respond(405, 'Method not allowed.');
}

$config = load_config();

// Only accept posts from the MSWE site itself (browsers always send Origin on POST).
$origin = (string) ($_SERVER['HTTP_ORIGIN'] ?? '');
$allowed = (array) $config['allowed_origins'];
if ($origin !== '' && $allowed && !in_array(rtrim($origin, '/'), $allowed, true)) {
    respond(403, 'This form can only be submitted from the MSWE website.');
}

$raw = (string) file_get_contents('php://input', false, null, 0, MAX_BODY_BYTES + 1);
if (strlen($raw) > MAX_BODY_BYTES) {
    respond(413, 'Your message is too long.');
}
$in = json_decode($raw, true);
if (!is_array($in)) {
    respond(400, 'Invalid request.');
}

// Honeypot: real visitors never see or fill the "website" field. Pretend success for bots.
if (trim((string) ($in['website'] ?? '')) !== '') {
    respond(200, 'Your message has been sent successfully.');
}

$name     = clean_line($in['name'] ?? '', 100);
$email    = clean_line($in['email'] ?? '', 150);
$company  = clean_line($in['company'] ?? '', 150);
$position = clean_line($in['position'] ?? '', 100);
$phone    = clean_line($in['phone'] ?? '', 25);
$message  = clean_text($in['message'] ?? '', 2000);
$topics   = array_values(array_intersect(
    array_map('strval', is_array($in['topics'] ?? null) ? $in['topics'] : []),
    ALLOWED_TOPICS
));

$errors = [];
if (mb_strlen($name) < 2)                                $errors[] = 'Please enter your name.';
if (!filter_var($email, FILTER_VALIDATE_EMAIL))          $errors[] = 'Please enter a valid email address.';
if ($company === '')                                     $errors[] = 'Please enter your company name.';
if (!preg_match('/^\+?[0-9][0-9 ()\-]{5,23}$/', $phone)) $errors[] = 'Please enter a valid mobile number.';
if (!$topics)                                            $errors[] = 'Please select at least one topic.';
if (mb_strlen($message) < 10)                            $errors[] = 'Please enter a message of at least 10 characters.';
if ($errors) {
    respond(422, $errors[0]);
}

if (rate_limited(client_ip())) {
    respond(429, 'Too many messages from your connection. Please try again in a few minutes, or email info@mswe.in.');
}

if ((string) $config['smtp_pass'] === '') {
    error_log('[mswe-contact] SMTP password not configured - see api/mail-config.sample.php');
    respond(503, 'Our contact form is being set up. Please email us directly at info@mswe.in.');
}

$subject = 'Website enquiry: ' . $name . ($company !== '' ? " - $company" : '');
$body = "New enquiry from the MSWE website\n"
      . "=================================\n\n"
      . "Name:     $name\n"
      . "Email:    $email\n"
      . "Company:  $company\n"
      . 'Position: ' . ($position !== '' ? $position : '-') . "\n"
      . "Phone:    $phone\n"
      . 'Topics:   ' . implode(', ', $topics) . "\n\n"
      . "Message:\n$message\n\n"
      . "--\n"
      . 'Sent ' . date('D, d M Y H:i T') . ' from ' . ($origin !== '' ? $origin : 'the website')
      . ' | IP ' . client_ip() . "\n"
      . "Reply to this email to answer $name directly.\n";

try {
    smtp_send($config, (string) $config['mail_to'], $subject, $body, $email, $name);
} catch (Throwable $e) {
    error_log('[mswe-contact] ' . $e->getMessage());
    respond(502, 'Sorry, we could not send your message right now. Please try again, or email info@mswe.in.');
}

$first = explode(' ', $name)[0];
respond(200, "Thanks $first! Your message has been sent. We'll reply within one business day.");
