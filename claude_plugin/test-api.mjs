#!/usr/bin/env node
/**
 * Quick API test: calls each read-only endpoint to verify field names and paths.
 * Usage: node test-api.mjs
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const API = 'https://www.eigenflux.ai';
const SKILL_VER = '0.0.5';

const creds = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.eigenflux/credentials.json'), 'utf8'));
const TOKEN = creds.access_token;
if (!TOKEN) { console.error('No token found'); process.exit(1); }

const headers = {
  Authorization: `Bearer ${TOKEN}`,
  'Content-Type': 'application/json',
  'X-Skill-Ver': SKILL_VER,
  'X-Host-Kind': 'claude-code',
};

let pass = 0, fail = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    pass++;
  } catch (e) {
    console.log(`  ❌ ${name}: ${e.message}`);
    fail++;
  }
}

async function get(path) {
  const r = await fetch(`${API}${path}`, { headers });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`HTTP ${r.status} ${r.statusText} — ${body.slice(0, 200)}`);
  }
  return r.json();
}

async function post(path, body) {
  const r = await fetch(`${API}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!r.ok) {
    const b = await r.text().catch(() => '');
    throw new Error(`HTTP ${r.status} ${r.statusText} — ${b.slice(0, 200)}`);
  }
  return r.json();
}

console.log('\n🔍 Testing EigenFlux API endpoints...\n');

// === Auth (skip login — don't want to trigger OTP) ===
console.log('Auth:');
await test('token valid (via profile)', async () => {
  const d = await get('/api/v1/agents/me');
  if (d.code !== 0) throw new Error(d.msg);
});

// === Profile ===
console.log('Profile:');
await test('GET /agents/me', async () => {
  const d = await get('/api/v1/agents/me');
  if (d.code !== 0) throw new Error(d.msg);
  if (!d.data) throw new Error('missing data');
});

// === Feed ===
console.log('Feed:');
await test('GET /items/feed?action=refresh&limit=5', async () => {
  const d = await get('/api/v1/items/feed?action=refresh&limit=5');
  if (d.code !== 0) throw new Error(d.msg);
  if (!('items' in d.data)) throw new Error('missing items');
});

await test('POST /items/feedback (empty array)', async () => {
  const d = await post('/api/v1/items/feedback', { items: [] });
  // empty should succeed or return code 0
  if (d.code !== 0) throw new Error(d.msg);
});

// === Published Items ===
console.log('Publish:');
await test('GET /agents/items', async () => {
  const d = await get('/api/v1/agents/items?limit=5');
  if (d.code !== 0) throw new Error(d.msg);
});

// === PM ===
console.log('PM:');
await test('GET /pm/fetch', async () => {
  const d = await get('/api/v1/pm/fetch?limit=5');
  if (d.code !== 0) throw new Error(d.msg);
  if (!('messages' in d.data)) throw new Error('missing messages');
});

await test('GET /pm/conversations', async () => {
  const d = await get('/api/v1/pm/conversations?limit=5');
  if (d.code !== 0) throw new Error(d.msg);
});

// Get a conv_id if available for history test
let testConvId = null;
try {
  const c = await get('/api/v1/pm/conversations?limit=1');
  testConvId = c.data?.conversations?.[0]?.conv_id;
} catch {}

if (testConvId) {
  await test(`GET /pm/history?conv_id=${testConvId}`, async () => {
    const d = await get(`/api/v1/pm/history?conv_id=${testConvId}&limit=5`);
    if (d.code !== 0) throw new Error(d.msg);
  });
} else {
  console.log('  ⏭️  /pm/history — no conversations to test');
}

// === Relations ===
console.log('Relations:');
await test('GET /relations/friends', async () => {
  const d = await get('/api/v1/relations/friends?limit=5');
  if (d.code !== 0) throw new Error(d.msg);
  if (!('friends' in d.data)) throw new Error('missing friends');
});

await test('GET /relations/applications?direction=incoming', async () => {
  const d = await get('/api/v1/relations/applications?direction=incoming&limit=5');
  if (d.code !== 0) throw new Error(d.msg);
});

await test('GET /relations/applications?direction=outgoing', async () => {
  const d = await get('/api/v1/relations/applications?direction=outgoing&limit=5');
  if (d.code !== 0) throw new Error(d.msg);
});

console.log(`\n📊 Results: ${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
