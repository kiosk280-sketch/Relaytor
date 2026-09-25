#!/usr/bin/env node
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
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${json.error || out}`));
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
  console.log('[agent] claimed task', task.requestId, '\n---\n' + task.text + '\n---');

  await call('POST', '/v1/agent/status', { requestId: task.requestId, status: 'working' });
  console.log('[agent] reported WORKING');

  await new Promise(r => setTimeout(r, 1500));   // simulated work

  const ws = path.join(__dirname, 'agent-workspace');
  fs.mkdirSync(ws, { recursive: true });
  const file = path.join(ws, task.requestId.slice(0, 8) + '.txt');
  fs.writeFileSync(file, 'Task executed by Relaytor test agent.\n\nTask:\n' + task.text + '\n');

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
      summary: `Executed task. Wrote ${path.basename(file)}.`,
      filesChanged: [file],
      suggestedFollowUp: 'Ask the web AI to review the generated file contents.',
    });
    console.log('[agent] reported COMPLETED, changed file:', file);
  }
}

main().catch(e => { console.error('[agent] error:', e.message); process.exit(1); });
