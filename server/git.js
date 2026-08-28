import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

const execFileP = promisify(execFile);

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
    const run = () => fn();
    const p = this._chain.then(run, run);
    this._chain = p.catch(() => {});
    return p;
  }

  async raw(args) {
    const { stdout } = await execFileP('git', args, {
      cwd: this.dir,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout;
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
    } catch {
      return null;
    }
  }

  /** All file paths under `prefix` at `ref`. */
  async lsFiles(ref, prefix) {
    try {
      const out = await this.raw(['ls-tree', '-r', '--name-only', ref, '--', prefix]);
      return out.split('\n').filter(Boolean);
    } catch {
      return [];
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

  async writeFile(relPath, content) {
    const abs = path.join(this.dir, relPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
  }
}
