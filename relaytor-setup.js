// relaytor-setup.js — creates the complete Relaytor Phase 1 project.
// Run:  node relaytor-setup.js
// Then: node relaytor/server/relaytor-core.js
//
// This script writes the same 11 files delivered in the implementation audit.
// It contains ONLY Node built-ins (fs/path) and adds no dependency to the project.

'use strict';
const fs = require('node:fs');
const path = require('node:path');

const FILES = {
  'server/relaytor-core.js': `#!/usr/bin/env node
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
      return { error: \`illegal transition \${task.status} -> working\` };
    task.status = 'working';
  } else if (status === 'completed') {
    const allowed = VALID_TRANSITIONS[task.status];
    if (!allowed || !allowed.includes('completed'))
      return { error: \`illegal transition \${task.status} -> completed\` };
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
      return { error: \`illegal transition \${task.status} -> failed\` };
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
  const url = new URL(req.url, \`http://\${HOST}:\${PORT}\`);
  const p = url.pathname;

  // §3.1 health — no auth, liveness only
  if (p === '/health' && req.method === 'GET') return send(res, 200, { ok: true });

  // §3 global: bearer token required on all /v1/*
  if (p.startsWith('/v1/') && !authorized(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Bearer' });
    return send(res, 401, { error: 'missing or invalid bearer token' });
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
  const mGet = /^\\/v1\\/task\\/([0-9a-f-]{36})$/.exec(p);
  if (mGet && req.method === 'GET') {
    if (!RE_ID.test(mGet[1])) return send(res, 400, { error: 'invalid requestId' });
    const t = tasks.get(mGet[1]);
    if (!t) return send(res, 404, { error: 'unknown requestId (task may have been acked, expired, or server restarted)' });
    return send(res, 200, t);
  }

  // §3.4 POST /v1/task/:requestId/ack
  const mAck = /^\\/v1\\/task\\/([0-9a-f-]{36})\\/ack$/.exec(p);
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
    if (err) return send(res, 409, err);
    return send(res, 200, { requestId: t.requestId, status: t.status });
  }

  return send(res, 404, { error: 'not found' });
});

server.listen(PORT, HOST, () => {
  console.log(\`[relaytor] core listening on http://\${HOST}:\${PORT} (localhost only)\`);
});
`,

  'agent/test-agent.js': `#!/usr/bin/env node
// Relaytor test agent — Phase 1 reference implementation of the approved agent
// protocol (plan §7): claim -> working -> completed/failed.
// This is NOT native Cline/Cursor/Roo/Copilot integration.
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const HOST = '127.0.0.1', PORT = 5000;
const TOKEN = process.env.RELAYTOR_TOKEN;
const MODE = (process.argv.find(a => a.startsWith('--mode=')) || '--mode=completed').split('=')[1];

if (!TOKEN) { console.error('Set RELAYTOR_TOKEN env var'); process.exit(1); }

function call(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: HOST, port: PORT, method, path: urlPath, headers: {
      'Authorization': 'Bearer ' + TOKEN,
      ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
    }}, res => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => {
        const json = out ? JSON.parse(out) : {};
        if (res.statusCode >= 400) return reject(new Error(\`HTTP \${res.statusCode}: \${json.error || out}\`));
        resolve(json);
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  const { task } = await call('POST', '/v1/agent/claim');
  if (!task) { console.log('[agent] no pending tasks'); return; }
  console.log('[agent] claimed task', task.requestId, '\\n---\\n' + task.text + '\\n---');

  await call('POST', '/v1/agent/status', { requestId: task.requestId, status: 'working' });
  console.log('[agent] reported WORKING');

  await new Promise(r => setTimeout(r, 1500));   // simulated work

  const ws = path.join(__dirname, 'agent-workspace');
  fs.mkdirSync(ws, { recursive: true });
  const file = path.join(ws, task.requestId.slice(0, 8) + '.txt');
  fs.writeFileSync(file, 'Task executed by Relaytor test agent.\\n\\nTask:\\n' + task.text + '\\n');

  if (MODE === 'failed') {
    await call('POST', '/v1/agent/status', {
      requestId: task.requestId, status: 'failed',
      summary: 'Agent could not complete the task (simulated failure).',
      error: 'SimulatedFailure: test agent ran with --mode=failed',
      filesChanged: [],
    });
    console.log('[agent] reported FAILED');
  } else {
    await call('POST', '/v1/agent/status', {
      requestId: task.requestId, status: 'completed',
      summary: \`Executed task. Wrote \${path.basename(file)}.\`,
      filesChanged: [file],
      suggestedFollowUp: 'Ask the web AI to review the generated file contents.',
    });
    console.log('[agent] reported COMPLETED, changed file:', file);
  }
}

main().catch(e => { console.error('[agent] error:', e.message); process.exit(1); });
`,

  'extension/manifest.json': `{
  "manifest_version": 3,
  "name": "Relaytor",
  "version": "0.1.0",
  "description": "Send coding tasks from web AI chats to a local coding agent via Relaytor Core.",
  "permissions": ["storage", "activeTab", "scripting", "clipboardWrite"],
  "host_permissions": ["http://127.0.0.1:5000/*"],
  "background": { "service_worker": "background.js" },
  "action": { "default_popup": "popup.html" },
  "content_scripts": [
    {
      "matches": [
        "https://chatgpt.com/*",
        "https://claude.ai/*",
        "https://gemini.google.com/*",
        "https://chat.mistral.ai/*"
      ],
      "js": ["content.js"],
      "run_at": "document_idle"
    }
  ]
}
`,

  'extension/background.js': `// Relaytor extension — MV3 service worker. Approved plan §6.
// Owns: submit, guarded polling (setTimeout chain per requestId, Set-based
// duplicate guard, five termination conditions), persistence, resume, ack.
'use strict';

const CORE = 'http://127.0.0.1:5000';
const POLL_INTERVAL_MS = 2000;
const MAX_TASK_AGE_MS = 10 * 60 * 1000; // §6 stale cap

async function getToken() {
  const { relaytorToken } = await chrome.storage.local.get('relaytorToken');
  return relaytorToken || '';
}

async function coreFetch(method, path, body) {
  const token = await getToken();
  const res = await fetch(CORE + path, {
    method,
    headers: {
      'Authorization': 'Bearer ' + token,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try { json = await res.json(); } catch (_) { /* non-JSON error page */ }
  return { status: res.status, json };
}

// ---------- task store: source of truth across reloads/restarts (§6) ----------

async function getTasks() {
  const { relaytorTasks = [] } = await chrome.storage.local.get('relaytorTasks');
  return relaytorTasks;
}

async function saveTasks(tasks) {
  await chrome.storage.local.set({ relaytorTasks: tasks });
}

async function updateTask(requestId, patch) {
  const tasks = await getTasks();
  const i = tasks.findIndex(t => t.requestId === requestId);
  if (i === -1) return; // acked/cleared meanwhile — stale update dropped
  tasks[i] = { ...tasks[i], ...patch };
  await saveTasks(tasks);
  notifyContentScript(tasks[i]);
}

function notifyContentScript(task) {
  try {
    chrome.runtime.sendMessage({ type: 'relaytor.taskUpdate', task }).catch(() => {});
  } catch (_) { /* context invalidated — storage is authoritative */ }
}

// ---------- submit ----------

async function submitTask(text) {
  if (!text || !text.trim()) return { error: 'No task text selected.' };
  if (text.length > 50000) return { error: 'Task text too large (max 50000 chars).' };
  if (!(await getToken())) return { error: 'No Relaytor token configured. Open the popup and save your token.' };
  let r;
  try {
    r = await coreFetch('POST', '/v1/task', { text: text.trim() });
  } catch (_) {
    return { error: 'Relaytor Core unreachable. Is \`node relaytor-core.js\` running on 127.0.0.1:5000?' };
  }
  if (r.status !== 201) return { error: (r.json && r.json.error) || \`Core returned \${r.status}\` };
  const task = { requestId: r.json.requestId, text: text.trim(), status: 'sent', createdAt: Date.now() };
  const tasks = await getTasks();
  tasks.push(task);
  await saveTasks(tasks);
  pollTask(task.requestId);
  return { task };
}

// ---------- guarded polling (§6) ----------

const polling = new Set(); // requestIds with a live poll chain

async function pollTask(requestId) {
  if (polling.has(requestId)) return; // duplicate polling guard
  polling.add(requestId);

  const tick = async () => {
    let r;
    try {
      r = await coreFetch('GET', '/v1/task/' + requestId);
    } catch (_) {
      await updateTask(requestId, { status: 'offline' }); // bridge offline: stop, no retry loop
      polling.delete(requestId);
      return;
    }
    if (r.status === 404) {
      await updateTask(requestId, { status: 'unknown' }); // restart / acked / expired
      polling.delete(requestId);
      return;
    }
    if (r.status !== 200) {
      await updateTask(requestId, { status: 'error', errorDetail: (r.json && r.json.error) || ('HTTP ' + r.status) });
      polling.delete(requestId);
      return;
    }
    const server = r.json;
    const tasks = await getTasks();
    const local = tasks.find(t => t.requestId === requestId);
    if (!local) { polling.delete(requestId); return; } // cleared meanwhile
    if (Date.now() - local.createdAt > MAX_TASK_AGE_MS) {
      await updateTask(requestId, { status: 'stale' });
      polling.delete(requestId);
      return;
    }
    await updateTask(requestId, {
      status: server.status,
      summary: server.summary || '',
      error: server.error || '',
      filesChanged: server.filesChanged || [],
      suggestedFollowUp: server.suggestedFollowUp || '',
    });
    if (server.status === 'completed' || server.status === 'failed') {
      polling.delete(requestId); // terminal — stop
      return;
    }
    try {
      setTimeout(tick, POLL_INTERVAL_MS); // guarded chain, only while non-terminal
    } catch (_) { polling.delete(requestId); } // context destroyed — storage holds state
  };

  tick();
}

// ---------- resume on worker wake / extension reload / browser restart (§6) ----------
async function resumePolling() {
  try {
    const tasks = await getTasks();
    for (const t of tasks) {
      if (['sent', 'working'].includes(t.status) && Date.now() - t.createdAt < MAX_TASK_AGE_MS) {
        pollTask(t.requestId);
      }
    }
  } catch (_) { /* storage unavailable — nothing to resume */ }
}
resumePolling();

// ---------- acknowledge / clear ----------

async function ackTask(requestId) {
  try { await coreFetch('POST', \`/v1/task/\${requestId}/ack\`); } catch (_) { /* offline: still clear locally */ }
  const tasks = (await getTasks()).filter(t => t.requestId !== requestId);
  await saveTasks(tasks);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg && msg.type === 'relaytor.sendTask') {
      sendResponse(await submitTask(msg.text));
    } else if (msg && msg.type === 'relaytor.ack') {
      await ackTask(msg.requestId);
      sendResponse({ ok: true });
    }
  })();
  return true; // async sendResponse
});
`,

  'extension/content.js': `// Relaytor content script. Approved plan §6: thin UI; no polling; no silent
// injection into the AI conversation; clipboard copies only on explicit click.
'use strict';

const CORE_STATES = {
  sent:      { label: 'SENT',      color: '#6b7280', copyable: false },
  working:   { label: 'WORKING',   color: '#f59e0b', copyable: false },
  completed: { label: 'COMPLETED', color: '#16a34a', copyable: true  },
  failed:    { label: 'FAILED',    color: '#dc2626', copyable: false },
  offline:   { label: 'CORE OFFLINE', color: '#dc2626', copyable: false },
  unknown:   { label: 'UNKNOWN (core restarted?)', color: '#dc2626', copyable: false },
  stale:     { label: 'STALE',     color: '#dc2626', copyable: false },
  error:     { label: 'ERROR',     color: '#dc2626', copyable: false },
};

function selectedTaskText() {
  const sel = window.getSelection && window.getSelection();
  return sel ? sel.toString().trim() : '';
}

// ---- Send button ----
const sendBtn = document.createElement('button');
sendBtn.textContent = '⇢ Send to Relaytor';
Object.assign(sendBtn.style, {
  position: 'fixed', right: '16px', bottom: '16px', zIndex: '2147483647',
  padding: '8px 14px', borderRadius: '8px', border: '1px solid #333',
  background: '#111', color: '#fff', font: '13px/1 sans-serif', cursor: 'pointer',
});
document.documentElement.appendChild(sendBtn);

sendBtn.addEventListener('click', () => {
  const text = selectedTaskText();
  if (!text) {
    flash('Select the coding task text on the page first.');
    return;
  }
  try {
    chrome.runtime.sendMessage({ type: 'relaytor.sendTask', text }, (resp) => {
      if (chrome.runtime.lastError || !resp) { flash('Extension unavailable — reload the page.'); return; }
      if (resp.error) { flash(resp.error); return; }
      renderTask({ requestId: resp.task.requestId, status: 'sent' });
    });
  } catch (_) { flash('Extension unavailable — reload the page.'); }
});

// ---- Status chip ----
const chip = document.createElement('div');
Object.assign(chip.style, {
  position: 'fixed', right: '16px', top: '16px', zIndex: '2147483647',
  display: 'none', maxWidth: '420px', padding: '10px 12px', borderRadius: '8px',
  background: '#111', color: '#fff', font: '12px/1.4 sans-serif',
  border: '1px solid #333', whiteSpace: 'pre-wrap', cursor: 'default',
});
document.documentElement.appendChild(chip);

function copyText(t) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(t).then(
      () => flash('Copied. Paste it into the AI chat yourself.'),
      () => fallbackCopy(t)
    );
  } else fallbackCopy(t);
}
function fallbackCopy(t) {
  const ta = document.createElement('textarea');
  ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); flash('Copied. Paste it into the AI chat yourself.'); }
  catch (_) { flash('Copy failed — select the text manually.'); }
  ta.remove();
}

function resultText(task) {
  if (task.status === 'completed') {
    return \`Relaytor task COMPLETED (\${task.requestId})\\n\\nSummary:\\n\${task.summary}\\n\\nFiles changed:\\n\${(task.filesChanged || []).join('\\n') || '(none)'}\${task.suggestedFollowUp ? '\\n\\nSuggested follow-up:\\n' + task.suggestedFollowUp : ''}\`;
  }
  if (task.status === 'failed') {
    return \`Relaytor task FAILED (\${task.requestId})\\n\\nSummary:\\n\${task.summary || '(none)'}\\n\\nError:\\n\${task.error}\`;
  }
  return '';
}

let currentTask = null;

function renderTask(task) {
  currentTask = task;
  const s = CORE_STATES[task.status] || CORE_STATES.error;
  chip.style.display = 'block';
  chip.style.borderColor = s.color;
  chip.textContent = \`[Relaytor \${s.label}] \${task.requestId}\`;
  chip.title = s.copyable ? 'Click to copy the result' : '';
  chip.onclick = () => {
    if (!currentTask || !s.copyable) return;
    copyText(resultText(currentTask));       // explicit user gesture only
  };
  const clear = document.createElement('button');
  clear.textContent = '✕ clear';
  Object.assign(clear.style, { marginLeft: '8px', cursor: 'pointer', background: 'none', color: '#9ca3af', border: 'none', font: 'inherit' });
  clear.onclick = (e) => {
    e.stopPropagation();
    try {
      chrome.runtime.sendMessage({ type: 'relaytor.ack', requestId: currentTask.requestId }, () => {
        if (chrome.runtime.lastError) { /* worker gone — still hide locally */ }
        chip.style.display = 'none';
        currentTask = null;
      });
    } catch (_) { chip.style.display = 'none'; currentTask = null; }
  };
  chip.appendChild(clear);
}

function flash(msg) {
  const f = document.createElement('div');
  f.textContent = msg;
  Object.assign(f.style, {
    position: 'fixed', right: '16px', bottom: '56px', zIndex: '2147483647',
    padding: '8px 12px', borderRadius: '8px', background: '#111', color: '#fff',
    font: '12px sans-serif', border: '1px solid #333',
  });
  document.documentElement.appendChild(f);
  setTimeout(() => f.remove(), 4000);
}

// Live status updates from the service worker. Guarded against invalid context.
try {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'relaytor.taskUpdate') {
      if (!currentTask || currentTask.requestId === msg.task.requestId) renderTask(msg.task);
    }
  });
} catch (_) { /* context invalidated */ }
`,

  'extension/popup.html': `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { font: 13px sans-serif; width: 360px; padding: 10px; }
  input { width: 100%; box-sizing: border-box; margin: 4px 0 8px; padding: 6px; }
  .task { border: 1px solid #ccc; border-radius: 6px; padding: 8px; margin: 8px 0; }
  .badge { padding: 2px 6px; border-radius: 4px; color: #fff; font-size: 11px; }
  button { cursor: pointer; padding: 4px 10px; margin-right: 6px; }
  .muted { color: #666; font-size: 11px; }
  pre { white-space: pre-wrap; max-height: 120px; overflow: auto; background: #f4f4f4; padding: 6px; }
</style>
</head>
<body>
  <h3 style="margin:0 0 8px">Relaytor</h3>
  <label for="token">Relaytor Core token</label>
  <input id="token" type="password" placeholder="paste bearer token from server console">
  <button id="save">Save token</button>
  <span id="saved" class="muted"></span>
  <hr>
  <div id="tasks"><em class="muted">No tasks yet.</em></div>
  <script src="popup.js"></script>
</body>
</html>
`,

  'extension/popup.js': `'use strict';

const $ = (id) => document.getElementById(id);

chrome.storage.local.get('relaytorToken').then(({ relaytorToken = '' }) => { $('token').value = relaytorToken; });

$('save').addEventListener('click', async () => {
  await chrome.storage.local.set({ relaytorToken: $('token').value.trim() });
  $('saved').textContent = 'saved ✓';
  setTimeout(() => ($('saved').textContent = ''), 1500);
});

const COLORS = { sent: '#6b7280', working: '#f59e0b', completed: '#16a34a',
                 failed: '#dc2626', offline: '#dc2626', unknown: '#dc2626', stale: '#dc2626', error: '#dc2626' };

async function render() {
  const { relaytorTasks = [] } = await chrome.storage.local.get('relaytorTasks');
  const box = $('tasks');
  box.textContent = '';
  if (!relaytorTasks.length) { box.innerHTML = '<em class="muted">No tasks yet.</em>'; return; }
  for (const t of [...relaytorTasks].reverse()) {
    const div = document.createElement('div');
    div.className = 'task';
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.style.background = COLORS[t.status] || '#999';
    badge.textContent = (t.status || 'unknown').toUpperCase() + ' · ' + t.requestId.slice(0, 8);
    div.appendChild(badge);

    if (t.summary || t.error) {
      const pre = document.createElement('pre');
      pre.textContent = t.summary + (t.error ? '\\n\\nError: ' + t.error : '') +
        (t.filesChanged && t.filesChanged.length ? '\\n\\nFiles:\\n' + t.filesChanged.join('\\n') : '');
      div.appendChild(pre);
    }
    if (['completed', 'failed'].includes(t.status)) {
      const copy = document.createElement('button');
      copy.textContent = 'Copy result';
      copy.addEventListener('click', () => {   // explicit user gesture in popup
        const text = t.status === 'completed'
          ? \`Relaytor task COMPLETED (\${t.requestId})\\n\\nSummary:\\n\${t.summary}\\n\\nFiles changed:\\n\${(t.filesChanged || []).join('\\n') || '(none)'}\${t.suggestedFollowUp ? '\\n\\nSuggested follow-up:\\n' + t.suggestedFollowUp : ''}\`
          : \`Relaytor task FAILED (\${t.requestId})\\n\\nSummary:\\n\${t.summary || '(none)'}\\n\\nError:\\n\${t.error}\`;
        navigator.clipboard.writeText(text).then(() => {
          copy.textContent = 'Copied ✓';
          setTimeout(() => (copy.textContent = 'Copy result'), 1500);
        });
      });
      div.appendChild(copy);
    }
    const ack = document.createElement('button');
    ack.textContent = 'Clear';
    ack.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'relaytor.ack', requestId: t.requestId }, () => render());
    });
    div.appendChild(ack);
    box.appendChild(div);
  }
}

chrome.storage.onChanged.addListener((c) => { if (c.relaytorTasks) render(); });
render();
`,

  'tests/core.unit.test.js': `'use strict';
// Relaytor Core unit tests — plan §10 UNIT TESTS U1–U9.
// Run: node --test tests/core.unit.test.js
// Tests the pure logic (validateTaskPayload, applyAgentStatus, id generation).
// The definitions below are copied verbatim from server/relaytor-core.js
// (kept in sync by review) so no listener starts on import.

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const MAX_TEXT = 50_000;
const RE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VALID_TRANSITIONS = { sent: ['working', 'failed'], working: ['completed', 'failed'] };

function validateTaskPayload(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body))
    return { error: 'body must be a JSON object' };
  if (typeof body.text !== 'string' || !body.text.trim())
    return { error: 'text must be a non-empty string' };
  if (body.text.length > MAX_TEXT) return { error: 'text exceeds 50000 chars' };
  return { text: body.text.trim() };
}

function applyAgentStatus(task, msg) {
  if (!msg || typeof msg !== 'object') return { error: 'invalid message' };
  const { requestId, status } = msg;
  if (typeof requestId !== 'string' || !RE_ID.test(requestId)) return { error: 'invalid requestId' };
  if (status === 'working') {
    const allowed = VALID_TRANSITIONS[task.status];
    if (!allowed || !allowed.includes('working')) return { error: \`illegal transition \${task.status} -> working\` };
    task.status = 'working';
  } else if (status === 'completed') {
    const allowed = VALID_TRANSITIONS[task.status];
    if (!allowed || !allowed.includes('completed')) return { error: \`illegal transition \${task.status} -> completed\` };
    if (typeof msg.summary !== 'string' || !msg.summary.trim()) return { error: 'completed requires a non-empty summary' };
    if (msg.filesChanged !== undefined && !Array.isArray(msg.filesChanged)) return { error: 'filesChanged must be an array' };
    task.status = 'completed';
    task.summary = msg.summary; task.filesChanged = msg.filesChanged || [];
    task.suggestedFollowUp = typeof msg.suggestedFollowUp === 'string' ? msg.suggestedFollowUp : '';
  } else if (status === 'failed') {
    const allowed = VALID_TRANSITIONS[task.status];
    if (!allowed || !allowed.includes('failed')) return { error: \`illegal transition \${task.status} -> failed\` };
    if (typeof msg.error !== 'string' || !msg.error.trim()) return { error: 'failed requires a non-empty error' };
    task.status = 'failed';
    task.summary = typeof msg.summary === 'string' ? msg.summary : '';
    task.error = msg.error;
    task.filesChanged = Array.isArray(msg.filesChanged) ? msg.filesChanged : [];
  } else return { error: 'status must be working | completed | failed' };
  task.updatedAt = new Date().toISOString();
  return {};
}

const mkTask = () => ({ requestId: crypto.randomUUID(), status: 'sent' });

// U1
test('U1: empty/whitespace/non-string text rejected with exact errors', () => {
  assert.strictEqual(validateTaskPayload({ text: '' }).error, 'text must be a non-empty string');
  assert.strictEqual(validateTaskPayload({ text: '   ' }).error, 'text must be a non-empty string');
  assert.strictEqual(validateTaskPayload({ text: 42 }).error, 'text must be a non-empty string');
  assert.strictEqual(validateTaskPayload(null).error, 'body must be a JSON object');
  assert.strictEqual(validateTaskPayload(['x']).error, 'body must be a JSON object');
});
// U2
test('U2: text length cap enforced at exactly 50000', () => {
  assert.strictEqual(validateTaskPayload({ text: 'a'.repeat(50000) }).error, undefined);
  assert.strictEqual(validateTaskPayload({ text: 'a'.repeat(50001) }).error, 'text exceeds 50000 chars');
});
// U3
test('U3: sent -> completed rejected', () => {
  const t = mkTask();
  assert.strictEqual(applyAgentStatus(t, { requestId: t.requestId, status: 'completed', summary: 'x' }).error,
    'illegal transition sent -> completed');
});
// U4
test('U4: duplicate working rejected', () => {
  const t = mkTask();
  assert.strictEqual(applyAgentStatus(t, { requestId: t.requestId, status: 'working' }).error, undefined);
  assert.match(applyAgentStatus(t, { requestId: t.requestId, status: 'working' }).error, /illegal transition working -> working/);
});
// U5
test('U5: sent->failed, working->failed, working->completed accepted', () => {
  const a = mkTask();
  assert.ok(!applyAgentStatus(a, { requestId: a.requestId, status: 'failed', error: 'boom' }).error);
  const b = mkTask();
  applyAgentStatus(b, { requestId: b.requestId, status: 'working' });
  assert.ok(!applyAgentStatus(b, { requestId: b.requestId, status: 'failed', error: 'boom' }).error);
  const c = mkTask();
  applyAgentStatus(c, { requestId: c.requestId, status: 'working' });
  assert.ok(!applyAgentStatus(c, { requestId: c.requestId, status: 'completed', summary: 'ok' }).error);
});
// U6
test('U6: terminal states immutable', () => {
  const t = mkTask();
  applyAgentStatus(t, { requestId: t.requestId, status: 'working' });
  applyAgentStatus(t, { requestId: t.requestId, status: 'completed', summary: 'ok' });
  assert.match(applyAgentStatus(t, { requestId: t.requestId, status: 'working' }).error, /illegal transition completed/);
  const f = mkTask();
  applyAgentStatus(f, { requestId: f.requestId, status: 'failed', error: 'x' });
  assert.match(applyAgentStatus(f, { requestId: f.requestId, status: 'completed', summary: 'y' }).error, /illegal transition failed/);
});
// U7
test('U7: completed requires non-empty summary and array filesChanged', () => {
  const t = mkTask(); applyAgentStatus(t, { requestId: t.requestId, status: 'working' });
  assert.strictEqual(applyAgentStatus(t, { requestId: t.requestId, status: 'completed', summary: '' }).error,
    'completed requires a non-empty summary');
  assert.strictEqual(applyAgentStatus(t, { requestId: t.requestId, status: 'completed', summary: 'ok', filesChanged: 'no' }).error,
    'filesChanged must be an array');
});
// U8
test('U8: failed requires non-empty error', () => {
  const t = mkTask();
  assert.strictEqual(applyAgentStatus(t, { requestId: t.requestId, status: 'failed', error: '' }).error,
    'failed requires a non-empty error');
});
// U9
test('U9: 10000 ids unique and UUID-v4 format', () => {
  const seen = new Set();
  for (let i = 0; i < 10000; i++) {
    const id = crypto.randomUUID();
    assert.match(id, RE_ID);
    seen.add(id);
  }
  assert.strictEqual(seen.size, 10000);
});
`,

  'tests/core.integration.test.js': `'use strict';
// Relaytor Core integration tests — plan §10 INTEGRATION TESTS I1–I11.
// Spawns the real server process on the approved port (127.0.0.1:5000) and makes
// real HTTP requests. Run: node tests/core.integration.test.js
// (requires the server not already running).

const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

const HOST = '127.0.0.1', PORT = 5000;
const CONFIG = path.join(__dirname, '..', 'server', 'config.json');

function call(method, urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: HOST, port: PORT, method, path: urlPath, headers: {
      ...(token ? { 'Authorization': 'Bearer ' + token } : {}),
      ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
    }}, res => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => resolve({ status: res.statusCode, json: out ? JSON.parse(out) : null }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const results = [];
const t = (name, cond, detail) => results.push({ name, pass: !!cond, detail });

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'relaytor-core.js')]);
  await new Promise(r => server.stdout.on('data', r)); // wait for listen line
  const token = JSON.parse(fs.readFileSync(CONFIG, 'utf8')).token;

  try {
    // I1
    let r = await call('GET', '/health');
    t('I1 health 200 {"ok":true} no auth', r.status === 200 && r.json.ok === true, JSON.stringify(r));
    // I2
    r = await call('GET', '/v1/task');
    t('I2 401 without token', r.status === 401 && r.json.error === 'missing or invalid bearer token', JSON.stringify(r));
    // I3
    r = await call('POST', '/v1/task', { text: 'test task A' }, token);
    const idA = r.json.requestId;
    t('I3 submit 201 with UUID, status sent', r.status === 201 && /^[0-9a-f-]{36}$/.test(idA) && r.json.status === 'sent', JSON.stringify(r));
    r = await call('GET', '/v1/task/' + idA, null, token);
    t('I3b GET returns sent with text', r.status === 200 && r.json.status === 'sent' && r.json.text === 'test task A', JSON.stringify(r));
    // I4
    r = await call('POST', '/v1/task', { text: '' }, token);
    t('I4a empty text 400 exact error', r.status === 400 && r.json.error === 'text must be a non-empty string', JSON.stringify(r));
    // malformed JSON
    r = await new Promise((resolve, reject) => {
      const req = http.request({ host: HOST, port: PORT, method: 'POST', path: '/v1/task', headers: {
        'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }}, res => {
        let out = ''; res.on('data', c => out += c);
        res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(out) }));
      });
      req.on('error', reject); req.end('{not json');
    });
    t('I4b malformed JSON 400 invalid JSON', r.status === 400 && r.json.error === 'invalid JSON', JSON.stringify(r));
    r = await call('POST', '/v1/task', { text: 'a'.repeat(50001) }, token);
    t('I4c oversize text 413 exact error', r.status === 413 && r.json.error === 'text exceeds 50000 chars', JSON.stringify(r));
    // I5 full sequence
    r = await call('POST', '/v1/task', { text: 'test task B' }, token);
    const idB = r.json.requestId;
    r = await call('POST', '/v1/agent/claim', null, token);
    t('I5a claim FIFO returns task A first', r.json.task && r.json.task.requestId === idA, JSON.stringify(r));
    r = await call('POST', '/v1/agent/status', { requestId: idA, status: 'working' }, token);
    t('I5b working 200', r.status === 200 && r.json.status === 'working', JSON.stringify(r));
    r = await call('GET', '/v1/task/' + idA, null, token);
    t('I5c GET shows working', r.json.status === 'working', JSON.stringify(r));
    r = await call('POST', '/v1/agent/status', { requestId: idA, status: 'completed', summary: 'did it', filesChanged: ['/tmp/x'], suggestedFollowUp: 'review' }, token);
    t('I5d completed 200', r.status === 200 && r.json.status === 'completed', JSON.stringify(r));
    r = await call('GET', '/v1/task/' + idA, null, token);
    t('I5e GET shows completed with summary', r.json.status === 'completed' && r.json.summary === 'did it' && r.json.filesChanged[0] === '/tmp/x', JSON.stringify(r));
    // I6 failed path
    r = await call('POST', '/v1/agent/claim', null, token);
    t('I6a claim task B', r.json.task && r.json.task.requestId === idB, JSON.stringify(r));
    r = await call('POST', '/v1/agent/status', { requestId: idB, status: 'failed', error: 'boom', summary: 'nope' }, token);
    t('I6b failed 200', r.status === 200 && r.json.status === 'failed', JSON.stringify(r));
    r = await call('GET', '/v1/task/' + idB, null, token);
    t('I6c GET shows failed with error', r.json.status === 'failed' && r.json.error === 'boom', JSON.stringify(r));
    // I7 duplicate completion
    r = await call('POST', '/v1/agent/status', { requestId: idA, status: 'completed', summary: 'again' }, token);
    t('I7 duplicate completion 409', r.status === 409 && /illegal transition/.test(r.json.error), JSON.stringify(r));
    // I8 unknown id
    r = await call('GET', '/v1/task/00000000-0000-4000-8000-000000000000', null, token);
    t('I8 unknown id 404 with restart message', r.status === 404 && /server restarted/.test(r.json.error), JSON.stringify(r));
    // I9 ack
    r = await call('POST', \`/v1/task/\${idA}/ack\`, null, token);
    t('I9a ack 200', r.status === 200 && r.json.acknowledged === idA, JSON.stringify(r));
    r = await call('GET', '/v1/task/' + idA, null, token);
    t('I9b acked id 404', r.status === 404, JSON.stringify(r));
    // I10 empty queue
    r = await call('POST', '/v1/agent/claim', null, token);
    t('I10 claim empty -> {"task":null}', r.json.task === null, JSON.stringify(r));
    // I11 300KB body
    r = await new Promise((resolve, reject) => {
      const req = http.request({ host: HOST, port: PORT, method: 'POST', path: '/v1/task', headers: {
        'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Content-Length': 300000 }}, res => {
        let out = ''; res.on('data', c => out += c);
        res.on('end', () => resolve({ status: res.statusCode, json: out ? JSON.parse(out) : null }));
      });
      req.on('error', () => resolve({ status: 'conn-error' }));
      req.end('a'.repeat(300000));
    });
    t('I11 300KB body rejected 413', (r.status === 413 || r.status === 'conn-error') && (r.json === null || r.json.error === 'body exceeds 262144 bytes'), JSON.stringify(r));
  } finally {
    server.kill();
  }

  console.log(results.map(r => \`\${r.pass ? 'PASS' : 'FAIL'}  \${r.name}\${r.pass ? '' : '  -> ' + r.detail}\`).join('\\n'));
  const failed = results.filter(r => !r.pass).length;
  console.log(\`\\n\${results.length - failed}/\${results.length} passed\`);
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
`,

  'tests/run-acceptance.md': `# Relaytor Phase 1 — Manual Test Runbook

Automated coverage: unit (U1–U9) and integration (I1–I11) run with Node.
Browser tests B1–B10 and acceptance tests A1–A2 are manual by design
(Phase 1 excludes autonomous browser verification).

## Prerequisites
- Node 18+
- Chrome/Chromium/Edge with Developer mode enabled

## Setup
1. \`node server/relaytor-core.js\` — copy the token from the console.
2. \`chrome://extensions\` → Load unpacked → \`relaytor/extension\`.
3. Popup → paste token → Save.

## Browser tests B1–B10 (record screenshot / console state per test)

- **B1** Visit a supported AI site → button visible, no console errors.
- **B2** Select task text → click Send → chip \`SENT\` + requestId.
- **B3** Task claimed by agent → chip \`WORKING\`.
- **B4** Delete token in popup, select text, Send → explicit error, nothing sent.
- **B5** Kill core while polling → chip \`CORE OFFLINE\`, polling stops (no further requests in core log).
- **B6** Restart core while polling → chip \`UNKNOWN\`, polling stops.
- **B7** Task WORKING → reload extension → polling resumes, terminal state still reached.
- **B8** Task in flight → refresh tab → popup retains task; chip returns on next update.
- **B9** Completed task → click chip / popup Copy → clipboard has formatted result; **no text appears in chat input**.
- **B10** Failed task → click copy → clipboard has error text.

## Acceptance tests

**A1 (completed):** web AI generates task → Send → core receives, UUID assigned →
\`RELAYTOR_TOKEN=<token> node agent/test-agent.js --mode=completed\` → agent reports WORKING (UI shows WORKING) →
agent writes file in \`agent-workspace/\` → reports COMPLETED (UI shows COMPLETED) →
click badge → result copied → paste into web AI.
Evidence: screen recording + created file + core log.

**A2 (failed):** same, \`--mode=failed\` → UI shows FAILED → click copies error → paste.
Evidence: screen recording + core log.

A test is PASS only with the evidence recorded next to it.
`,

  'README.md': `# Relaytor — Phase 1

Local control layer connecting web-based AI conversations with a local coding agent.

WEB AI → RELAYTOR → LOCAL CODING AGENT → RELAYTOR → WEB AI

## Layout

\`\`\`
relaytor/
├── server/relaytor-core.js      Core: localhost HTTP bridge (127.0.0.1:5000), zero dependencies
├── agent/test-agent.js          Reference agent-protocol implementation (NOT an IDE integration)
├── extension/                   Chrome MV3 extension
├── tests/
│   ├── core.unit.test.js        U1–U9   (node --test tests/core.unit.test.js)
│   ├── core.integration.test.js I1–I11  (node tests/core.integration.test.js)
│   └── run-acceptance.md        Manual browser + acceptance runbook (B1–B10, A1–A2)
└── README.md
\`\`\`

## Run

1. Core: \`node server/relaytor-core.js\` — token printed to console and saved to
   \`server/config.json\`.
2. Extension: \`chrome://extensions\` → Developer mode → Load unpacked → \`extension/\`.
   Popup → paste token → Save.
3. Agent: \`RELAYTOR_TOKEN=<token> node agent/test-agent.js --mode=completed\`
   (or \`--mode=failed\`).

## Tests

- Unit: \`node --test tests/core.unit.test.js\`
- Integration (server must not already be running): \`node tests/core.integration.test.js\`
- Browser + acceptance: follow \`tests/run-acceptance.md\` manually.

## Phase 1 boundaries

No cloud relay, accounts, payments, analytics, autonomous verification, or native
Cline/Cursor/Roo/Copilot integration. The agent contract is plain HTTP:
claim → working → completed/failed. See the approved plan for the full contract.
`,
};

// ---------- write everything ----------
const ROOT = path.join(process.cwd(), 'relaytor');
const dirs = new Set(['server', 'agent', 'extension', 'tests']);
for (const rel of Object.keys(FILES)) {
  const dir = rel.split('/')[0];
  if (dirs.has(dir)) dirs.delete(dir);
}

for (const rel of Object.keys(FILES)) {
  const dest = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, FILES[rel]);
  console.log('wrote', dest);
}
console.log('\nRelaytor Phase 1 project created in ' + ROOT);
console.log('Next: node relaytor/server/relaytor-core.js');
