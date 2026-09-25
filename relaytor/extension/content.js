// Relaytor content script. Approved plan §6: thin UI; no polling; no silent
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
    return `Relaytor task COMPLETED (${task.requestId})\n\nSummary:\n${task.summary}\n\nFiles changed:\n${(task.filesChanged || []).join('\n') || '(none)'}${task.suggestedFollowUp ? '\n\nSuggested follow-up:\n' + task.suggestedFollowUp : ''}`;
  }
  if (task.status === 'failed') {
    return `Relaytor task FAILED (${task.requestId})\n\nSummary:\n${task.summary || '(none)'}\n\nError:\n${task.error}`;
  }
  return '';
}

let currentTask = null;

function renderTask(task) {
  currentTask = task;
  const s = CORE_STATES[task.status] || CORE_STATES.error;
  chip.style.display = 'block';
  chip.style.borderColor = s.color;
  chip.textContent = `[Relaytor ${s.label}] ${task.requestId}`;
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
