// store.ts — the forge's in-memory state: repositories, refs, objects, issues,
// pull requests, labels and comments, plus the contents and merge operations that
// turn those records into git objects. One Store per process; nothing is written
// to disk, so every operation is a Map lookup and the timed workloads stay fast.

import {
  ZERO_OID,
  buildCommit,
  buildTreeFromFiles,
  collectReachable,
  commitAncestors,
  flattenFiles,
  forgeIdentity,
  hashObject,
  isObjectId,
  mergeBase,
  parseCommit,
  parseTag,
  parseTree,
  type GitObject,
} from './git.ts';

export const DEFAULT_BRANCH = 'main';
export const FORGE_NAME = 'makefun-forge';
export const FORGE_VERSION = '1.0.0';

// ---------------------------------------------------------------------------------------------
// global ids (GraphQL): opaque, stable across reads, never a bare database id
// ---------------------------------------------------------------------------------------------

export function gid(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from([kind, ...parts.map(String)].join(':'), 'utf8').toString('base64url');
}

export function parseGid(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (!kind || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// records
// ---------------------------------------------------------------------------------------------

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface IssueComment {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: IssueComment[];
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  comments: IssueComment[];
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: number;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  labels: Map<string, Label>;
  issues: Issue[];
  issueByNumber: Map<number, Issue>;
  pulls: Pull[];
  pullByNumber: Map<number, Pull>;
  nextIssueNumber: number;
  nextPrNumber: number;
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------------------------------------
// the store
// ---------------------------------------------------------------------------------------------

export class Store {
  readonly token: string;
  viewerLogin: string | null = null;
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextIssueId = 1;
  private nextCommentId = 1;
  private nextPrId = 1;
  private nextLabelId = 1;
  private seq = 0;

  constructor(token: string) {
    this.token = token;
  }

  nowIso(): string {
    return new Date().toISOString();
  }

  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  // -- viewer binding ---------------------------------------------------------------
  //
  // The shop token is opaque (shpat_<32 hex>): it names no login. The first
  // owner-bearing request in the trial is always the viewer's, so the login is
  // learned lazily from it and every later owner is checked against it.

  bindViewer(owner: string): void {
    if (this.viewerLogin === null) this.viewerLogin = owner;
  }

  isViewer(owner: string): boolean {
    if (this.viewerLogin === null) {
      this.viewerLogin = owner;
      return true;
    }
    return this.viewerLogin === owner;
  }

  /** A repo-scoped lookup: unknown owner or unknown name is a 404, never a 403. */
  repoFor(owner: string, name: string): Repo | null {
    if (!this.isViewer(owner)) return null;
    return this.repos.get(name) ?? null;
  }

  repoById(id: number): Repo | null {
    for (const repo of this.repos.values()) if (repo.id === id) return repo;
    return null;
  }

  // -- repositories -----------------------------------------------------------------

  createRepo(name: string, isPrivate: boolean, description: string): Repo {
    if (this.repos.has(name)) throw new HttpError(422, `Repository already exists: ${name}`);
    const now = this.nowIso();
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      description: description ?? '',
      isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      createdSeq: this.nextSeq(),
      createdAt: now,
      updatedAt: now,
      refs: new Map(),
      objects: new Map(),
      labels: new Map(),
      issues: [],
      issueByNumber: new Map(),
      pulls: [],
      pullByNumber: new Map(),
      nextIssueNumber: 1,
      nextPrNumber: 1,
    };
    this.repos.set(name, repo);
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(repo.name);
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.createdSeq - b.createdSeq);
  }

  // -- refs -------------------------------------------------------------------------

  defaultRef(repo: Repo): string {
    return `refs/heads/${repo.defaultBranch}`;
  }

  /** Tip of a branch (short name, full ref, or a raw commit oid), or ZERO_OID unborn. */
  resolveBranchTip(repo: Repo, branch: string | undefined): string {
    if (!branch) return repo.refs.get(this.defaultRef(repo)) ?? ZERO_OID;
    if (isObjectId(branch)) return branch;
    const full = branch.startsWith('refs/') ? branch : `refs/heads/${branch}`;
    return repo.refs.get(full) ?? ZERO_OID;
  }

  /** Resolve a contents ?ref= value: branch, tag, full ref, or raw commit oid. */
  resolveRef(repo: Repo, ref: string | undefined): string {
    if (!ref) return repo.refs.get(this.defaultRef(repo)) ?? ZERO_OID;
    if (isObjectId(ref)) return ref;
    if (ref.startsWith('refs/')) {
      const oid = repo.refs.get(ref);
      if (oid) return this.peelToCommit(repo, oid);
      return ZERO_OID;
    }
    const branchOid = repo.refs.get(`refs/heads/${ref}`);
    if (branchOid) return branchOid;
    const tagOid = repo.refs.get(`refs/tags/${ref}`);
    if (tagOid) return this.peelToCommit(repo, tagOid);
    return ZERO_OID;
  }

  /** Follow a tag object to the commit it points at (possibly through more tags). */
  peelToCommit(repo: Repo, oid: string): string {
    let current = oid;
    for (let depth = 0; depth < 10; depth += 1) {
      const object = repo.objects.get(current);
      if (!object) return current;
      if (object.type === 'tag') {
        current = parseTag(object.data).object;
        continue;
      }
      return current;
    }
    return current;
  }

  /** The commit a ref resolves to, or null when the ref is unborn or unknown. */
  refCommit(repo: Repo, ref: string): { oid: string; commit: ReturnType<typeof parseCommit> } | null {
    const oid = this.resolveRef(repo, ref);
    if (oid === ZERO_OID) return null;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') return null;
    return { oid, commit: parseCommit(object.data) };
  }

  listBranches(repo: Repo): Array<{ name: string; sha: string }> {
    const out: Array<{ name: string; sha: string }> = [];
    for (const [ref, sha] of repo.refs) {
      if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), sha });
    }
    out.sort((a, b) => (a.name < b.name ? -1 : 1));
    return out;
  }

  /** All refs for advertisement, HEAD first, then branches, then tags. */
  listRefs(repo: Repo): Array<{ name: string; oid: string }> {
    const out: Array<{ name: string; oid: string }> = [];
    const tip = repo.refs.get(this.defaultRef(repo));
    if (tip) out.push({ name: 'HEAD', oid: tip });
    for (const [ref, oid] of [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      out.push({ name: ref, oid });
    }
    return out;
  }

  /** The peeled commit a tag ref points at, for ls-refs peel. Null for lightweight tags. */
  peeledCommit(repo: Repo, ref: string): string | null {
    const oid = repo.refs.get(ref);
    if (!oid) return null;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'tag') return null;
    const target = this.peelToCommit(repo, oid);
    return target === oid ? null : target;
  }

  // -- commits ----------------------------------------------------------------------

  listCommits(repo: Repo, ref: string | undefined, limit: number): Array<{ sha: string; message: string; author: string; committer: string }> {
    const tip = this.resolveRef(repo, ref);
    if (tip === ZERO_OID) return [];
    const out: Array<{ sha: string; message: string; author: string; committer: string }> = [];
    for (const oid of commitAncestors(repo.objects, tip)) {
      const object = repo.objects.get(oid);
      if (!object) continue;
      const commit = parseCommit(object.data);
      // The REST view shows the message as GitHub does: no trailing newline,
      // though the stored commit bytes keep it (git round-trips them exactly).
      out.push({ sha: oid, message: commit.message.replace(/\n+$/, ''), author: commit.author, committer: commit.committer });
      if (out.length >= limit) break;
    }
    return out;
  }

  /** Write a commit on a branch: new tree, new commit object, ref moves. */
  commitOnBranch(
    repo: Repo,
    branch: string,
    treeOid: string,
    message: string,
  ): { sha: string; parent: string } {
    const parent = this.resolveBranchTip(repo, branch);
    const epoch = Math.floor(Date.now() / 1000);
    const identity = forgeIdentity(epoch);
    const data = buildCommit({
      tree: treeOid,
      parents: parent === ZERO_OID ? [] : [parent],
      author: identity,
      committer: identity,
      message: message.endsWith('\n') ? message : `${message}\n`,
    });
    const sha = hashObject('commit', data);
    repo.objects.set(sha, { type: 'commit', data });
    repo.refs.set(`refs/heads/${branch}`, sha);
    return { sha, parent };
  }

  // -- contents ---------------------------------------------------------------------

  /** The tree a commit points at, as a flat file map. */
  treeFiles(repo: Repo, commitOid: string): Map<string, { oid: string; mode: string }> {
    const object = repo.objects.get(commitOid);
    if (!object || object.type !== 'commit') return new Map();
    return flattenFiles(repo.objects, parseCommit(object.data).tree);
  }

  /** Walk a tree to a path: the entry, plus its children when it is a directory. */
  lookupPath(
    repo: Repo,
    commitOid: string,
    path: string,
  ): { kind: 'file'; oid: string; mode: string; size: number } | { kind: 'dir'; entries: Array<{ name: string; path: string; oid: string; mode: string }> } | null {
    const object = repo.objects.get(commitOid);
    if (!object || object.type !== 'commit') return null;
    let treeOid = parseCommit(object.data).tree;
    const segments = path.split('/').filter((part) => part !== '');
    for (let index = 0; index < segments.length; index += 1) {
      const tree = repo.objects.get(treeOid);
      if (!tree || tree.type !== 'tree') return null;
      const entry = parseTree(tree.data).find((item) => item.name === segments[index]);
      if (!entry) return null;
      if (index === segments.length - 1) {
        if (entry.mode === '40000') {
          const dirTree = repo.objects.get(entry.oid);
          if (!dirTree || dirTree.type !== 'tree') return null;
          return {
            kind: 'dir',
            entries: parseTree(dirTree.data).map((child) => ({
              name: child.name,
              path: `${path}/${child.name}`,
              oid: child.oid,
              mode: child.mode,
            })),
          };
        }
        const blob = repo.objects.get(entry.oid);
        return { kind: 'file', oid: entry.oid, mode: entry.mode, size: blob ? blob.data.length : 0 };
      }
      if (entry.mode !== '40000') return null;
      treeOid = entry.oid;
    }
    // The path was empty: the root directory.
    const root = repo.objects.get(treeOid);
    if (!root || root.type !== 'tree') return null;
    return {
      kind: 'dir',
      entries: parseTree(root.data).map((child) => ({
        name: child.name,
        path: child.name,
        oid: child.oid,
        mode: child.mode,
      })),
    };
  }

  putContent(
    repo: Repo,
    path: string,
    content: Buffer,
    message: string,
    branch: string | undefined,
    expectedSha: string | undefined,
  ): { status: 201 | 200; commitSha: string; blobSha: string } {
    const branchName = branch ?? repo.defaultBranch;
    const tip = this.resolveBranchTip(repo, branchName);
    const files = tip === ZERO_OID ? new Map() : this.treeFiles(repo, tip);
    const existing = files.get(path);
    if (existing) {
      if (!expectedSha) throw new HttpError(422, `File already exists: ${path}`);
      if (expectedSha !== existing.oid) throw new HttpError(409, `sha does not match the current file: ${path}`);
    } else if (expectedSha) {
      throw new HttpError(422, `File does not exist: ${path}`);
    }
    const blobSha = hashObject('blob', content);
    repo.objects.set(blobSha, { type: 'blob', data: content });
    files.set(path, { oid: blobSha, mode: '100644' });
    const treeOid = buildTreeFromFiles(repo.objects, files);
    const { sha } = this.commitOnBranch(repo, branchName, treeOid, message);
    return { status: existing ? 200 : 201, commitSha: sha, blobSha };
  }

  deleteContent(
    repo: Repo,
    path: string,
    message: string,
    branch: string | undefined,
    expectedSha: string,
  ): { commitSha: string } {
    const branchName = branch ?? repo.defaultBranch;
    const tip = this.resolveBranchTip(repo, branchName);
    if (tip === ZERO_OID) throw new HttpError(404, `File does not exist: ${path}`);
    const files = this.treeFiles(repo, tip);
    const existing = files.get(path);
    if (!existing) throw new HttpError(404, `File does not exist: ${path}`);
    if (expectedSha !== existing.oid) throw new HttpError(409, `sha does not match the current file: ${path}`);
    files.delete(path);
    const treeOid = buildTreeFromFiles(repo.objects, files);
    const { sha } = this.commitOnBranch(repo, branchName, treeOid, message);
    return { commitSha: sha };
  }

  // -- labels, issues, comments ------------------------------------------------------

  createLabel(repo: Repo, name: string, color: string): Label {
    if (repo.labels.has(name)) throw new HttpError(422, `Label already exists: ${name}`);
    const label: Label = { id: this.nextLabelId++, name, color: color ?? 'ededed', description: '' };
    repo.labels.set(name, label);
    return label;
  }

  createIssue(repo: Repo, title: string, body: string, labelNames: string[]): Issue {
    const labels: Label[] = [];
    for (const name of labelNames) {
      const label = repo.labels.get(name);
      if (!label) throw new HttpError(422, `Label does not exist: ${name}`);
      labels.push(label);
    }
    const now = this.nowIso();
    const issue: Issue = {
      id: this.nextIssueId++,
      number: repo.nextIssueNumber++,
      title,
      body: body ?? '',
      state: 'open',
      labels,
      comments: [],
      createdSeq: this.nextSeq(),
      createdAt: now,
      updatedAt: now,
    };
    repo.issues.push(issue);
    repo.issueByNumber.set(issue.number, issue);
    return issue;
  }

  addComment(repo: Repo, issue: Issue, body: string): IssueComment {
    const now = this.nowIso();
    const comment: IssueComment = { id: this.nextCommentId++, body, createdAt: now, updatedAt: now };
    issue.comments.push(comment);
    issue.updatedAt = now;
    return comment;
  }

  listIssues(
    repo: Repo,
    state: string,
    direction: 'asc' | 'desc',
  ): Issue[] {
    let list = repo.issues;
    if (state === 'open') list = list.filter((issue) => issue.state === 'open');
    else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
    const sorted = [...list].sort((a, b) => (a.createdSeq - b.createdSeq) * (direction === 'asc' ? 1 : -1));
    return sorted;
  }

  // -- pull requests -----------------------------------------------------------------

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): Pull {
    const headSha = this.resolveBranchTip(repo, headRef);
    const baseSha = this.resolveBranchTip(repo, baseRef);
    if (headSha === ZERO_OID) throw new HttpError(422, `Head branch does not exist: ${headRef}`);
    if (baseSha === ZERO_OID) throw new HttpError(422, `Base branch does not exist: ${baseRef}`);
    for (const existing of repo.pulls) {
      if (existing.state === 'open' && existing.headRef === headRef && existing.baseRef === baseRef) {
        throw new HttpError(422, `A pull request already exists for ${headRef}`);
      }
    }
    const now = this.nowIso();
    const pull: Pull = {
      id: this.nextPrId++,
      number: repo.nextPrNumber++,
      title,
      body: body ?? '',
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef,
      baseRef,
      headSha,
      baseSha,
      comments: [],
      createdSeq: this.nextSeq(),
      createdAt: now,
      updatedAt: now,
    };
    repo.pulls.push(pull);
    repo.pullByNumber.set(pull.number, pull);
    return pull;
  }

  /** The 3-way mergeability of a pull request: MERGEABLE or CONFLICTING. */
  mergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' {
    const headTip = this.resolveBranchTip(repo, pull.headRef);
    const baseTip = this.resolveBranchTip(repo, pull.baseRef);
    if (headTip === ZERO_OID || baseTip === ZERO_OID) return 'CONFLICTING';
    const base = mergeBase(repo.objects, headTip, baseTip);
    const baseFiles = base ? this.treeFiles(repo, base) : new Map<string, { oid: string; mode: string }>();
    const headFiles = this.treeFiles(repo, headTip);
    const branchFiles = this.treeFiles(repo, baseTip);
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...branchFiles.keys()]);
    for (const path of paths) {
      const fromBase = baseFiles.get(path);
      const fromHead = headFiles.get(path);
      const fromBranch = branchFiles.get(path);
      const headChanged = (fromHead?.oid ?? null) !== (fromBase?.oid ?? null);
      const branchChanged = (fromBranch?.oid ?? null) !== (fromBase?.oid ?? null);
      if (headChanged && branchChanged && (fromHead?.oid ?? null) !== (fromBranch?.oid ?? null)) {
        return 'CONFLICTING';
      }
    }
    return 'MERGEABLE';
  }

  /** Squash-merge a pull request onto its base branch. Returns the merge commit sha. */
  squashMerge(repo: Repo, pull: Pull): string {
    if (this.mergeable(repo, pull) === 'CONFLICTING') {
      throw new HttpError(405, 'This branch has conflicts that must be resolved');
    }
    const headTip = this.resolveBranchTip(repo, pull.headRef);
    const baseTip = this.resolveBranchTip(repo, pull.baseRef);
    const base = mergeBase(repo.objects, headTip, baseTip);
    const baseFiles = base ? this.treeFiles(repo, base) : new Map<string, { oid: string; mode: string }>();
    const headFiles = this.treeFiles(repo, headTip);
    const branchFiles = this.treeFiles(repo, baseTip);
    const merged = new Map<string, { oid: string; mode: string }>();
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...branchFiles.keys()]);
    for (const path of paths) {
      const fromBase = baseFiles.get(path);
      const fromHead = headFiles.get(path);
      const fromBranch = branchFiles.get(path);
      const headChanged = (fromHead?.oid ?? null) !== (fromBase?.oid ?? null);
      if (headChanged) {
        if (fromHead) merged.set(path, fromHead);
      } else if (fromBranch) {
        merged.set(path, fromBranch);
      }
    }
    const treeOid = buildTreeFromFiles(repo.objects, merged);
    const message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`;
    const { sha } = this.commitOnBranch(repo, pull.baseRef, treeOid, message);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = this.nowIso();
    pull.mergeCommitSha = sha;
    pull.updatedAt = pull.mergedAt;
    return sha;
  }

  /** The files a pull request changes, diffed merge-base tree against head tree. */
  pullFiles(repo: Repo, pull: Pull): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
    const headTip = this.resolveBranchTip(repo, pull.headRef);
    const baseTip = this.resolveBranchTip(repo, pull.baseRef);
    const base = headTip !== ZERO_OID && baseTip !== ZERO_OID ? mergeBase(repo.objects, headTip, baseTip) : null;
    const baseFiles = base ? this.treeFiles(repo, base) : new Map<string, { oid: string; mode: string }>();
    const headFiles = headTip === ZERO_OID ? new Map<string, { oid: string; mode: string }>() : this.treeFiles(repo, headTip);
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
    const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
    for (const path of [...paths].sort()) {
      const fromBase = baseFiles.get(path);
      const fromHead = headFiles.get(path);
      if ((fromBase?.oid ?? null) === (fromHead?.oid ?? null)) continue;
      let status: string;
      let additions = 0;
      let deletions = 0;
      const blobText = (oid: string | undefined): string => {
        if (!oid) return '';
        const object = repo.objects.get(oid);
        return object ? object.data.toString('utf8') : '';
      };
      if (!fromBase && fromHead) {
        status = 'added';
        additions = countLines(blobText(fromHead.oid));
      } else if (fromBase && !fromHead) {
        status = 'removed';
        deletions = countLines(blobText(fromBase.oid));
      } else {
        status = 'modified';
        const diff = lineDiff(blobText(fromBase!.oid), blobText(fromHead!.oid));
        additions = diff.additions;
        deletions = diff.deletions;
      }
      out.push({ filename: path, status, additions, deletions, changes: additions + deletions });
    }
    return out;
  }

  listPulls(repo: Repo, state: string): Pull[] {
    let list = repo.pulls;
    if (state === 'open') list = list.filter((pull) => pull.state === 'open');
    else if (state === 'closed') list = list.filter((pull) => pull.state === 'closed');
    return [...list].sort((a, b) => b.createdSeq - a.createdSeq);
  }

  // -- git object helpers ------------------------------------------------------------

  /** Objects reachable from the wants, minus those reachable from the haves. */
  fetchObjects(repo: Repo, wants: string[], haves: string[]): GitObject[] {
    const haveReachable = collectReachable(repo.objects, haves);
    const wanted = collectReachable(repo.objects, wants);
    const out: GitObject[] = [];
    for (const oid of wanted) {
      if (haveReachable.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object) out.push(object);
    }
    return out;
  }
}

function countLines(text: string): number {
  if (text === '') return 0;
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

/** Added/removed line counts between two texts, by multiset difference of lines. */
function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  if (oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines[newLines.length - 1] === '') newLines.pop();
  const oldCounts = new Map<string, number>();
  for (const line of oldLines) oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of newLines) {
    const remaining = oldCounts.get(line) ?? 0;
    if (remaining > 0) oldCounts.set(line, remaining - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const remaining of oldCounts.values()) deletions += remaining;
  return { additions, deletions };
}
