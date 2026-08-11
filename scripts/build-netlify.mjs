import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import AdmZip from 'adm-zip';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'server', 'public');
const EXTENSION_DIR = path.join(ROOT, 'extension');
const EXTENSION_ZIP = path.join(PUBLIC_DIR, 'extension.zip');

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function addDirectoryToZip(zip, dir, zipRoot) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const zipPath = path.posix.join(zipRoot, entry.name);
    if (entry.isDirectory()) {
      await addDirectoryToZip(zip, fullPath, zipPath);
    } else if (entry.isFile()) {
      zip.addLocalFile(fullPath, path.posix.dirname(zipPath));
    }
  }
}

async function buildExtensionZip() {
  if (!existsSync(EXTENSION_DIR)) {
    console.warn('extension directory not found, skip extension.zip');
    return;
  }

  await ensureDir(PUBLIC_DIR);
  const zip = new AdmZip();
  await addDirectoryToZip(zip, EXTENSION_DIR, 'extension');
  zip.writeZip(EXTENSION_ZIP);
  console.log(`created ${path.relative(ROOT, EXTENSION_ZIP)}`);
}

try {
  console.log('Build started...');
  console.log('Node version:', process.version);
  console.log('ROOT:', ROOT);
  console.log('PUBLIC_DIR:', PUBLIC_DIR);
  console.log('EXTENSION_DIR:', EXTENSION_DIR);
  console.log('EXTENSION_DIR exists:', existsSync(EXTENSION_DIR));
  await buildExtensionZip();
  console.log('Build completed successfully.');
} catch (err) {
  console.error('Build error:', err.message);
  console.error(err.stack);
  // Don't fail the build for extension.zip issues
  console.warn('Continuing despite extension.zip build error...');
}
