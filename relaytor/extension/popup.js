'use strict';

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
      pre.textContent = t.summary + (t.error ? '\n\nError: ' + t.error : '') +
        (t.filesChanged && t.filesChanged.length ? '\n\nFiles:\n' + t.filesChanged.join('\n') : '');
      div.appendChild(pre);
    }
    if (['completed', 'failed'].includes(t.status)) {
      const copy = document.createElement('button');
      copy.textContent = 'Copy result';
      copy.addEventListener('click', () => {   // explicit user gesture in popup
        const text = t.status === 'completed'
          ? `Relaytor task COMPLETED (${t.requestId})\n\nSummary:\n${t.summary}\n\nFiles changed:\n${(t.filesChanged || []).join('\n') || '(none)'}${t.suggestedFollowUp ? '\n\nSuggested follow-up:\n' + t.suggestedFollowUp : ''}`
          : `Relaytor task FAILED (${t.requestId})\n\nSummary:\n${t.summary || '(none)'}\n\nError:\n${t.error}`;
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
