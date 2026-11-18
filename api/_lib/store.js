/**
 * Newsletter subscriber list, stored in Upstash Redis (Vercel → Storage → Upstash
 * for Redis). Talks to Redis over its REST API with fetch, so no npm packages.
 *
 * Vercel adds the connection settings automatically when the database is
 * connected to the project: KV_REST_API_URL + KV_REST_API_TOKEN (or the
 * UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN names).
 *
 * Keys:
 *   newsletter:subscribers   hash  email -> JSON {email, subscribedAt, source, id}
 *   newsletter:unsub         hash  id    -> email   (id is the secret in unsubscribe links)
 *   newsletter:sends         list  JSON {subject, at, sent, failed}  (latest 50)
 */

'use strict';

const crypto = require('crypto');

const SUBS = 'newsletter:subscribers';
const UNSUB = 'newsletter:unsub';
const SENDS = 'newsletter:sends';

function redisSettings(env = process.env) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL || '';
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN || '';
  return url && token ? { url: url.replace(/\/+$/, ''), token } : null;
}

/* ---- backends ------------------------------------------------------ */

function redisBackend({ url, token }) {
  return async function redis(command) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(command),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.error) {
      const e = new Error(`Redis ${command[0]} failed: ${data.error || r.status}`);
      e.code = 'store_error';
      throw e;
    }
    return data.result;
  };
}

/** In-memory stand-in for local testing only (NEWSLETTER_STORE=memory). */
function memoryBackend() {
  const hashes = new Map();
  const lists = new Map();
  const h = (k) => hashes.get(k) || hashes.set(k, new Map()).get(k);
  const l = (k) => lists.get(k) || lists.set(k, []).get(k);
  return async function redis([cmd, key, ...args]) {
    switch (cmd) {
      case 'HSETNX': if (h(key).has(args[0])) return 0; h(key).set(args[0], args[1]); return 1;
      case 'HSET': h(key).set(args[0], args[1]); return 1;
      case 'HGET': return h(key).has(args[0]) ? h(key).get(args[0]) : null;
      case 'HDEL': return h(key).delete(args[0]) ? 1 : 0;
      case 'HGETALL': return [...h(key)].flat();
      case 'HLEN': return h(key).size;
      case 'LPUSH': l(key).unshift(args[0]); return l(key).length;
      case 'LTRIM': lists.set(key, l(key).slice(Number(args[0]), Number(args[1]) + 1)); return 'OK';
      case 'LRANGE': return l(key).slice(Number(args[0]), Number(args[1]) + 1);
      default: throw new Error(`memory store: ${cmd} not supported`);
    }
  };
}

let memory;
function getStore(env = process.env) {
  let redis;
  if (env.NEWSLETTER_STORE === 'memory') redis = memory || (memory = memoryBackend());
  else {
    const settings = redisSettings(env);
    if (!settings) return null; // database not connected yet
    redis = redisBackend(settings);
  }

  return {
    /** Adds a subscriber. Returns {added: true, sub} or {added: false} if already subscribed. */
    async add(email, source) {
      const key = email.toLowerCase();
      const sub = { email, subscribedAt: new Date().toISOString(), source, id: crypto.randomBytes(16).toString('hex') };
      const added = await redis(['HSETNX', SUBS, key, JSON.stringify(sub)]);
      if (!added) return { added: false };
      await redis(['HSET', UNSUB, sub.id, key]);
      return { added: true, sub };
    },
    async get(email) {
      const v = await redis(['HGET', SUBS, email.toLowerCase()]);
      return v ? JSON.parse(v) : null;
    },
    async remove(email) {
      const sub = await this.get(email);
      if (!sub) return false;
      await redis(['HDEL', SUBS, email.toLowerCase()]);
      await redis(['HDEL', UNSUB, sub.id]);
      return true;
    },
    /** Unsubscribe by the secret id from an email link. Returns the email, or null. */
    async removeById(id) {
      if (!/^[a-f0-9]{32}$/.test(String(id))) return null;
      const key = await redis(['HGET', UNSUB, id]);
      if (!key) return null;
      await redis(['HDEL', SUBS, key]);
      await redis(['HDEL', UNSUB, id]);
      return key;
    },
    /** All subscribers, oldest first. */
    async list() {
      const flat = (await redis(['HGETALL', SUBS])) || [];
      const out = [];
      for (let i = 1; i < flat.length; i += 2) out.push(JSON.parse(flat[i]));
      return out.sort((a, b) => a.subscribedAt.localeCompare(b.subscribedAt));
    },
    async logSend(entry) {
      await redis(['LPUSH', SENDS, JSON.stringify({ ...entry, at: new Date().toISOString() })]);
      await redis(['LTRIM', SENDS, '0', '49']);
    },
    async sends() {
      return ((await redis(['LRANGE', SENDS, '0', '49'])) || []).map((s) => JSON.parse(s));
    },
  };
}

module.exports = { getStore, redisSettings };
