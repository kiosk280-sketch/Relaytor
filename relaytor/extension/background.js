// Relaytor extension — MV3 service worker. Approved plan §6.
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
    return { error: 'Relaytor Core unreachable. Is `node relaytor-core.js` running on 127.0.0.1:5000?' };
  }
  if (r.status !== 201) return { error: (r.json && r.json.error) || `Core returned ${r.status}` };
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
  try { await coreFetch('POST', `/v1/task/${requestId}/ack`); } catch (_) { /* offline: still clear locally */ }
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
