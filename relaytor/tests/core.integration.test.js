'use strict';
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
  await new Promise(r => setTimeout(r, 200));         // ensure socket fully bound
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
    r = await call('POST', `/v1/task/${idA}/ack`, null, token);
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
      req.on('error', () => resolve({ status: 'conn-error', json: null }));
      req.end('a'.repeat(300000));
    });
    t('I11 300KB body rejected 413', (r.status === 413 || r.status === 'conn-error') && (r.json === null || r.json.error === 'body exceeds 262144 bytes'), JSON.stringify(r));
  } finally {
    server.kill();
  }

  console.log(results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : '  -> ' + r.detail}`).join('\n'));
  const failed = results.filter(r => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
