import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Package the built Firefox extension.
 *
 * Unlike the Chrome bridge (which ships its source directory and a prebuilt
 * `dist/background.js`), this extension is produced by Extension.js. `npm run
 * build` emits `dist/firefox/`; this script verifies the emitted manifest and
 * copies that ready-to-load folder to --out for zipping/submission.
 *
 * Usage: node scripts/package-release.mjs [--out <dir>]
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(extensionDir, '..');
const builtDir = path.join(extensionDir, 'dist', 'firefox');

function parseArgs(argv) {
  const args = { outDir: path.join(repoRoot, 'extension-firefox-package') };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out' && argv[i + 1]) {
      const outDir = argv[++i];
      args.outDir = path.isAbsolute(outDir) ? outDir : path.resolve(process.cwd(), outDir);
    }
  }
  return args;
}

async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function isLocalAsset(ref) {
  return (
    typeof ref === 'string' &&
    ref.length > 0 &&
    !ref.startsWith('http://') &&
    !ref.startsWith('https://') &&
    !ref.startsWith('//') &&
    !ref.startsWith('data:') &&
    !ref.startsWith('#')
  );
}

function collectManifestEntrypoints(manifest) {
  const files = new Set(['manifest.json']);
  const add = (ref) => {
    if (isLocalAsset(ref)) files.add(ref);
  };
  add(manifest.background?.service_worker);
  add(manifest.background?.page);
  for (const script of manifest.background?.scripts ?? []) add(script);
  add(manifest.action?.default_popup);
  add(manifest.options_page);
  add(manifest.options_ui?.page);
  for (const ref of Object.values(manifest.icons ?? {})) add(ref);
  for (const ref of Object.values(manifest.action?.default_icon ?? {})) add(ref);
  return [...files];
}

async function main() {
  const { outDir } = parseArgs(process.argv.slice(2));

  if (!(await exists(builtDir))) {
    console.error(`Built extension not found at ${path.relative(repoRoot, builtDir)}.`);
    console.error('Run "npm run build" (extension build --browser=firefox) first.');
    process.exit(1);
  }

  const manifestPath = path.join(builtDir, 'manifest.json');
  if (!(await exists(manifestPath))) {
    console.error('Built output has no manifest.json — the Firefox build did not complete.');
    process.exit(1);
  }
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));

  const requiredEntries = collectManifestEntrypoints(manifest);
  const missing = [];
  for (const relativePath of requiredEntries) {
    if (!(await exists(path.join(builtDir, relativePath)))) missing.push(relativePath);
  }
  if (missing.length > 0) {
    console.error('Built Firefox extension is missing files referenced by manifest.json:');
    for (const entry of missing) console.error(`- ${entry}`);
    process.exit(1);
  }

  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });
  await fs.cp(builtDir, outDir, { recursive: true });

  const version = manifest.version ?? '0.0.0';
  console.log(`Firefox extension v${version} packaged at ${path.relative(repoRoot, outDir) || outDir}`);
}

await main();
