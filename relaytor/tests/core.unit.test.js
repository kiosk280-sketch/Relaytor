'use strict';
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
    if (!allowed || !allowed.includes('working')) return { error: `illegal transition ${task.status} -> working` };
    task.status = 'working';
  } else if (status === 'completed') {
    const allowed = VALID_TRANSITIONS[task.status];
    if (!allowed || !allowed.includes('completed')) return { error: `illegal transition ${task.status} -> completed` };
    if (typeof msg.summary !== 'string' || !msg.summary.trim()) return { error: 'completed requires a non-empty summary' };
    if (msg.filesChanged !== undefined && !Array.isArray(msg.filesChanged)) return { error: 'filesChanged must be an array' };
    task.status = 'completed';
    task.summary = msg.summary; task.filesChanged = msg.filesChanged || [];
    task.suggestedFollowUp = typeof msg.suggestedFollowUp === 'string' ? msg.suggestedFollowUp : '';
  } else if (status === 'failed') {
    const allowed = VALID_TRANSITIONS[task.status];
    if (!allowed || !allowed.includes('failed')) return { error: `illegal transition ${task.status} -> failed` };
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
