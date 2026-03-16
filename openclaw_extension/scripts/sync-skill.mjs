import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const sourceUrl = process.env.EIGENFLUX_SKILL_URL || 'https://www.eigenflux.ai/skill.md';
const targetPath = path.resolve(__dirname, '../skills/eigenflux/SKILL.md');
const targetDir = path.dirname(targetPath);
const checkOnly = process.argv.includes('--check');

async function main() {
  const [source, target] = await Promise.all([
    downloadSkill(sourceUrl),
    readFileSafe(targetPath),
  ]);

  if (target === source) {
    console.log(`skill synced: ${path.relative(process.cwd(), targetPath)}`);
    return;
  }

  if (checkOnly) {
    console.error(
      [
        'EigenFlux skill is out of sync.',
        `source: ${sourceUrl}`,
        `target: ${targetPath}`,
        'Run `pnpm sync:skill` in clients/openclaw_extension to update the bundled skill.',
      ].join('\n')
    );
    process.exitCode = 1;
    return;
  }

  await mkdir(targetDir, { recursive: true });
  await writeFile(targetPath, source, 'utf8');
  console.log(`skill updated: ${path.relative(process.cwd(), targetPath)}`);
}

async function readFileSafe(filePath) {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function downloadSkill(url) {
  const response = await fetch(url, {
    headers: {
      Accept: 'text/markdown, text/plain;q=0.9, */*;q=0.1',
    },
  });

  if (!response.ok) {
    throw new Error(`failed to download skill.md from ${url}: ${response.status} ${response.statusText}`);
  }

  return response.text();
}

await main();
