// store.ts — in-memory forge store: repositories, git objects, issues, pull requests.
// No clock, no randomness: every id/timestamp derives from monotonic counters, so two
// runs that receive the same requests in the same order reach identical state.
import { createHash } from 'node:crypto';

export const ZERO_OID = '0'.repeat(40);
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const DEFAULT_BRANCH = 'main';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject { type: GitObjectType; data: Buffer }

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}
export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}
/** Pure-function memo for gid: ids derive from counters only, so the table only grows. */
const GID_CACHE = new Map<string, string>();
export function gid(kind: string, dbId: number, num = 0): string {
  const key = num ? `${kind}:${dbId}:${num}` : `${kind}:${dbId}`;
  let out = GID_CACHE.get(key);
  if (out === undefined) {
    out = Buffer.from(key).toString('base64');
    GID_CACHE.set(key, out);
  }
  return out;
}
export function decodeGid(id: string): { kind: string; dbId: number; num: number } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const m = /^([A-Za-z]+):(\d+)(?::(\d+))?$/.exec(text);
    if (!m) return null;
    return { kind: m[1], dbId: Number(m[2]), num: m[3] ? Number(m[3]) : 0 };
  } catch { return null; }
}
/** Deterministic ISO timestamp from a sequence number (never Date.now). Memoized: the same seq always formats the same way, and JSON builders call this per object. */
const TS_CACHE = new Map<number, string>();
export function tsFor(seq: number): string {
  let out = TS_CACHE.get(seq);
  if (out === undefined) {
    out = new Date((1700000000 + seq) * 1000).toISOString();
    TS_CACHE.set(seq, out);
  }
  return out;
}
export function identAt(seq: number): string {
  return `${VIEWER_LOGIN} <${VIEWER_EMAIL}> ${1700000000 + seq} +0000`;
}

export interface TreeEntry { mode: string; name: string; oid: string }
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    const nul = data.indexOf(0, sp);
    if (sp < 0 || nul < 0) break;
    entries.push({ mode: data.subarray(off, sp).toString('ascii'), name: data.subarray(sp + 1, nul).toString('utf8'), oid: data.subarray(nul + 1, nul + 21).toString('hex') });
    off = nul + 21;
  }
  return entries;
}
export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const la = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
    const lb = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
    return Buffer.compare(la, lb);
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}
export interface CommitView { tree: string; parents: string[]; author: string; committer: string; message: string }
export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const head = blank < 0 ? data.toString('utf8') : data.subarray(0, blank).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = ''; const parents: string[] = []; let author = ''; let committer = '';
  for (const line of head.split('\n')) {
    const sp = line.indexOf(' ');
    const k = sp < 0 ? line : line.slice(0, sp);
    const v = sp < 0 ? '' : line.slice(sp + 1);
    if (k === 'tree') tree = v; else if (k === 'parent') parents.push(v);
    else if (k === 'author') author = v; else if (k === 'committer') committer = v;
  }
  return { tree, parents, author, committer, message };
}
export function buildCommit(tree: string, parents: string[], message: string, seq: number): Buffer {
  const who = identAt(seq);
  const lines = [`tree ${tree}`, ...parents.map((p) => `parent ${p}`), `author ${who}`, `committer ${who}`, ''];
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}
export function parseTag(data: Buffer): { object: string; type: string; tag: string; message: string } {
  const blank = data.indexOf('\n\n');
  const head = blank < 0 ? data.toString('utf8') : data.subarray(0, blank).toString('utf8');
  const out: Record<string, string> = {};
  for (const line of head.split('\n')) {
    const sp = line.indexOf(' ');
    if (sp > 0) out[line.slice(0, sp)] = line.slice(sp + 1);
  }
  return { object: out.object ?? '', type: out.type ?? '', tag: out.tag ?? '', message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8') };
}

export interface Issue {
  id: number; gid: string; number: number; title: string; body: string;
  state: 'open' | 'closed'; labels: string[]; createdSeq: number; closedSeq: number | null;
}
export interface Pull {
  id: number; gid: string; number: number; title: string; body: string;
  state: 'open' | 'closed'; head: string; base: string; merged: boolean;
  mergedSeq: number | null; mergeCommitSha: string | null; createdSeq: number;
}
export interface Comment { id: number; gid: string; body: string; createdSeq: number }
export interface Label { name: string; color: string }

export class Repo {
  id: number; gid: string; name: string; owner: string;
  description: string; private: boolean; defaultBranch: string; createdSeq: number;
  objects = new Map<string, GitObject>();
  refs = new Map<string, string>();
  issues = new Map<number, Issue>();
  pulls = new Map<number, Pull>();
  labels = new Map<string, Label>();
  comments = new Map<number, Comment[]>();
  nextNumber = 1; nextIssueId = 100000; nextCommentId = 1; commitSeq = 0;
  /** Parsed-commit memo: objects are content-addressed and never mutated, so a parse stays valid. */
  commitCache = new Map<string, CommitView>();
  /** Serialized single-issue JSON memo, invalidated by any issue mutation (see invalidateIssueText). */
  issueTextCache = new Map<number, string>();
  /** Fetch pack memo: keyed by wants|haves|depth|shallow; objects only ever grow, and a fetch's
   *  reachable set from fixed wants is fixed once those commits exist, so a cached pack stays valid.
   *  Capped FIFO so a long trial cannot grow it without bound. */
  packCache = new Map<string, Buffer>();
  /** Parse a commit once and reuse it: the graph walks below re-read the same commits constantly. */
  parsedCommit(oid: string): CommitView | null {
    let out = this.commitCache.get(oid);
    if (out !== undefined) return out;
    const obj = this.objects.get(oid);
    if (!obj || obj.type !== 'commit') return null;
    out = parseCommit(obj.data);
    this.commitCache.set(oid, out);
    return out;
  }
  /** Drop one issue's serialized JSON after a mutation (PATCH, close, comment). */
  invalidateIssueText(number: number): void { this.issueTextCache.delete(number); }
  /** A fetch pack from the memo, or undefined when this exact fetch has not been built yet. */
  cachedPack(key: string): Buffer | undefined { return this.packCache.get(key); }
  /** Remember a built fetch pack, evicting the oldest entry past the cap. */
  rememberPack(key: string, pack: Buffer): void {
    if (this.packCache.has(key)) this.packCache.delete(key);
    this.packCache.set(key, pack);
    if (this.packCache.size > 64) {
      const oldest = this.packCache.keys().next().value;
      if (oldest !== undefined) this.packCache.delete(oldest);
    }
  }
  constructor(id: number, name: string, owner: string, description: string, priv: boolean, seq: number) {
    this.id = id; this.gid = gid('Repository', id); this.name = name; this.owner = owner;
    this.description = description; this.private = priv; this.defaultBranch = DEFAULT_BRANCH; this.createdSeq = seq;
  }
  putObject(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    return this.putObjectKnown(oid, type, data);
  }
  /** Store an object whose oid the caller already computed (a pack reader hashes every object it
   *  resolves): skips the second hash, identical result — an oid already present keeps its bytes. */
  putObjectKnown(oid: string, type: GitObjectType, data: Buffer): string {
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }
  ref(name: string): string | undefined { return this.refs.get(name); }
  tipOf(branch: string): string | undefined { return this.refs.get(`refs/heads/${branch}`); }
  /** All oids reachable from roots (commits -> tree+parents, tags -> target, trees -> entries). */
  reachable(roots: Iterable<string>): Set<string> {
    const seen = new Set<string>(); const queue: string[] = [];
    for (const r of roots) if (/^[0-9a-f]{40}$/.test(r)) queue.push(r);
    while (queue.length) {
      const oid = queue.pop()!;
      if (seen.has(oid)) continue;
      const obj = this.objects.get(oid);
      if (!obj) continue;
      seen.add(oid);
      if (obj.type === 'commit') {
        const c = this.parsedCommit(oid) ?? parseCommit(obj.data); queue.push(c.tree); for (const p of c.parents) queue.push(p);
      } else if (obj.type === 'tag') queue.push(parseTag(obj.data).object);
      else if (obj.type === 'tree') for (const e of parseTree(obj.data)) if (e.mode !== '160000') queue.push(e.oid);
    }
    return seen;
  }
  isAncestor(maybeAncestor: string, oid: string): boolean {
    if (maybeAncestor === oid) return true;
    const seen = new Set<string>(); const queue = [oid];
    while (queue.length) {
      const cur = queue.pop()!;
      if (seen.has(cur)) continue; seen.add(cur);
      const c = this.parsedCommit(cur);
      if (!c) continue;
      for (const p of c.parents) {
        if (p === maybeAncestor) return true;
        queue.push(p);
      }
    }
    return false;
  }
  /** First common ancestor of a and b (BFS from both sides, deterministic). */
  mergeBase(a: string, b: string): string | null {
    const ancA = new Set<string>(); const qa = [a];
    while (qa.length) {
      const cur = qa.pop()!;
      if (ancA.has(cur)) continue; ancA.add(cur);
      const c = this.parsedCommit(cur);
      if (c) for (const p of c.parents) qa.push(p);
    }
    const seen = new Set<string>(); const qb = [b];
    while (qb.length) {
      const cur = qb.pop()!;
      if (ancA.has(cur)) return cur;
      if (seen.has(cur)) continue; seen.add(cur);
      const c = this.parsedCommit(cur);
      if (c) for (const p of c.parents) qb.push(p);
    }
    return null;
  }
  /** Flatten the tree at a commit into path -> {mode, oid}. */
  flatten(commitOid: string): Map<string, { mode: string; oid: string }> {
    const out = new Map<string, { mode: string; oid: string }>();
    const c = this.parsedCommit(commitOid);
    if (!c) return out;
    const walk = (treeOid: string, prefix: string) => {
      const t = this.objects.get(treeOid);
      if (!t || t.type !== 'tree') return;
      for (const e of parseTree(t.data)) {
        const path = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.mode === '40000') walk(e.oid, path);
        else out.set(path, { mode: e.mode, oid: e.oid });
      }
    };
    walk(c.tree, '');
    return out;
  }
  /** Rebuild nested tree objects from a flat path map; returns the root tree oid. */
  buildTreeFromMap(flat: Map<string, { mode: string; oid: string }>): string {
    interface Node { files: Map<string, { mode: string; oid: string }>; dirs: Map<string, Node> }
    const root: Node = { files: new Map(), dirs: new Map() };
    for (const [path, entry] of [...flat.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const parts = path.split('/');
      let node = root;
      for (let i = 0; i < parts.length - 1; i += 1) {
        let next = node.dirs.get(parts[i]);
        if (!next) { next = { files: new Map(), dirs: new Map() }; node.dirs.set(parts[i], next); }
        node = next;
      }
      node.files.set(parts[parts.length - 1], entry);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, e] of node.files) entries.push({ mode: e.mode, name, oid: e.oid });
      for (const [name, sub] of node.dirs) entries.push({ mode: '40000', name, oid: build(sub) });
      return this.putObject('tree', buildTree(entries));
    };
    return build(root);
  }
  /** Commit one file change on a branch; creates the branch from the default tip if missing. */
  commitFile(branch: string, path: string, content: Buffer, message: string, remove = false): { commitSha: string; blobSha: string | null } {
    let tip = this.tipOf(branch);
    if (!tip) tip = this.tipOf(this.defaultBranch);
    const flat = tip ? this.flatten(tip) : new Map<string, { mode: string; oid: string }>();
    let blobSha: string | null = null;
    if (remove) flat.delete(path);
    else { blobSha = this.putObject('blob', content); flat.set(path, { mode: '100644', oid: blobSha }); }
    const treeOid = this.buildTreeFromMap(flat);
    this.commitSeq += 1;
    const commitData = buildCommit(treeOid, tip ? [tip] : [], message, this.commitSeq);
    const commitSha = this.putObject('commit', commitData);
    this.refs.set(`refs/heads/${branch}`, commitSha);
    return { commitSha, blobSha };
  }
  /** Diff base tree vs head tree (flat maps): path -> {status, oldOid, newOid}. */
  diffFiles(baseOid: string, headOid: string): Array<{ path: string; status: 'added' | 'modified' | 'removed'; oldOid: string | null; newOid: string | null }> {
    const base = this.flatten(baseOid); const head = this.flatten(headOid);
    const out: Array<{ path: string; status: 'added' | 'modified' | 'removed'; oldOid: string | null; newOid: string | null }> = [];
    const paths = new Set([...base.keys(), ...head.keys()]);
    for (const path of [...paths].sort()) {
      const b = base.get(path); const h = head.get(path);
      if (b && !h) out.push({ path, status: 'removed', oldOid: b.oid, newOid: null });
      else if (!b && h) out.push({ path, status: 'added', oldOid: null, newOid: h.oid });
      else if (b && h && b.oid !== h.oid) out.push({ path, status: 'modified', oldOid: b.oid, newOid: h.oid });
    }
    return out;
  }
  /** True when merging head into base would conflict (same path changed both sides differently). */
  mergeConflicts(headTip: string, baseTip: string): boolean {
    const mb = this.mergeBase(headTip, baseTip);
    if (!mb) return false;
    const baseSide = new Map(this.diffFiles(mb, baseTip).map((d) => [d.path, d.newOid ?? '']));
    const headSide = this.diffFiles(mb, headTip);
    for (const d of headSide) {
      if (baseSide.has(d.path) && baseSide.get(d.path) !== (d.newOid ?? '')) return true;
    }
    return false;
  }
  /** Squash-merge a pull request onto its base branch. Returns the merge commit sha or null on conflict. */
  squashMerge(pr: Pull): string | null {
    const headTip = this.tipOf(pr.head); const baseTip = this.tipOf(pr.base);
    if (!headTip || !baseTip) return null;
    if (this.mergeConflicts(headTip, baseTip)) return null;
    const mb = this.mergeBase(headTip, baseTip) ?? baseTip;
    const merged = this.flatten(baseTip);
    for (const d of this.diffFiles(mb, headTip)) {
      if (d.status === 'removed') merged.delete(d.path);
      else if (d.newOid) merged.set(d.path, { mode: '100644', oid: d.newOid });
    }
    const treeOid = this.buildTreeFromMap(merged);
    this.commitSeq += 1;
    const commitData = buildCommit(treeOid, [baseTip], `Merge pull request #${pr.number}: ${pr.title}`, this.commitSeq);
    const sha = this.putObject('commit', commitData);
    this.refs.set(`refs/heads/${pr.base}`, sha);
    pr.state = 'closed'; pr.merged = true; pr.mergeCommitSha = sha; pr.mergedSeq = this.commitSeq;
    return sha;
  }
  peel(oid: string): string {
    let cur = oid; const seen = new Set<string>();
    while (!seen.has(cur)) {
      seen.add(cur);
      const obj = this.objects.get(cur);
      if (!obj || obj.type !== 'tag') return cur;
      cur = parseTag(obj.data).object;
    }
    return cur;
  }
}

export class Store {
  repos = new Map<string, Repo>();
  repoSeq = 0; nextRepoId = 5000; seq = 0;
  nextSeq(): number { this.seq += 1; return this.seq; }
  key(owner: string, name: string): string { return `${owner}/${name}`; }
  getRepo(owner: string, name: string): Repo | undefined { return this.repos.get(this.key(owner, name)); }
  getRepoById(dbId: number): Repo | undefined {
    for (const r of this.repos.values()) if (r.id === dbId) return r;
    return undefined;
  }
  createRepo(name: string, description: string, priv: boolean): Repo | null {
    if (this.repos.has(this.key(VIEWER_LOGIN, name))) return null;
    this.nextRepoId += 1;
    const repo = new Repo(this.nextRepoId, name, VIEWER_LOGIN, description, priv, this.nextSeq());
    this.repos.set(this.key(VIEWER_LOGIN, name), repo);
    return repo;
  }
  deleteRepo(owner: string, name: string): boolean { return this.repos.delete(this.key(owner, name)); }
  viewerRepos(): Repo[] { return [...this.repos.values()].filter((r) => r.owner === VIEWER_LOGIN).sort((a, b) => a.createdSeq - b.createdSeq); }
}

export function userJson(login: string, id: number): Record<string, unknown> {
  return { login, id, node_id: gid('User', id), avatar_url: '', gravatar_id: '', url: `/api/v3/users/${login}`, html_url: `https://example.invalid/${login}`, type: 'User', site_admin: false, name: login, email: `${login}@example.invalid` };
}
export function repoJson(r: Repo): Record<string, unknown> {
  return {
    id: r.gid, databaseId: r.id, node_id: r.gid, name: r.name, full_name: `${r.owner}/${r.name}`,
    owner: userJson(r.owner, VIEWER_ID), private: r.private, html_url: `https://example.invalid/${r.owner}/${r.name}`,
    description: r.description, fork: false, url: `/api/v3/repos/${r.owner}/${r.name}`,
    created_at: tsFor(r.createdSeq), updated_at: tsFor(r.createdSeq), pushed_at: tsFor(r.createdSeq),
    homepage: null, size: r.objects.size, stargazers_count: 0, watchers_count: 0, language: null,
    has_issues: true, has_projects: true, has_downloads: true, has_wiki: true, has_pages: false,
    forks_count: 0, open_issues_count: [...r.issues.values()].filter((i) => i.state === 'open').length,
    license: null, topics: [], default_branch: r.defaultBranch, permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}
export function issueJson(r: Repo, i: Issue): Record<string, unknown> {
  return {
    id: i.id, node_id: i.gid, number: i.number, title: i.title, body: i.body, state: i.state,
    user: userJson(VIEWER_LOGIN, VIEWER_ID), labels: i.labels.map((name) => labelJson(r, name)),
    assignee: null, assignees: [], milestone: null, locked: false, comments: (r.comments.get(i.number) ?? []).length,
    created_at: tsFor(i.createdSeq), updated_at: tsFor(i.closedSeq ?? i.createdSeq),
    closed_at: i.closedSeq === null ? null : tsFor(i.closedSeq),
    author_association: 'OWNER', html_url: `https://example.invalid/${r.owner}/${r.name}/issues/${i.number}`,
    url: `/api/v3/repos/${r.owner}/${r.name}/issues/${i.number}`, repository_url: `/api/v3/repos/${r.owner}/${r.name}`,
  };
}
export function labelJson(r: Repo, name: string): Record<string, unknown> {
  const l = r.labels.get(name);
  return { id: 1000 + [...r.labels.keys()].indexOf(name), node_id: gid('Label', r.id, 1000 + [...r.labels.keys()].indexOf(name)), name, color: l?.color ?? 'ededed', default: false, description: '', url: `/api/v3/repos/${r.owner}/${r.name}/labels/${encodeURIComponent(name)}` };
}
/** Serialized single-issue JSON (with trailing newline, as sendJson writes it), memoized per issue:
 *  an issue's JSON only changes when the issue itself, its labels or its comment count changes, and
 *  every mutation site invalidates it — so a hot GET path can skip rebuilding and re-stringifying it.
 *  Byte-identical to JSON.stringify(issueJson(r, i)) + '\n' for the same state. */
export function issueJsonText(r: Repo, i: Issue): string {
  let out = r.issueTextCache.get(i.number);
  if (out === undefined) {
    out = `${JSON.stringify(issueJson(r, i))}\n`;
    r.issueTextCache.set(i.number, out);
  }
  return out;
}
export function pullJson(r: Repo, p: Pull): Record<string, unknown> {
  const headSha = r.tipOf(p.head) ?? ZERO_OID; const baseSha = r.tipOf(p.base) ?? ZERO_OID;
  return {
    id: p.id, node_id: p.gid, number: p.number, title: p.title, body: p.body, state: p.state,
    user: userJson(VIEWER_LOGIN, VIEWER_ID), locked: false, draft: false,
    head: { label: `${r.owner}:${p.head}`, ref: p.head, sha: headSha, user: userJson(VIEWER_LOGIN, VIEWER_ID), repo: repoJson(r) },
    base: { label: `${r.owner}:${p.base}`, ref: p.base, sha: baseSha, user: userJson(VIEWER_LOGIN, VIEWER_ID), repo: repoJson(r) },
    merged: p.merged, mergeable: p.merged ? false : !mergeConflictOf(r, p), mergeable_state: p.merged ? 'unknown' : (mergeConflictOf(r, p) ? 'dirty' : 'clean'),
    merge_commit_sha: p.mergeCommitSha, merged_at: p.mergedSeq === null ? null : tsFor(p.mergedSeq),
    created_at: tsFor(p.createdSeq), updated_at: tsFor(p.mergedSeq ?? p.createdSeq), closed_at: p.state === 'closed' ? tsFor(p.mergedSeq ?? p.createdSeq) : null,
    html_url: `https://example.invalid/${r.owner}/${r.name}/pull/${p.number}`,
    url: `/api/v3/repos/${r.owner}/${r.name}/pulls/${p.number}`,
    comments: 0, review_comments: 0, commits: 1, additions: 0, deletions: 0, changed_files: 0,
  };
}
export function mergeConflictOf(r: Repo, p: Pull): boolean {
  const headTip = r.tipOf(p.head); const baseTip = r.tipOf(p.base);
  if (!headTip || !baseTip || p.merged) return false;
  return r.mergeConflicts(headTip, baseTip);
}
export function commentJson(r: Repo, issueNumber: number, c: Comment): Record<string, unknown> {
  return {
    id: c.id, node_id: c.gid, body: c.body, user: userJson(VIEWER_LOGIN, VIEWER_ID),
    created_at: tsFor(c.createdSeq), updated_at: tsFor(c.createdSeq),
    html_url: `https://example.invalid/${r.owner}/${r.name}/issues/${issueNumber}#issuecomment-${c.id}`,
    url: `/api/v3/repos/${r.owner}/${r.name}/issues/comments/${c.id}`,
    issue_url: `/api/v3/repos/${r.owner}/${r.name}/issues/${issueNumber}`,
  };
}
export function lineCount(r: Repo, oid: string | null): number {
  if (!oid) return 0;
  const obj = r.objects.get(oid);
  if (!obj || obj.type !== 'blob') return 0;
  const text = obj.data.toString('utf8');
  return text === '' ? 0 : text.split('\n').length;
}
