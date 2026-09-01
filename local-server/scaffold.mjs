import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { starterPackById } from '../lib/local/starter-packs.ts';
import { WELCOME_MD, WELCOME_PATH } from '../lib/workspace/welcome-doc.ts';

/** Local YYYY-MM-DD (the machine the files land on, not UTC). */
export function localDateStamp(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Project names become folder names — keep them path-safe without being
 *  precious about it (spaces and unicode are fine; separators are not).
 *  Validates the TRIMMED name, since that's what paths are built from
 *  (`" .."` must not slip past a raw startsWith check). */
export function validProjectName(name) {
  if (typeof name !== 'string') return false;
  const trimmed = name.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= 120 &&
    !/[/\\:]/.test(trimmed) &&
    !trimmed.startsWith('.')
  );
}

/** True when `dir` doesn't exist or holds nothing but OS litter. */
async function isVacant(dir) {
  const entries = await fsp.readdir(dir).catch((error) => (error.code === 'ENOENT' ? null : Promise.reject(error)));
  if (entries === null) return true;
  return entries.every((entry) => entry === '.DS_Store');
}

/**
 * Create `<location>/<name>` and write the pack's folders + files into it.
 * `pack` may be null/'blank', which seeds the same welcome.md a new cloud
 * workspace gets — a blank project used to open on an empty file tree with
 * nothing to open. Throws Error with a user-facing `.message` (the endpoint
 * surfaces it verbatim).
 *
 * This is the ONLY local path that writes files, and it only ever runs after
 * `isVacant` proves the root is empty (or absent), so opening an existing
 * folder as a project (POST /projects) can never drop a file into work the
 * user already has.
 */
export async function createProjectDir({ name, location, pack }) {
  if (!validProjectName(name)) throw new Error('Project name must not contain / \\ : or start with a dot');
  if (typeof location !== 'string' || !path.isAbsolute(location)) {
    throw new Error('Location must be an absolute folder path');
  }
  const root = path.join(location, name.trim());
  if (!(await isVacant(root))) throw new Error(`${root} already exists and is not empty`);

  const definition = pack && pack !== 'blank' ? starterPackById(pack) : null;
  if (pack && pack !== 'blank' && !definition) {
    throw new Error(`Unknown starter pack "${pack}". Update Sundial to use it.`);
  }
  await fsp.mkdir(root, { recursive: true });
  if (!definition) {
    await fsp.writeFile(path.join(root, WELCOME_PATH), WELCOME_MD, 'utf8');
  } else {
    const date = localDateStamp();
    const fill = (text) => text.replaceAll('{{date}}', date);
    for (const folder of definition.folders) {
      await fsp.mkdir(path.join(root, folder), { recursive: true });
    }
    for (const file of definition.files) {
      const target = path.join(root, fill(file.path));
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, fill(file.content), 'utf8');
    }
  }
  return root;
}

/**
 * Accepts the shapes people paste — `owner/repo`, an https github.com URL
 * (with or without .git / trailing path), or the SSH form — and returns
 * `{ url, repo }` with a canonical https clone URL, or null.
 */
export function parseGitHubRepo(input) {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) return null;
  const NAME = /^[A-Za-z0-9_.-]+$/;
  let owner;
  let repo;
  const ssh = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/.exec(raw);
  const https = /^https:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/?#]+)/.exec(raw);
  const short = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(raw);
  if (ssh) [, owner, repo] = ssh;
  else if (https) [, owner, repo] = https;
  else if (short) [, owner, repo] = short;
  else return null;
  repo = repo.replace(/\.git$/, '');
  if (!NAME.test(owner) || !NAME.test(repo)) return null;
  return { url: `https://github.com/${owner}/${repo}.git`, repo };
}

/**
 * Clone into `<location>/<name>` (name defaults to the repo). Blobless clone —
 * full tree + history, file contents fetched on demand (the proven fast path
 * for big repos). Rejects with the tail of git's stderr on failure.
 */
export async function cloneGitHubRepo({ input, location, name }) {
  const parsed = parseGitHubRepo(input);
  if (!parsed) throw new Error('Enter a GitHub repository, like owner/repo or its URL');
  if (typeof location !== 'string' || !path.isAbsolute(location)) {
    throw new Error('Location must be an absolute folder path');
  }
  const folder = name?.trim() || parsed.repo;
  if (!validProjectName(folder)) throw new Error('Project name must not contain / \\ : or start with a dot');
  const dest = path.join(location, folder);
  if (!(await isVacant(dest))) throw new Error(`${dest} already exists and is not empty`);
  // A vacant dest may still hold OS litter, which git refuses to clone into.
  await fsp.rm(path.join(dest, '.DS_Store'), { force: true });
  await fsp.mkdir(location, { recursive: true });

  await new Promise((resolve, reject) => {
    const git = spawn('git', ['clone', '--filter=blob:none', parsed.url, dest], {
      stdio: ['ignore', 'ignore', 'pipe'],
      // Fail fast instead of hanging on a credential prompt for private repos.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    let stderr = '';
    git.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });
    const timer = setTimeout(() => {
      git.kill('SIGKILL');
      reject(new Error('git clone timed out after 10 minutes'));
    }, 10 * 60 * 1000);
    git.on('error', (error) => {
      clearTimeout(timer);
      reject(error.code === 'ENOENT' ? new Error('git is not installed on this machine') : error);
    });
    git.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      const detail = stderr.trim().split('\n').at(-1) || `git exited with code ${code}`;
      reject(new Error(detail.includes('could not read Username') ? 'Repository not found or private' : detail));
    });
  });
  return dest;
}
