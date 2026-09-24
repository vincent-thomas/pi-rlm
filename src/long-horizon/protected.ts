import { createReadStream } from 'node:fs';
import { cp, lstat, mkdir, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

// Git does not see ignored benchmark inputs. Keep their baseline outside the
// workspace, and never follow symlinks while scanning or copying them.
const snapshotDir = (jobDir: string) => join(jobDir, 'protected-baseline');
const manifestPath = (jobDir: string) => join(jobDir, 'protected-manifest.json');
type Manifest = Record<string, string>;

async function digest(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function scan(workspace: string, paths: string[]): Promise<Manifest> {
  const manifest: Manifest = {};
  async function visit(relativePath: string): Promise<void> {
    const fullPath = join(workspace, relativePath);
    let info;
    try { info = await lstat(fullPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    let fingerprint: string;
    if (info.isSymbolicLink()) fingerprint = 'link:' + await readlink(fullPath);
    else if (info.isDirectory()) fingerprint = 'directory';
    else if (info.isFile()) fingerprint = 'file:' + await digest(fullPath);
    else throw new Error('Unsupported protected filesystem entry: ' + relativePath);
    manifest[relativePath] = fingerprint + ':mode=' + (info.mode & 0o7777).toString(8);
    if (info.isDirectory()) {
      for (const child of (await readdir(fullPath)).sort()) await visit(join(relativePath, child));
    }
  }
  for (const path of paths) await visit(path);
  return manifest;
}

function firstDifference(expected: Manifest, actual: Manifest): string | undefined {
  return [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort()
    .find(path => expected[path] !== actual[path]);
}

export async function snapshotProtected(workspace: string, jobDir: string, paths: string[]): Promise<void> {
  const baseline = await scan(workspace, paths);
  const destination = snapshotDir(jobDir);
  await rm(destination, { recursive: true, force: true });
  for (const path of paths) {
    if (!(path in baseline)) continue;
    const target = join(destination, path);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(workspace, path), target, { recursive: true, dereference: false, force: true });
  }
  if (firstDifference(baseline, await scan(destination, paths))) {
    throw new Error('Protected paths changed while taking the baseline snapshot.');
  }
  await writeFile(manifestPath(jobDir), JSON.stringify(baseline));
}

export async function protectedSnapshotChange(workspace: string, jobDir: string, paths: string[]): Promise<string | undefined> {
  const baseline = JSON.parse(await readFile(manifestPath(jobDir), 'utf8')) as Manifest;
  return firstDifference(baseline, await scan(workspace, paths));
}

export async function restoreProtected(workspace: string, jobDir: string, paths: string[]): Promise<void> {
  const baseline = JSON.parse(await readFile(manifestPath(jobDir), 'utf8')) as Manifest;
  const destination = snapshotDir(jobDir);
  if (firstDifference(baseline, await scan(destination, paths))) throw new Error('Protected baseline snapshot was changed.');
  for (const path of paths) {
    await rm(join(workspace, path), { recursive: true, force: true });
    if (!(path in baseline)) continue;
    const target = join(workspace, path);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(destination, path), target, { recursive: true, dereference: false, force: true });
  }
  if (await protectedSnapshotChange(workspace, jobDir, paths)) throw new Error('Could not restore protected baseline.');
}
