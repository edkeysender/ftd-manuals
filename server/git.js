import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

const execFileP = promisify(execFile);

/** git stderr patterns meaning "that ref/path simply is not there" (not a failure). */
const MISSING_RE = /does not exist in|not a valid object name|invalid object name|exists on disk, but not in|unknown revision|bad revision|ambiguous argument/i;
/** Failures that come from the OS / process spawn rather than from git — worth a retry. */
const TRANSIENT_RE = /EAGAIN|ENOMEM|EBUSY|EPERM|ETIMEDOUT|spawn .* failed|Out of memory|OutOfMemory|Resource temporarily unavailable|index.lock/i;

export class GitMissingError extends Error {}
export class GitTransientError extends Error {}

// Each git call is a child process; under load the spawns themselves fail
// (EAGAIN / out-of-memory), so cap how many run at once.
const MAX_CONCURRENT = 8;
let running = 0;
const waiters = [];
function acquire() {
  if (running < MAX_CONCURRENT) {
    running++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiters.push(resolve));
}
function release() {
  const next = waiters.shift();
  if (next) next();
  else running--;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** execFile with optional stdin content (execFileP has no input option). */
function execFileWithInput(args, opts, input) {
  if (input === undefined) return execFileP('git', args, opts);
  return new Promise((resolve, reject) => {
    const child = execFile('git', args, opts, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      } else resolve({ stdout, stderr });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

/**
 * Thin wrapper around the git CLI for the document store repository.
 * All mutating operations must go through lock() — the store keeps a single
 * working tree and switches branches, so operations are strictly serialized.
 */
export class GitRepo {
  constructor(dir) {
    this.dir = dir;
    this._chain = Promise.resolve();
  }

  lock(fn) {
    const run = async () => {
      try {
        return await fn();
      } catch (e) {
        await this.recover().catch((re) => console.error('git recover failed:', re.message));
        throw e;
      }
    };
    const p = this._chain.then(run, run);
    this._chain = p.catch(() => {});
    return p;
  }

  /**
   * Put the working tree back on a clean main after a failed mutation. Every
   * change is committed inside the same lock() call that makes it, so anything
   * left behind here is a half-done operation, never user data.
   */
  async recover() {
    await this.raw(['reset', '-q', '--hard']);
    await this.raw(['clean', '-fdq']);
    await this.raw(['checkout', '-q', '-f', 'main']);
  }

  /**
   * Run git with the concurrency cap, retrying transient spawn/OS failures.
   * A "ref or path is not there" answer is raised as GitMissingError so
   * callers can tell it from a real failure instead of swallowing both.
   */
  async _exec(args, encoding, input) {
    const opts = { cwd: this.dir, maxBuffer: 64 * 1024 * 1024, windowsHide: true };
    if (encoding) opts.encoding = encoding;
    for (let attempt = 0; ; attempt++) {
      await acquire();
      try {
        const { stdout } = await execFileWithInput(args, opts, input);
        return stdout;
      } catch (e) {
        const text = [e.message || '', e.stderr || ''].join(' ');
        if (e.code === 128 && MISSING_RE.test(text)) throw new GitMissingError(text.trim());
        const transient = TRANSIENT_RE.test(text) || (typeof e.code === 'string' && e.code.startsWith('E'));
        if (!transient) throw e;
        if (attempt >= 3) throw new GitTransientError(`git ${args[0]} failed after ${attempt + 1} attempts: ${text.trim()}`);
        console.warn(`git ${args[0]}: transient failure, retrying (${attempt + 1}/3)`);
      } finally {
        release();
      }
      await sleep(150 * (attempt + 1));
    }
  }

  async raw(args) {
    return this._exec(args);
  }

  async rawBuffer(args) {
    return this._exec(args, 'buffer');
  }

  /**
   * Read many blobs in ONE git process: `git cat-file --batch` fed with
   * "<ref>:<path>" lines. Returns Map<"ref:path", Buffer|null> (null = missing).
   * A list is one spawn instead of one per file — the difference between
   * 15 s and 0.3 s for a cold module list on a slow-spawn machine.
   */
  async showMany(requests) {
    const keys = [...new Set(requests.map(({ ref, file }) => `${ref}:${file}`))];
    const out = new Map();
    if (!keys.length) return out;
    const buf = await this._exec(['cat-file', '--batch'], 'buffer', keys.join('\n') + '\n');
    let pos = 0;
    for (const key of keys) {
      const nl = buf.indexOf(0x0a, pos);
      if (nl === -1) break;
      const header = buf.toString('utf8', pos, nl);
      pos = nl + 1;
      // "<sha> <type> <size>" or "<object> missing" / "<object> ambiguous"
      const m = /^(\S+) (\S+) (\d+)$/.exec(header);
      if (!m || m[2] === 'missing' || m[2] === 'ambiguous') {
        out.set(key, null);
        continue;
      }
      const size = Number(m[3]);
      out.set(key, m[2] === 'blob' ? Buffer.from(buf.subarray(pos, pos + size)) : null);
      pos += size + 1; // content + trailing newline
    }
    for (const key of keys) if (!out.has(key)) out.set(key, null);
    return out;
  }

  /** Binary file content at ref:path (Buffer), or null. */
  async showBinary(ref, file) {
    try {
      return await this.rawBuffer(['show', `${ref}:${file}`]);
    } catch (e) {
      if (e instanceof GitMissingError) return null;
      throw e;
    }
  }

  async init() {
    const gitDir = path.join(this.dir, '.git');
    try {
      await fs.access(gitDir);
      return false;
    } catch {
      await fs.mkdir(this.dir, { recursive: true });
      await this.raw(['init', '-b', 'main']);
      await this.raw(['config', 'user.name', 'FTD Documentation Console']);
      await this.raw(['config', 'user.email', 'console@ftd.aero']);
      await fs.writeFile(
        path.join(this.dir, 'README.md'),
        '# FTD.aero module documentation\n\nManaged by the Documentation Console. One module = one folder under `modules/`.\nDrafts live on `draft/*` branches; release = merge to `main`.\n',
        'utf8'
      );
      await this.raw(['add', '-A']);
      await this.raw(['commit', '-m', 'Initialise document store']);
      return true;
    }
  }

  /** File content at ref:path, or null if it does not exist there. */
  async show(ref, file) {
    try {
      return await this.raw(['show', `${ref}:${file}`]);
    } catch (e) {
      if (e instanceof GitMissingError) return null;
      throw e;
    }
  }

  /** All file paths under `prefix` at `ref`. */
  async lsFiles(ref, prefix) {
    try {
      const out = await this.raw(['ls-tree', '-r', '--name-only', ref, '--', prefix]);
      return out.split('\n').filter(Boolean);
    } catch (e) {
      if (e instanceof GitMissingError) return [];
      throw e;
    }
  }

  async branches() {
    const out = await this.raw(['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
    return out.split('\n').filter(Boolean);
  }

  async currentBranch() {
    return (await this.raw(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  }

  async lastCommit(ref = 'HEAD') {
    try {
      const out = await this.raw(['log', ref, '-1', '--pretty=format:%H%x1f%aI%x1f%s']);
      const [hash, date, subject] = out.split('\x1f');
      return { hash, date, subject };
    } catch {
      return null;
    }
  }

  /** Commit log for a path on a ref. */
  async log(ref, prefix, limit = 50) {
    try {
      const args = ['log', ref, `-${limit}`, '--pretty=format:%H%x1f%aI%x1f%an%x1f%s'];
      if (prefix) args.push('--', prefix);
      const out = await this.raw(args);
      return out
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [hash, date, author, subject] = line.split('\x1f');
          return { hash, date, author, subject };
        });
    } catch {
      return [];
    }
  }

  async checkout(branch) {
    await this.raw(['checkout', '-q', branch]);
  }

  async createBranch(branch, from = 'main') {
    await this.raw(['checkout', '-q', '-b', branch, from]);
  }

  async commitAll(message) {
    await this.raw(['add', '-A']);
    try {
      await this.raw(['commit', '-m', message]);
      return true;
    } catch (e) {
      const text = `${e.stdout || ''}${e.stderr || ''}`;
      if (/nothing to commit|nothing added to commit/i.test(text)) return false;
      throw e;
    }
  }

  async merge(branch, message) {
    await this.raw(['merge', '--no-ff', '-m', message, branch]);
  }

  async deleteBranch(branch) {
    await this.raw(['branch', '-D', branch]);
  }

  async removePath(relPath) {
    await this.raw(['rm', '-r', '-q', '--', relPath]);
  }

  async writeFile(relPath, content) {
    const abs = path.join(this.dir, relPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, typeof content === 'string' ? 'utf8' : undefined);
  }
}
