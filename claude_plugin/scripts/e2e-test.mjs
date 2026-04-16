#!/usr/bin/env node
/**
 * End-to-end test for the EigenFlux Claude Code plugin.
 *
 * Spawns a child `claude -p` process with the plugin loaded via --plugin-dir
 * and asserts that:
 *   1. The plugin loads without error.
 *   2. The eigenflux MCP server connects.
 *   3. At least one of the ef-* skills is discoverable.
 *   4. eigenflux MCP tools are registered.
 *
 * Writes a human-readable report to docs/e2e-test-report.md and exits
 * non-zero on any assertion failure.
 *
 * Run: node scripts/e2e-test.mjs
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = resolve(__dirname, '..');
const REPO_ROOT = resolve(PLUGIN_DIR, '..');
const REPORT_PATH = resolve(REPO_ROOT, 'docs', 'e2e-test-report.md');

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS || 180_000);

/**
 * Run one scenario: spawn claude -p with the plugin loaded, send `prompt`,
 * capture stream-json output, return parsed events + aggregated text.
 */
async function runScenario(label, prompt) {
  console.error(`\n── scenario: ${label} ────────────────────────────────────`);
  console.error(`prompt: ${prompt}`);

  // Use real HOME so the child inherits Claude auth. Plugin isolation comes
  // from --plugin-dir, not from sandboxing HOME.
  const args = [
    '-p',
    prompt,
    '--plugin-dir',
    PLUGIN_DIR,
    '--permission-mode',
    'bypassPermissions',
    '--output-format',
    'stream-json',
    '--verbose',
    '--no-session-persistence',
    '--setting-sources',
    'user',
  ];

  const env = { ...process.env };

  const child = spawn(CLAUDE_BIN, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });

  const events = [];
  const stderrChunks = [];
  let stdoutBuf = '';

  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString('utf8');
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        events.push({ type: 'raw', line });
      }
    }
  });
  child.stderr.on('data', (chunk) => stderrChunks.push(chunk));

  const exitCode = await new Promise((resolveP, rejectP) => {
    const killer = setTimeout(() => {
      console.error(`[e2e] scenario timed out after ${TIMEOUT_MS}ms, killing`);
      child.kill('SIGKILL');
    }, TIMEOUT_MS);
    child.on('error', (err) => { clearTimeout(killer); rejectP(err); });
    child.on('exit', (code) => { clearTimeout(killer); resolveP(code); });
  });

  if (stdoutBuf.trim()) {
    try { events.push(JSON.parse(stdoutBuf)); } catch { events.push({ type: 'raw', line: stdoutBuf }); }
  }

  const stderr = Buffer.concat(stderrChunks).toString('utf8');
  const allText = JSON.stringify(events) + '\n' + stderr;

  console.error(`exit_code=${exitCode} events=${events.length} stderr_bytes=${stderr.length}`);

  return { label, prompt, exitCode, events, stderr, allText };
}

function assert(cond, msg, results) {
  results.push({ pass: !!cond, msg });
  console.error(`[e2e] ${cond ? 'PASS' : 'FAIL'}: ${msg}`);
  return !!cond;
}

function eventsHaveText(events, regex) {
  for (const ev of events) {
    const serialized = JSON.stringify(ev);
    if (regex.test(serialized)) return true;
  }
  return false;
}

async function main() {
  if (!existsSync(resolve(PLUGIN_DIR, 'dist', 'channel.js'))) {
    console.error('[e2e] dist/channel.js missing. Run `pnpm build` first.');
    process.exit(2);
  }

  const results = [];
  const scenarios = [];

  // Scenario 1: skill listing — ask the agent which ef-* skills are available.
  const s1 = await runScenario(
    'skill-discovery',
    'List all skills whose name starts with "ef-" (EigenFlux skills: ef-broadcast, ef-communication, ef-profile). Reply with just the names, one per line. If none are available, reply only the single word NONE.',
  );
  scenarios.push(s1);

  // Scenario 2: MCP registration — ask agent to name eigenflux MCP tools.
  const s2 = await runScenario(
    'mcp-tools-discovery',
    'List every MCP tool you have available whose name contains the substring "eigenflux" (tools typically look like mcp__plugin_eigenflux_eigenflux__<toolname> or eigenflux_<toolname>). Reply one full tool name per line, no commentary. If none exist, reply only NONE.',
  );
  scenarios.push(s2);

  // Extract final "result" text (the agent's reply) for each scenario.
  const agentReply = (s) => {
    const r = s.events.find((e) => e.type === 'result');
    return typeof r?.result === 'string' ? r.result : '';
  };
  const reply1 = agentReply(s1);
  const reply2 = agentReply(s2);

  // Assertions.
  assert(s1.exitCode === 0, 'scenario 1 (skill discovery) exited 0', results);
  assert(s2.exitCode === 0, 'scenario 2 (mcp tools discovery) exited 0', results);

  assert(
    /ef-broadcast|ef-communication|ef-profile/i.test(reply1),
    `scenario 1 agent reply lists at least one ef-* skill; got: ${JSON.stringify(reply1).slice(0, 300)}`,
    results,
  );

  assert(
    /eigenflux/i.test(reply2) && !/^\s*NONE\s*$/i.test(reply2),
    `scenario 2 agent reply lists at least one eigenflux MCP tool; got: ${JSON.stringify(reply2).slice(0, 300)}`,
    results,
  );

  // MCP server connected check — look for the success line in verbose stream.
  const mcpConnectedInEvents = scenarios.some((s) =>
    /plugin:eigenflux:eigenflux.*Successfully connected|eigenflux.*MCP server connected via stdio/i.test(
      s.allText,
    ),
  );
  assert(
    mcpConnectedInEvents || /eigenflux/i.test(reply2),
    'eigenflux MCP server connected (either visible in stream or agent found eigenflux tools)',
    results,
  );

  // Report.
  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  const report = buildReport(scenarios, results);
  writeFileSync(REPORT_PATH, report, 'utf8');
  console.error(`\n[e2e] report written to ${REPORT_PATH}`);

  const failed = results.filter((r) => !r.pass);
  if (failed.length > 0) {
    console.error(`[e2e] ${failed.length} assertion(s) failed`);
    process.exit(1);
  }
  console.error('[e2e] all assertions passed');
}

function buildReport(scenarios, results) {
  const now = new Date().toISOString();
  const pass = results.filter((r) => r.pass).length;
  const total = results.length;
  const lines = [];
  lines.push('# EigenFlux Claude Code Plugin — End-to-End Test Report');
  lines.push('');
  lines.push(`**Run at:** ${now}`);
  lines.push(`**Result:** ${pass}/${total} assertions passed`);
  lines.push(`**Plugin dir:** \`${PLUGIN_DIR}\``);
  lines.push('');
  lines.push('## Assertions');
  lines.push('');
  for (const r of results) {
    lines.push(`- ${r.pass ? 'PASS' : 'FAIL'} — ${r.msg}`);
  }
  lines.push('');
  lines.push('## Scenarios');
  for (const s of scenarios) {
    lines.push('');
    lines.push(`### ${s.label}`);
    lines.push('');
    lines.push(`- **prompt:** \`${s.prompt}\``);
    lines.push(`- **exit_code:** ${s.exitCode}`);
    lines.push(`- **events:** ${s.events.length}`);
    lines.push(`- **stderr (tail):**`);
    lines.push('');
    lines.push('```');
    lines.push(s.stderr.slice(-2000));
    lines.push('```');
    const finalResult = s.events.find((e) => e.type === 'result');
    if (finalResult) {
      lines.push('');
      lines.push('- **final result event:**');
      lines.push('');
      lines.push('```json');
      lines.push(JSON.stringify(finalResult, null, 2).slice(0, 3000));
      lines.push('```');
    }
  }
  lines.push('');
  return lines.join('\n');
}

main().catch((err) => {
  console.error('[e2e] unhandled error:', err);
  process.exit(2);
});
