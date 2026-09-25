#!/usr/bin/env node
// Relaytor Core — Phase 1. Localhost-only HTTP bridge. Zero dependencies.
// Approved plan: §3 API, §4 state model, §5 in-memory storage, §8 security.

'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const HOST = '127.0.0.1';            // §8: loopback-only binding
const PORT = 5000;
const MAX_BODY = 256 * 1024;          // §8: 256 KB absolute body cap
const MAX_TEXT = 50_000;              // §3.2: task text cap
const RE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TASK_TTL_MS = 30 * 60 * 1000;   // §5: GC after 30 min untouched

// ---------- config / token (§8) ----------
const CONFIG_PATH = path.join(__dirname, 'config.json');
function loadToken() {
  let cfg = null;
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (_) { /* first run */ }
  if (cfg && typeof cfg.token === 'string' && cfg.token.length >= 16) return cfg.token;
  const token = crypto.randomBytes(24).toString('base64url');
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ token, note: 'generated on first run' }, null, 2));
  console.log('[relaytor] generated new bearer token (saved to server/config.json):');
  console.log('  ' + token);
  return token;
}
const TOKEN = loadToken();

// ---------- in-memory task store (§5) ----------
// tasks: Map<requestId, task>. Lost on restart by design; clients treat 404 as
// the explicit restart/lost-task signal (§9) — the extension surfaces it, never guesses.
const tasks = new Map();
const pendingQueue = [];             // FIFO of requestIds in status 'sent'

// ---------- pure logic (unit-tested via tests/core.unit.test.js) ----------
const VALID_TRANSITIONS = {
  sent:    ['working', 'failed'],
  working: ['completed', 'failed'],
};

function validateTaskPayload(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body))
    return { error: 'body must be a JSON object' };
  if (typeof body.text !== 'string' || !body.text.trim())
    return { error: 'text must be a non-empty string' };
  if (body.text.length > MAX_TEXT)
    return { error: 'text exceeds 50000 chars' };
  return { text: body.text.trim() };
}

function newTask(text) {
  const id = crypto.randomUUID();     // §4: UUID v4, server-issued
  const now = new Date().toISOString();
  const task = { requestId: id, text, timestamp: now, status: 'sent',
                 createdAt: now, updatedAt: now,
                 summary: '', error: '', filesChanged: [], suggestedFollowUp: '' };
  tasks.set(id, task);
  pendingQueue.push(id);
  return task;
}

function applyAgentStatus(task, msg) {
  if (!msg || typeof msg !== 'object') return { error: 'invalid message' };
  const { requestId, status } = msg;
  if (typeof requestId !== 'string' || !RE_ID.test(requestId))
    return { error: 'invalid requestId' };
  if (status === 'working') {
    const allowed = VALID_TRANSITIONS[task.status];
    if (!allowed || !allowed.includes('working'))
      return { error: `illegal transition ${task.status} -> working` };
    task.status = 'working';
  } else if (status === 'completed') {
    const allowed = VALID_TRANSITIONS[task.status];
    if (!allowed || !allowed.includes('completed'))
      return { error: `illegal transition ${task.status} -> completed` };
    if (typeof msg.summary !== 'string' || !msg.summary.trim())
      return { error: 'completed requires a non-empty summary' };
    if (msg.filesChanged !== undefined && !Array.isArray(msg.filesChanged))
      return { error: 'filesChanged must be an array' };
    task.status = 'completed';
    task.summary = msg.summary;
    task.filesChanged = msg.filesChanged || [];
    task.suggestedFollowUp = typeof msg.suggestedFollowUp === 'string' ? msg.suggestedFollowUp : '';
  } else if (status === 'failed') {
    const allowed = VALID_TRANSITIONS[task.status];
    if (!allowed || !allowed.includes('failed'))
      return { error: `illegal transition ${task.status} -> failed` };
    if (typeof msg.error !== 'string' || !msg.error.trim())
      return { error: 'failed requires a non-empty error' };
    task.status = 'failed';
    task.summary = typeof msg.summary === 'string' ? msg.summary : '';
    task.error = msg.error;
    task.filesChanged = Array.isArray(msg.filesChanged) ? msg.filesChanged : [];
  } else {
    return { error: 'status must be working | completed | failed' };
  }
  task.updatedAt = new Date().toISOString();
  return {};
}

function claimNext() {
  while (pendingQueue.length) {
    const id = pendingQueue[0];
    const t = tasks.get(id);
    if (!t || t.status !== 'sent') { pendingQueue.shift(); continue; }
    return { task: { requestId: t.requestId, text: t.text, timestamp: t.timestamp } };
  }
  return { task: null };
}

function gcStale() {
  const now = Date.now();
  for (const [id, t] of tasks) {
    if (now - Date.parse(t.updatedAt) > TASK_TTL_MS) {
      tasks.delete(id);
      const qi = pendingQueue.indexOf(id);
      if (qi !== -1) pendingQueue.splice(qi, 1);
    }
  }
}
setInterval(gcStale, 60_000).unref();

// ---------- HTTP plumbing ----------
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json',
                         'Content-Length': Buffer.byteLength(body),
                         'Cache-Control': 'no-store' });   // §3: no-store on all responses
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {           // §8: kill request past cap, never buffer
        req.destroy();
        resolve({ error: 413, message: 'body exceeds 262144 bytes' });
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve({ buf: Buffer.concat(chunks) }));
    req.on('error', () => resolve({ error: 400, message: 'request aborted' }));
  });
}

function authorized(req) {             // §8: timing-safe bearer compare
  const h = req.headers['authorization'] || '';
  const m = /^Bearer (.+)$/.exec(h);
  if (!m) return false;
  const a = Buffer.from(m[1]), b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const p = url.pathname;

  // §3.1 health — no auth, liveness only
  if (p === '/health' && req.method === 'GET') return send(res, 200, { ok: true });

  // §3 global: bearer token required on all /v1/*
  if (p.startsWith('/v1/') && !authorized(req)) {
    const body = JSON.stringify({ error: 'missing or invalid bearer token' });
    res.writeHead(401, { 'Content-Type': 'application/json',
                         'Content-Length': Buffer.byteLength(body),
                         'Cache-Control': 'no-store',
                         'WWW-Authenticate': 'Bearer' });
    return res.end(body);
  }

  // §3.2 POST /v1/task
  if (p === '/v1/task' && req.method === 'POST') {
    const b = await readBody(req);
    if (b.error) return send(res, b.error, { error: b.message });
    let body;
    try { body = JSON.parse(b.buf.toString('utf8')); } catch (_) { return send(res, 400, { error: 'invalid JSON' }); }
    const v = validateTaskPayload(body);
    if (v.error) return send(res, v.error === 'text exceeds 50000 chars' ? 413 : 400, { error: v.error });
    const t = newTask(v.text);
    return send(res, 201, { requestId: t.requestId, status: t.status });
  }

  // §3.3 GET /v1/task/:requestId
  const mGet = /^\/v1\/task\/([0-9a-f-]{36})$/.exec(p);
  if (mGet && req.method === 'GET') {
    if (!RE_ID.test(mGet[1])) return send(res, 400, { error: 'invalid requestId' });
    const t = tasks.get(mGet[1]);
    if (!t) return send(res, 404, { error: 'unknown requestId (task may have been acked, expired, or server restarted)' });
    return send(res, 200, t);
  }

  // §3.4 POST /v1/task/:requestId/ack
  const mAck = /^\/v1\/task\/([0-9a-f-]{36})\/ack$/.exec(p);
  if (mAck && req.method === 'POST') {
    if (!tasks.delete(mAck[1])) return send(res, 404, { error: 'unknown requestId' });
    const qi = pendingQueue.indexOf(mAck[1]);
    if (qi !== -1) pendingQueue.splice(qi, 1);
    return send(res, 200, { acknowledged: mAck[1] });
  }

  // §3.5 POST /v1/agent/claim
  if (p === '/v1/agent/claim' && req.method === 'POST')
    return send(res, 200, claimNext());

  // §3.6 POST /v1/agent/status
  if (p === '/v1/agent/status' && req.method === 'POST') {
    const b = await readBody(req);
    if (b.error) return send(res, b.error, { error: b.message });
    let msg;
    try { msg = JSON.parse(b.buf.toString('utf8')); } catch (_) { return send(res, 400, { error: 'invalid JSON' }); }
    if (!msg || typeof msg !== 'object' || typeof msg.requestId !== 'string' || !RE_ID.test(msg.requestId))
      return send(res, 400, { error: 'invalid requestId' });
    const t = tasks.get(msg.requestId);
    if (!t) return send(res, 404, { error: 'unknown requestId (task acked, expired, or server restarted)' });
    const err = applyAgentStatus(t, msg);
    if (err.error) return send(res, 409, err);
    return send(res, 200, { requestId: t.requestId, status: t.status });
  }

  return send(res, 404, { error: 'not found' });
});

server.listen(PORT, HOST, () => {
  console.log(`[relaytor] core listening on http://${HOST}:${PORT} (localhost only)`);
});
