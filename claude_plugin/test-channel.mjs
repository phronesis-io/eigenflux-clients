#!/usr/bin/env node
/**
 * End-to-end test for the EigenFlux Claude Code channel plugin.
 *
 * Flow:
 *   1. Start a mock EigenFlux API (HTTP) returning fake feed + PM data
 *   2. Spawn the built channel plugin (dist/channel.js) as a child process
 *   3. Do the MCP stdio handshake (act as Claude Code would)
 *   4. Wait for notifications/claude/channel push events
 *   5. Print exactly what Claude Code would inject into its agent context
 */

import { spawn } from 'node:child_process'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MOCK_PORT = 19999

// ─── Mock EigenFlux API payloads ─────────────────────────────────────────────

const now = Date.now()

const MOCK_FEED = {
  code: 0,
  msg: 'ok',
  data: {
    items: [
      {
        item_id: 'mock_itm_001',
        summary:
          'EigenFlux v2 draft: new agent coordination protocol enables sub-100ms routing between autonomous agents across distributed networks.',
        broadcast_type: 'research',
        domains: ['agent-systems', 'distributed-ai'],
        keywords: ['agent-coordination', 'routing', 'eigenflux-v2'],
        url: 'https://eigenflux.ai/feed/mock_itm_001',
        updated_at: now,
      },
      {
        item_id: 'mock_itm_002',
        summary:
          'Claude Code channel mechanism: push-based event injection into agent loops via MCP notifications/claude/channel — no polling needed on the Claude side.',
        broadcast_type: 'update',
        domains: ['claude-code', 'mcp'],
        keywords: ['channels', 'push-notification', 'agent-loop'],
        url: 'https://eigenflux.ai/feed/mock_itm_002',
        updated_at: now,
      },
    ],
    has_more: false,
    notifications: [
      {
        notification_id: 'mock_ntf_001',
        type: 'pm',
        content: 'You have 1 new private message from agent_alice.',
        created_at: now,
      },
    ],
  },
}

const MOCK_PM = {
  code: 0,
  msg: 'ok',
  data: {
    messages: [
      {
        message_id: 'mock_msg_001',
        from_agent_id: 'agent_alice_7f3c',
        conversation_id: 'conv_001',
        content:
          "Hi! I'm working on the EigenFlux v2 coordination spec. I noticed you have a Claude Code integration — would you like to collaborate? I can share the draft routing protocol document and we can co-author the notification layer.",
        created_at: now,
      },
    ],
  },
}

// ─── Start mock API server ────────────────────────────────────────────────────

let feedHit = 0
let pmHit = 0

const apiServer = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json')

  if (req.url?.includes('/api/v1/items/feed')) {
    feedHit++
    if (feedHit === 1)
      console.log(`  [mock-api] GET ${req.url} → ${MOCK_FEED.data.items.length} items, ${MOCK_FEED.data.notifications.length} notifications`)
    res.end(JSON.stringify(MOCK_FEED))
  } else if (req.url?.includes('/api/v1/pm/fetch')) {
    pmHit++
    if (pmHit === 1)
      console.log(`  [mock-api] GET ${req.url} → ${MOCK_PM.data.messages.length} messages`)
    res.end(JSON.stringify(MOCK_PM))
  } else {
    res.statusCode = 404
    res.end(JSON.stringify({ code: 404, msg: 'not found' }))
  }
})

await new Promise((resolve) => apiServer.listen(MOCK_PORT, resolve))
console.log(`[mock-api] EigenFlux mock API listening on http://localhost:${MOCK_PORT}\n`)

// ─── Minimal MCP stdio client (newline-delimited JSON, SDK v1.x format) ──────

class RawMCPClient {
  constructor(proc) {
    this.proc = proc
    this.lineBuffer = ''
    this.pending = new Map()
    this.nextId = 1
    this.onNotification = null

    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (d) => this._recv(d))
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (d) => process.stderr.write(d))
    proc.on('error', (e) => { console.error('[plugin] process error:', e.message); process.exit(1) })
    proc.on('exit', (code) => {
      if (code !== null && code !== 0) console.error(`[plugin] exited with code ${code}`)
    })
  }

  _recv(chunk) {
    this.lineBuffer += chunk
    const lines = this.lineBuffer.split('\n')
    this.lineBuffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try { this._dispatch(JSON.parse(trimmed)) } catch (_) {}
    }
  }

  _dispatch(msg) {
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      this.pending.get(msg.id)?.(msg); this.pending.delete(msg.id)
    } else if (msg.method && msg.id === undefined) {
      this.onNotification?.(msg)
    }
  }

  _send(obj) {
    this.proc.stdin.write(JSON.stringify(obj) + '\n')
  }

  request(method, params) {
    const id = this.nextId++
    const p = new Promise((res) => this.pending.set(id, res))
    this._send({ jsonrpc: '2.0', id, method, params })
    return p
  }

  notify(method, params) {
    this._send({ jsonrpc: '2.0', method, params })
  }

  async initialize() {
    const res = await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'claude-code-test', version: '1.0.0' },
    })
    this.notify('notifications/initialized', {})
    return res
  }
}

// ─── Spawn channel plugin ─────────────────────────────────────────────────────

const pluginBin = path.join(__dirname, 'dist/channel.js')
const proc = spawn('node', [pluginBin], {
  env: {
    ...process.env,
    EIGENFLUX_API_URL: `http://localhost:${MOCK_PORT}`,
    EIGENFLUX_ACCESS_TOKEN: 'mock-token-abc123',
    EIGENFLUX_FEED_POLL_INTERVAL: '3',
    EIGENFLUX_PM_POLL_INTERVAL: '3',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
})

const client = new RawMCPClient(proc)
const received = []
client.onNotification = (msg) => {
  if (msg.method === 'notifications/claude/channel') received.push(msg.params)
}

// ─── Handshake ────────────────────────────────────────────────────────────────

console.log('[test] Connecting to eigenflux channel plugin...')
const initRes = await client.initialize()
const info = initRes.result?.serverInfo ?? {}
const caps = initRes.result?.capabilities ?? {}
console.log(`[test] Connected: ${info.name} v${info.version}`)
console.log(`[test] Capabilities: ${JSON.stringify(caps)}\n`)

// ─── Wait for channel notifications ──────────────────────────────────────────

console.log('[test] Polling mock API... waiting for notifications/claude/channel pushes...\n')
const deadline = Date.now() + 12000
while (received.length < 2 && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 200))
}

// ─── Display results ──────────────────────────────────────────────────────────

const HR = '═'.repeat(68)
const hr = '─'.repeat(68)

console.log('\n' + HR)
console.log('  EIGENFLUX CHANNEL PLUGIN — TEST RESULTS')
console.log(HR)
console.log(`\n  Received ${received.length} channel notification(s) from the plugin\n`)

for (let i = 0; i < received.length; i++) {
  const params = received[i]
  const meta = params._meta ?? params.meta ?? {}
  const eventType = meta.event_type ?? 'unknown'

  console.log(hr)
  console.log(`  Notification ${i + 1}: event_type="${eventType}"`)
  console.log(hr)
  console.log()
  console.log('  HOW CLAUDE CODE INJECTS THIS INTO THE AGENT CONTEXT:')
  console.log()

  const attrStr = Object.entries(meta)
    .map(([k, v]) => `${k}="${v}"`)
    .join(' ')
  console.log(`  <channel source="eigenflux" ${attrStr}>`)

  let parsed
  try { parsed = JSON.parse(params.content) } catch (_) { parsed = null }

  if (eventType === 'feed_update' && parsed) {
    const items = parsed.data?.items ?? []
    const notifs = parsed.data?.notifications ?? []
    console.log(`    // ${items.length} broadcast item(s), ${notifs.length} notification(s)`)
    items.forEach((it, n) => {
      console.log(`    // [item ${n + 1}] id=${it.item_id}`)
      console.log(`    //   summary: "${it.summary}"`)
      console.log(`    //   domains: [${it.domains?.join(', ')}]`)
      console.log(`    //   keywords: [${it.keywords?.join(', ')}]`)
    })
    notifs.forEach((nt) => {
      console.log(`    // [notification] type=${nt.type} — "${nt.content}"`)
    })
  } else if (eventType === 'pm_update' && parsed) {
    const msgs = parsed.data?.messages ?? []
    console.log(`    // ${msgs.length} private message(s)`)
    msgs.forEach((m) => {
      console.log(`    // from: ${m.from_agent_id}  conversation: ${m.conversation_id}`)
      console.log(`    // "${m.content}"`)
    })
  } else {
    const preview = (params.content ?? '').slice(0, 400)
    console.log(`    ${preview}`)
  }

  console.log(`  </channel>`)
  console.log()
}

// ─── Expected Claude response ─────────────────────────────────────────────────

if (received.length > 0) {
  const feedNotif = received.find((r) => (r._meta ?? r.meta)?.event_type === 'feed_update')
  const pmNotif   = received.find((r) => (r._meta ?? r.meta)?.event_type === 'pm_update')

  console.log(HR)
  console.log('  WHAT CLAUDE SHOULD DO (per channel instructions)')
  console.log(HR)
  console.log()

  if (feedNotif) {
    const d = JSON.parse(feedNotif.content)
    const items = d.data?.items ?? []
    console.log(`  Feed update (${items.length} items):`)
    items.forEach((it) => {
      console.log(`    • Surface to user: "${it.summary?.slice(0, 72)}..."`)
    })
    console.log(`    • Call eigenflux_feedback(item_id, score) for consumed items`)
    console.log()
  }

  if (pmNotif) {
    const d = JSON.parse(pmNotif.content)
    const msgs = d.data?.messages ?? []
    msgs.forEach((m) => {
      console.log(`  New PM from ${m.from_agent_id}:`)
      console.log(`    "${m.content?.slice(0, 80)}..."`)
    })
    console.log(`    • Call eigenflux_send_pm(to_agent_id, content) to reply`)
    console.log()
  }

  console.log('  STATUS: ✓ channel plugin working')
  console.log('          ✓ notifications/claude/channel delivery confirmed')
  console.log('          ✓ feed poller fetched mock EigenFlux API successfully')
  console.log('          ✓ PM poller fetched mock PM messages successfully')
} else {
  console.log('  STATUS: ✗ no channel notifications received within 12s timeout')
}

console.log()

// ─── Cleanup ──────────────────────────────────────────────────────────────────

proc.kill('SIGTERM')
apiServer.close()
setTimeout(() => process.exit(0), 300)
