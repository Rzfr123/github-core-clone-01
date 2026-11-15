// app.ts — the forge server: git smart HTTP, REST v3, GraphQL v4 and MCP in one
// process over the in-memory store. Standard library only; no clock, no randomness
// in any stored state (counters only), so replays are deterministic.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  Store, Repo, VIEWER_LOGIN, VIEWER_ID, VIEWER_EMAIL, ZERO_OID, gid, decodeGid, tsFor,
  parseCommit, repoJson, issueJson, pullJson, labelJson, commentJson, lineCount, userJson, mergeConflictOf,
} from './store.ts';
import {
  pkt, pktLines, FLUSH, decodePackets, v0Advertisement, v2Advertisement, lsRefsResponse,
  v2FetchResponse, v0FetchResponse, parseReceiveBody, applyPush,
} from './git.ts';

const store = new Store();
const EXPECTED_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
let requestCounter = 0;

const JSON_TYPE = 'application/json; charset=utf-8';
type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = status === 204 ? '' : `${JSON.stringify(body)}\n`;
  const headers: Record<string, string> = { 'x-github-request-id': `req-${++requestCounter}`, ...extra };
  if (status !== 204) { headers['content-type'] = JSON_TYPE; headers['content-length'] = String(Buffer.byteLength(text)); }
  res.writeHead(status, headers);
  res.end(text);
}
function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': String(body.length), 'x-github-request-id': `req-${++requestCounter}` });
  res.end(body);
}
function errJson(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}
function authOk(req: IncomingMessage): boolean {
  const h = req.headers.authorization ?? '';
  if (!h.startsWith('Bearer ')) return false;
  const token = h.slice('Bearer '.length);
  if (token === '') return false;
  if (EXPECTED_TOKEN !== '') return token === EXPECTED_TOKEN;
  return true;
}
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJsonBody(req: IncomingMessage, res: ServerResponse): Promise<Json | null | undefined> {
  const raw = await readBody(req);
  if (raw.length === 0) return undefined;
  try { return JSON.parse(raw.toString('utf8')) as Json; }
  catch { errJson(res, 400, 'Problems parsing JSON'); return null; }
}
function urlOf(req: IncomingMessage): URL {
  return new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
}
function pathParts(req: IncomingMessage): string[] {
  return urlOf(req).pathname.split('/').filter((p) => p !== '');
}
function queryOf(req: IncomingMessage): URLSearchParams { return urlOf(req).searchParams; }
function numParam(q: URLSearchParams, name: string, fallback: number): number {
  const v = q.get(name);
  if (v === null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}
function pageLink(req: IncomingMessage, page: number, perPage: number): string {
  const u = urlOf(req);
  u.searchParams.set('page', String(page));
  u.searchParams.set('per_page', String(perPage));
  return `<${u.toString()}>; rel="next"`;
}
function paginate<T>(req: IncomingMessage, res: ServerResponse, items: T[]): void {
  const q = queryOf(req);
  const perPage = numParam(q, 'per_page', 30);
  const page = numParam(q, 'page', 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const extra: Record<string, string> = {};
  if (start + perPage < items.length) extra.link = pageLink(req, page + 1, perPage);
  sendJson(res, 200, slice, extra);
}
function getRepoOr404(res: ServerResponse, owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) { errJson(res, 404, 'Not Found'); return null; }
  const repo = store.getRepo(owner, name);
  if (!repo) { errJson(res, 404, 'Not Found'); return null; }
  return repo;
}
function issueByNumber(repo: Repo, n: number) { return repo.issues.get(n); }
function pullByNumber(repo: Repo, n: number) { return repo.pulls.get(n); }

function createIssueIn(repo: Repo, title: string, body: string, labels: string[]): { issue?: ReturnType<typeof issueJson>; status: number; message?: string } {
  for (const l of labels) if (!repo.labels.has(l)) return { status: 422, message: `Label '${l}' does not exist` };
  const number = repo.nextNumber++;
  const issue = {
    id: repo.nextIssueId++, gid: gid('Issue', repo.id, number), number,
    title, body, state: 'open' as const, labels: [...labels], createdSeq: store.nextSeq(), closedSeq: null,
  };
  repo.issues.set(number, issue);
  return { issue: issueJson(repo, issue), status: 201 };
}
function createPullIn(repo: Repo, title: string, body: string, head: string, base: string): { pull?: Json; status: number; message?: string } {
  const headName = head.includes(':') ? head.split(':').slice(1).join(':') : head;
  const baseName = base.includes(':') ? base.split(':').slice(1).join(':') : base;
  if (!repo.tipOf(headName)) return { status: 422, message: `Head branch '${headName}' does not exist` };
  if (!repo.tipOf(baseName)) return { status: 422, message: `Base branch '${baseName}' does not exist` };
  const number = repo.nextNumber++;
  const pr = {
    id: repo.nextIssueId++, gid: gid('PullRequest', repo.id, number), number,
    title, body, state: 'open' as const, head: headName, base: baseName, merged: false,
    mergedSeq: null, mergeCommitSha: null, createdSeq: store.nextSeq(),
  };
  repo.pulls.set(number, pr);
  return { pull: pullJson(repo, pr), status: 201 };
}
function listIssues(repo: Repo, q: URLSearchParams): Json[] {
  const state = q.get('state') ?? 'open';
  let list = [...repo.issues.values()];
  if (state === 'open') list = list.filter((i) => i.state === 'open');
  else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
  const sort = q.get('sort') ?? 'created';
  const dir = q.get('direction') ?? 'desc';
  if (sort === 'created') list.sort((a, b) => dir === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq);
  return list.map((i) => issueJson(repo, i));
}
function listPulls(repo: Repo, q: URLSearchParams): Json[] {
  const state = q.get('state') ?? 'open';
  let list = [...repo.pulls.values()];
  if (state === 'open') list = list.filter((p) => p.state === 'open');
  else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
  list.sort((a, b) => b.createdSeq - a.createdSeq);
  return list.map((p) => pullJson(repo, p));
}
function commitAuthorDate(data: Buffer): { name: string; email: string; date: string } {
  const c = parseCommit(data);
  const m = /^(.+?) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(c.author);
  if (!m) return { name: VIEWER_LOGIN, email: VIEWER_EMAIL, date: tsFor(0) };
  return { name: m[1], email: m[2], date: new Date(Number(m[3]) * 1000).toISOString() };
}
function commitJson(repo: Repo, sha: string): Json | null {
  const obj = repo.objects.get(sha);
  if (!obj || obj.type !== 'commit') return null;
  const c = parseCommit(obj.data);
  const author = commitAuthorDate(obj.data);
  return {
    sha, node_id: gid('Commit', repo.id, 0), commit: {
      message: c.message, author, committer: author,
      tree: { sha: c.tree, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/trees/${c.tree}` },
    },
    author: userJson(VIEWER_LOGIN, VIEWER_ID), committer: userJson(VIEWER_LOGIN, VIEWER_ID),
    parents: c.parents.map((p) => ({ sha: p, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${p}` })),
    tree: { sha: c.tree }, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/commit/${sha}`,
  };
}

// ---------------------------------------------------------------- REST v3
async function handleRest(req: IncomingMessage, res: ServerResponse, parts: string[]): Promise<void> {
  const method = req.method ?? 'GET';
  if (!authOk(req)) { errJson(res, 401, 'Bad credentials'); return; }
  const q = queryOf(req);

  // GET /api/v3/ and /api/v3/meta
  if (parts.length === 0) {
    if (method === 'GET') { sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit', repository_url: '/api/v3/repos/{owner}/{repo}' }, { 'x-oauth-scopes': 'repo, read:org' }); return; }
    errJson(res, 404, 'Not Found'); return;
  }
  if (parts[0] === 'meta' && parts.length === 1) {
    if (method === 'GET') { sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: true }); return; }
    errJson(res, 404, 'Not Found'); return;
  }
  if (parts[0] === 'user' && parts.length === 1) {
    if (method === 'GET') { sendJson(res, 200, userJson(VIEWER_LOGIN, VIEWER_ID)); return; }
    errJson(res, 404, 'Not Found'); return;
  }
  if (parts[0] === 'user' && parts[1] === 'repos') {
    if (method === 'GET') { paginate(req, res, store.viewerRepos().map((r) => repoJson(r))); return; }
    if (method === 'POST') {
      const body = await readJsonBody(req, res);
      if (body === null) return;
      const name = typeof body?.name === 'string' ? body.name.trim() : '';
      if (name === '') { errJson(res, 422, 'name is required'); return; }
      const repo = store.createRepo(name, typeof body?.description === 'string' ? body.description : '', body?.private === true);
      if (!repo) { errJson(res, 422, 'Repository already exists'); return; }
      sendJson(res, 201, repoJson(repo)); return;
    }
    errJson(res, 404, 'Not Found'); return;
  }
  if (parts[0] !== 'repos' || parts.length < 3) { errJson(res, 404, 'Not Found'); return; }
  const owner = decodeURIComponent(parts[1]);
  const repoName = decodeURIComponent(parts[2]);
  const rest = parts.slice(3);
  const repo = getRepoOr404(res, owner, repoName);
  if (!repo) return;

  // /repos/{o}/{r} itself
  if (rest.length === 0) {
    if (method === 'GET') { sendJson(res, 200, repoJson(repo)); return; }
    if (method === 'PATCH') {
      const body = await readJsonBody(req, res);
      if (body === null) return;
      if (typeof body?.description === 'string') repo.description = body.description;
      if (typeof body?.private === 'boolean') repo.private = body.private;
      sendJson(res, 200, repoJson(repo)); return;
    }
    if (method === 'DELETE') { store.deleteRepo(owner, repoName); sendJson(res, 204, null); return; }
    errJson(res, 404, 'Not Found'); return;
  }

  // branches
  if (rest[0] === 'branches') {
    if (method === 'GET' && rest.length === 1) {
      const list = [...repo.refs.keys()].filter((r) => r.startsWith('refs/heads/')).sort()
        .map((r) => ({ name: r.slice('refs/heads/'.length), commit: { sha: repo.refs.get(r)!, url: `/api/v3/repos/${owner}/${repoName}/commits/${repo.refs.get(r)!}` }, protected: false }));
      sendJson(res, 200, list); return;
    }
    if (method === 'GET' && rest.length === 2) {
      const tip = repo.tipOf(decodeURIComponent(rest[1]));
      if (!tip) { errJson(res, 404, 'Not Found'); return; }
      sendJson(res, 200, { name: decodeURIComponent(rest[1]), commit: { sha: tip, url: `/api/v3/repos/${owner}/${repoName}/commits/${tip}` }, protected: false }); return;
    }
    errJson(res, 404, 'Not Found'); return;
  }
  // commits
  if (rest[0] === 'commits') {
    if (method === 'GET' && rest.length === 1) {
      const shaParam = q.get('sha');
      let tip: string | undefined;
      if (shaParam) tip = repo.tipOf(shaParam) ?? (/^[0-9a-f]{40}$/.test(shaParam) ? shaParam : undefined);
      else tip = repo.tipOf(repo.defaultBranch);
      const out: Json[] = [];
      if (tip) {
        const seen = new Set<string>(); const stack = [tip];
        while (stack.length && out.length < 30) {
          const cur = stack.pop()!;
          if (seen.has(cur)) continue; seen.add(cur);
          const j = commitJson(repo, cur);
          if (j) out.push(j);
          const obj = repo.objects.get(cur);
          if (obj?.type === 'commit') for (const p of parseCommit(obj.data).parents) stack.push(p);
        }
      }
      sendJson(res, 200, out); return;
    }
    if (method === 'GET' && rest.length === 2) {
      const j = commitJson(repo, decodeURIComponent(rest[1]));
      if (!j) { errJson(res, 404, 'Not Found'); return; }
      sendJson(res, 200, j); return;
    }
    errJson(res, 404, 'Not Found'); return;
  }
  // git refs
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const body = await readJsonBody(req, res);
      if (body === null) return;
      const ref = typeof body?.ref === 'string' ? body.ref : '';
      const sha = typeof body?.sha === 'string' ? body.sha : '';
      if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha) || !repo.objects.has(sha)) { errJson(res, 422, 'Invalid ref or sha'); return; }
      repo.refs.set(ref, sha);
      sendJson(res, 201, { ref, node_id: gid('Ref', repo.id, 0), url: `/api/v3/repos/${owner}/${repoName}/git/refs/${encodeURIComponent(ref)}`, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: `/api/v3/repos/${owner}/${repoName}/git/commits/${sha}` } }); return;
    }
    if (method === 'GET') {
      const refName = rest.slice(2).map((p) => decodeURIComponent(p)).join('/');
      if (refName === '') {
        sendJson(res, 200, [...repo.refs.entries()].sort().map(([r, sha]) => ({ ref: r, node_id: gid('Ref', repo.id, 0), url: `/api/v3/repos/${owner}/${repoName}/git/refs/${encodeURIComponent(r)}`, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } }))); return;
      }
      const sha = repo.refs.get(refName);
      if (!sha) { errJson(res, 404, 'Not Found'); return; }
      sendJson(res, 200, { ref: refName, node_id: gid('Ref', repo.id, 0), url: `/api/v3/repos/${owner}/${repoName}/git/refs/${encodeURIComponent(refName)}`, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: `/api/v3/repos/${owner}/${repoName}/git/commits/${sha}` } }); return;
    }
    errJson(res, 404, 'Not Found'); return;
  }
  // contents
  if (rest[0] === 'contents') {
    const rawPath = rest.slice(1).map((p) => decodeURIComponent(p)).join('/');
    const refParam = q.get('ref');
    const tip = refParam ? (repo.tipOf(refParam) ?? (/^[0-9a-f]{40}$/.test(refParam) ? refParam : undefined)) : repo.tipOf(repo.defaultBranch);
    if (method === 'GET') {
      if (!tip) { errJson(res, 404, 'Not Found'); return; }
      const flat = repo.flatten(tip);
      if (rawPath === '') {
        const top = new Map<string, { type: string; oid: string }>();
        for (const [p, e] of flat) {
          const first = p.split('/')[0];
          if (!top.has(first)) top.set(first, { type: p.includes('/') ? 'dir' : 'file', oid: e.oid });
        }
        sendJson(res, 200, [...top.entries()].sort().map(([name, v]) => ({ type: v.type, name, path: name, sha: v.oid, size: 0, url: `/api/v3/repos/${owner}/${repoName}/contents/${encodeURIComponent(name)}` }))); return;
      }
      const file = flat.get(rawPath);
      if (file) {
        const blob = repo.objects.get(file.oid)!;
        sendJson(res, 200, { type: 'file', encoding: 'base64', size: blob.data.length, name: rawPath.split('/').pop(), path: rawPath, content: blob.data.toString('base64'), sha: file.oid, url: `/api/v3/repos/${owner}/${repoName}/contents/${encodeURIComponent(rawPath)}` }); return;
      }
      const children = new Map<string, { type: string; oid: string }>();
      for (const [p, e] of flat) {
        if (!p.startsWith(`${rawPath}/`)) continue;
        const restPath = p.slice(rawPath.length + 1);
        const first = restPath.split('/')[0];
        if (!children.has(first)) children.set(first, { type: restPath.includes('/') ? 'dir' : 'file', oid: e.oid });
      }
      if (children.size === 0) { errJson(res, 404, 'Not Found'); return; }
      sendJson(res, 200, [...children.entries()].sort().map(([name, v]) => ({ type: v.type, name, path: `${rawPath}/${name}`, sha: v.oid, size: 0, url: `/api/v3/repos/${owner}/${repoName}/contents/${encodeURIComponent(`${rawPath}/${name}`)}` }))); return;
    }
    if (method === 'PUT') {
      const body = await readJsonBody(req, res);
      if (body === null) return;
      const message = typeof body?.message === 'string' ? body.message : 'Update';
      const contentB64 = typeof body?.content === 'string' ? body.content : '';
      let content: Buffer;
      try { content = Buffer.from(contentB64.replace(/\s/g, ''), 'base64'); } catch { errJson(res, 422, 'Invalid content'); return; }
      const branch = typeof body?.branch === 'string' ? body.branch : repo.defaultBranch;
      const sha = typeof body?.sha === 'string' ? body.sha : undefined;
      const curTip = repo.tipOf(branch) ?? repo.tipOf(repo.defaultBranch);
      const curFlat = curTip ? repo.flatten(curTip) : new Map();
      const existing = curFlat.get(rawPath);
      if (sha !== undefined && existing && existing.oid.toLowerCase() !== sha.toLowerCase()) { errJson(res, 409, 'sha does not match'); return; }
      if (sha !== undefined && !existing) { errJson(res, 422, 'Invalid sha'); return; }
      const isCreate = !existing;
      const { commitSha, blobSha } = repo.commitFile(branch, rawPath, content, message);
      sendJson(res, isCreate ? 201 : 200, {
        content: { name: rawPath.split('/').pop(), path: rawPath, sha: blobSha, size: content.length, type: 'file', encoding: 'base64', content: contentB64, url: `/api/v3/repos/${owner}/${repoName}/contents/${encodeURIComponent(rawPath)}` },
        commit: { sha: commitSha, message, author: userJson(VIEWER_LOGIN, VIEWER_ID), committer: userJson(VIEWER_LOGIN, VIEWER_ID) },
      }); return;
    }
    if (method === 'DELETE') {
      const body = await readJsonBody(req, res);
      if (body === null) return;
      const branch = typeof body?.branch === 'string' ? body.branch : repo.defaultBranch;
      const tip = repo.tipOf(branch) ?? repo.tipOf(repo.defaultBranch);
      const flat = tip ? repo.flatten(tip) : new Map();
      if (!flat.has(rawPath)) { errJson(res, 404, 'Not Found'); return; }
      const message = typeof body?.message === 'string' ? body.message : 'Delete';
      const { commitSha } = repo.commitFile(branch, rawPath, Buffer.alloc(0), message, true);
      sendJson(res, 200, { commit: { sha: commitSha, message } }); return;
    }
    errJson(res, 404, 'Not Found'); return;
  }
  // labels
  if (rest[0] === 'labels') {
    if (method === 'GET' && rest.length === 1) { sendJson(res, 200, [...repo.labels.keys()].map((n) => labelJson(repo, n))); return; }
    if (method === 'POST' && rest.length === 1) {
      const body = await readJsonBody(req, res);
      if (body === null) return;
      const name = typeof body?.name === 'string' ? body.name.trim() : '';
      if (name === '') { errJson(res, 422, 'name is required'); return; }
      if (!repo.labels.has(name)) repo.labels.set(name, { name, color: typeof body?.color === 'string' ? body.color : 'ededed' });
      sendJson(res, 201, labelJson(repo, name)); return;
    }
    errJson(res, 404, 'Not Found'); return;
  }
  // issues
  if (rest[0] === 'issues') {
    if (rest.length === 1) {
      if (method === 'GET') { sendJson(res, 200, listIssues(repo, q)); return; }
      if (method === 'POST') {
        const body = await readJsonBody(req, res);
        if (body === null) return;
        const title = typeof body?.title === 'string' ? body.title : '';
        const labelsRaw = Array.isArray(body?.labels) ? body.labels : [];
        const labels: string[] = labelsRaw.map((l: unknown) => typeof l === 'string' ? l : isRecord(l) && typeof l.name === 'string' ? l.name : '').filter(Boolean);
        const created = createIssueIn(repo, title, typeof body?.body === 'string' ? body.body : '', labels);
        if (!created.issue) { errJson(res, created.status, created.message ?? 'Unprocessable'); return; }
        sendJson(res, 201, created.issue); return;
      }
      errJson(res, 404, 'Not Found'); return;
    }
    const num = Number(rest[1]);
    if (!Number.isInteger(num)) { errJson(res, 404, 'Not Found'); return; }
    if (rest.length === 2) {
      const issue = issueByNumber(repo, num);
      if (!issue) { errJson(res, 404, 'Not Found'); return; }
      if (method === 'GET') { sendJson(res, 200, issueJson(repo, issue)); return; }
      if (method === 'PATCH') {
        const body = await readJsonBody(req, res);
        if (body === null) return;
        if (typeof body?.title === 'string') issue.title = body.title;
        if (typeof body?.body === 'string') issue.body = body.body;
        if (typeof body?.state === 'string' && (body.state === 'open' || body.state === 'closed')) {
          issue.state = body.state;
          issue.closedSeq = body.state === 'closed' ? store.nextSeq() : null;
        }
        sendJson(res, 200, issueJson(repo, issue)); return;
      }
      errJson(res, 404, 'Not Found'); return;
    }
    if (rest[2] === 'comments') {
      const issue = issueByNumber(repo, num);
      if (!issue) { errJson(res, 404, 'Not Found'); return; }
      if (method === 'GET') { sendJson(res, 200, (repo.comments.get(num) ?? []).map((c) => commentJson(repo, num, c))); return; }
      if (method === 'POST') {
        const body = await readJsonBody(req, res);
        if (body === null) return;
        const c = { id: repo.nextCommentId++, gid: gid('IssueComment', repo.id, repo.nextCommentId), body: typeof body?.body === 'string' ? body.body : '', createdSeq: store.nextSeq() };
        const list = repo.comments.get(num) ?? []; list.push(c); repo.comments.set(num, list);
        sendJson(res, 201, commentJson(repo, num, c)); return;
      }
      errJson(res, 404, 'Not Found'); return;
    }
    errJson(res, 404, 'Not Found'); return;
  }
  // pulls
  if (rest[0] === 'pulls') {
    if (rest.length === 1) {
      if (method === 'GET') { sendJson(res, 200, listPulls(repo, q)); return; }
      if (method === 'POST') {
        const body = await readJsonBody(req, res);
        if (body === null) return;
        const created = createPullIn(repo, typeof body?.title === 'string' ? body.title : '', typeof body?.body === 'string' ? body.body : '', typeof body?.head === 'string' ? body.head : '', typeof body?.base === 'string' ? body.base : repo.defaultBranch);
        if (!created.pull) { errJson(res, created.status, created.message ?? 'Unprocessable'); return; }
        sendJson(res, 201, created.pull); return;
      }
      errJson(res, 404, 'Not Found'); return;
    }
    const num = Number(rest[1]);
    if (!Number.isInteger(num)) { errJson(res, 404, 'Not Found'); return; }
    if (rest.length === 2) {
      const pr = pullByNumber(repo, num);
      if (!pr) { errJson(res, 404, 'Not Found'); return; }
      if (method === 'GET') { sendJson(res, 200, pullJson(repo, pr)); return; }
      errJson(res, 404, 'Not Found'); return;
    }
    if (rest[2] === 'files' && method === 'GET') {
      const pr = pullByNumber(repo, num);
      if (!pr) { errJson(res, 404, 'Not Found'); return; }
      const headTip = repo.tipOf(pr.head); const baseTip = repo.tipOf(pr.base);
      if (!headTip || !baseTip) { sendJson(res, 200, []); return; }
      const mb = repo.mergeBase(headTip, baseTip) ?? baseTip;
      const files = repo.diffFiles(mb, headTip).map((d) => {
        const additions = lineCount(repo, d.newOid); const deletions = lineCount(repo, d.oldOid);
        return { filename: d.path, status: d.status, additions, deletions, changes: additions + deletions, blob_url: '', raw_url: '', contents_url: '' };
      });
      sendJson(res, 200, files); return;
    }
    if (rest[2] === 'merge' && method === 'PUT') {
      const pr = pullByNumber(repo, num);
      if (!pr) { errJson(res, 404, 'Not Found'); return; }
      const mergeBody = await readJsonBody(req, res);
      if (mergeBody === null) return; // malformed JSON already answered 400; do not merge
      if (pr.merged && pr.mergeCommitSha) { sendJson(res, 200, { sha: pr.mergeCommitSha, merged: true, message: 'Pull request successfully merged' }); return; }
      if (mergeConflictOf(repo, pr)) { errJson(res, 405, 'Merge conflict'); return; }
      const sha = repo.squashMerge(pr);
      if (!sha) { errJson(res, 405, 'Merge conflict'); return; }
      sendJson(res, 200, { sha, merged: true, message: 'Pull request successfully merged' }); return;
    }
    errJson(res, 404, 'Not Found'); return;
  }
  errJson(res, 404, 'Not Found');
}

// ---------------------------------------------------------------- GraphQL
interface GqlSelection { alias: string; name: string; args: Record<string, unknown>; selections: GqlSelection[] }
interface GqlOp { type: 'query' | 'mutation'; name: string | null; vars: Record<string, unknown>; selections: GqlSelection[] }
const GQL_TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'labels', 'comments'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'headRef', 'baseRef', 'createdAt', 'updatedAt'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'createdAt', 'updatedAt'],
  SearchType: [],
  User: ['id', 'login', 'name', 'email'],
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
};
function gqlTokenize(src: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '#') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (/\s/.test(ch)) { i += 1; continue; }
    if ('{}():[]!=$@'.includes(ch)) { tokens.push(ch); i += 1; continue; }
    if (src.startsWith('...', i)) { tokens.push('...'); i += 3; continue; }
    if (ch === '"') {
      let j = i + 1; let out = '';
      while (j < src.length && src[j] !== '"') { if (src[j] === '\\' && j + 1 < src.length) { out += src[j + 1]; j += 2; } else { out += src[j]; j += 1; } }
      tokens.push(JSON.stringify(out)); i = j + 1; continue;
    }
    let j = i;
    while (j < src.length && /[A-Za-z0-9_.-]/.test(src[j])) j += 1;
    if (j === i) { i += 1; continue; }
    tokens.push(src.slice(i, j)); i = j;
  }
  return tokens;
}
class GqlParser {
  tokens: string[]; pos = 0; fragments = new Map<string, GqlSelection[]>();
  constructor(src: string) { this.tokens = gqlTokenize(src); }
  peek(): string | undefined { return this.tokens[this.pos]; }
  next(): string { return this.tokens[this.pos++] ?? ''; }
  expect(t: string): void { if (this.next() !== t) throw new Error(`expected ${t}`); }
  parseValue(vars: Record<string, unknown>): unknown {
    const t = this.next();
    if (t === '$') { const name = this.next(); return vars[name] ?? null; }
    if (t === '[') { const arr: unknown[] = []; while (this.peek() !== ']') arr.push(this.parseValue(vars)); this.expect(']'); return arr; }
    if (t === '{') {
      const obj: Record<string, unknown> = {};
      while (this.peek() !== '}') { const k = this.next(); this.expect(':'); obj[k] = this.parseValue(vars); }
      this.expect('}'); return obj;
    }
    if (t.startsWith('"')) return JSON.parse(t) as string;
    if (t === 'true') return true; if (t === 'false') return false; if (t === 'null') return null;
    if (/^-?\d+$/.test(t)) return Number(t);
    if (/^-?\d+\.\d+$/.test(t)) return Number(t);
    return t; // enum as string
  }
  parseArgs(vars: Record<string, unknown>): Record<string, unknown> {
    const args: Record<string, unknown> = {};
    if (this.peek() !== '(') return args;
    this.next();
    while (this.peek() !== ')') { const k = this.next(); this.expect(':'); args[k] = this.parseValue(vars); }
    this.expect(')');
    return args;
  }
  parseSelections(vars: Record<string, unknown>): GqlSelection[] {
    this.expect('{');
    const out: GqlSelection[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.next();
        const name = this.next();
        if (name === 'on') {
          this.next(); // type name
          out.push(...this.parseSelections(vars));
        } else {
          const frag = this.fragments.get(name);
          if (frag) out.push(...frag);
        }
        continue;
      }
      let alias = this.next(); let name = alias;
      if (this.peek() === ':') { this.next(); name = this.next(); }
      const args = this.parseArgs(vars);
      let selections: GqlSelection[] = [];
      if (this.peek() === '{') selections = this.parseSelections(vars);
      out.push({ alias, name, args, selections });
    }
    this.expect('}');
    return out;
  }
  parseDocument(vars: Record<string, unknown>): GqlOp[] {
    const ops: GqlOp[] = [];
    while (this.pos < this.tokens.length) {
      const t = this.next();
      if (t === 'fragment') {
        const name = this.next(); this.next(); this.next(); // on Type
        this.fragments.set(name, this.parseSelections(vars));
        continue;
      }
      let type: 'query' | 'mutation' = 'query'; let name: string | null = null;
      if (t === 'query' || t === 'mutation') {
        type = t as 'query' | 'mutation';
        const nxt = this.peek();
        if (nxt !== undefined && nxt !== '{' && nxt !== '(') name = this.next();
      } else if (t === '{') { this.pos -= 1; }
      else continue;
      if (this.peek() === '(') {
        this.next();
        let depth = 1;
        while (depth > 0 && this.pos < this.tokens.length) { const tok = this.next(); if (tok === '(') depth += 1; else if (tok === ')') depth -= 1; }
      }
      const selections = this.parseSelections(vars);
      ops.push({ type, name, vars, selections });
    }
    return ops;
  }
}
interface GqlCtx { errors: Array<{ message: string }>; }
function gqlCursor(num: number): string { return Buffer.from(`cursor:${num}`).toString('base64'); }
function gqlCursorNum(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try { const m = /^cursor:(\d+)$/.exec(Buffer.from(cursor, 'base64').toString('utf8')); return m ? Number(m[1]) : null; } catch { return null; }
}
function gqlIssueState(s: string): string { return s === 'closed' ? 'CLOSED' : 'OPEN'; }
function gqlPrState(p: { state: string; merged: boolean }): string { return p.merged ? 'MERGED' : p.state === 'closed' ? 'CLOSED' : 'OPEN'; }

function resolveIssueFields(repo: Repo, issue: NonNullable<ReturnType<Repo['issues']['get']>>, sel: GqlSelection[], ctx: GqlCtx): Json {
  const out: Json = {};
  for (const s of sel) {
    switch (s.name) {
      case 'id': out[s.alias] = issue.gid; break;
      case 'number': out[s.alias] = issue.number; break;
      case 'title': out[s.alias] = issue.title; break;
      case 'state': out[s.alias] = gqlIssueState(issue.state); break;
      case 'body': out[s.alias] = issue.body; break;
      case 'createdAt': out[s.alias] = tsFor(issue.createdSeq); break;
      case 'updatedAt': out[s.alias] = tsFor(issue.closedSeq ?? issue.createdSeq); break;
      case 'author': out[s.alias] = resolveUserFields(sel, ctx); break;
      default: ctx.errors.push({ message: `Cannot query field "${s.name}" on type "Issue".` }); out[s.alias] = null; break;
    }
  }
  return out;
}
function resolveUserFields(sel: GqlSelection[], ctx: GqlCtx): Json {
  const out: Json = {};
  for (const s of sel) {
    switch (s.name) {
      case 'login': out[s.alias] = VIEWER_LOGIN; break;
      case 'id': out[s.alias] = gid('User', VIEWER_ID); break;
      case 'name': out[s.alias] = VIEWER_LOGIN; break;
      case 'email': out[s.alias] = VIEWER_EMAIL; break;
      default: ctx.errors.push({ message: `Cannot query field "${s.name}" on type "User".` }); out[s.alias] = null; break;
    }
  }
  return out;
}
function resolvePrFields(repo: Repo, pr: NonNullable<ReturnType<Repo['pulls']['get']>>, sel: GqlSelection[], ctx: GqlCtx): Json {
  const out: Json = {};
  for (const s of sel) {
    switch (s.name) {
      case 'id': out[s.alias] = pr.gid; break;
      case 'number': out[s.alias] = pr.number; break;
      case 'title': out[s.alias] = pr.title; break;
      case 'body': out[s.alias] = pr.body; break;
      case 'state': out[s.alias] = gqlPrState(pr); break;
      case 'merged': out[s.alias] = pr.merged; break;
      case 'headRefName': out[s.alias] = pr.head; break;
      case 'baseRefName': out[s.alias] = pr.base; break;
      case 'mergeable': out[s.alias] = pr.merged ? 'UNKNOWN' : mergeConflictOf(repo, pr) ? 'CONFLICTING' : 'MERGEABLE'; break;
      case 'headRef': out[s.alias] = { name: pr.head }; break;
      case 'baseRef': out[s.alias] = { name: pr.base }; break;
      case 'createdAt': out[s.alias] = tsFor(pr.createdSeq); break;
      case 'updatedAt': out[s.alias] = tsFor(pr.mergedSeq ?? pr.createdSeq); break;
      case 'files': {
        const headTip = repo.tipOf(pr.head); const baseTip = repo.tipOf(pr.base);
        let nodes: Json[] = [];
        if (headTip && baseTip) {
          const mb = repo.mergeBase(headTip, baseTip) ?? baseTip;
          const first = typeof s.args.first === 'number' ? s.args.first : 100;
          nodes = repo.diffFiles(mb, headTip).slice(0, first).map((d) => ({ path: d.path, filename: d.path, status: d.status.toUpperCase(), additions: lineCount(repo, d.newOid), deletions: lineCount(repo, d.oldOid) }));
        }
        out[s.alias] = { nodes, totalCount: nodes.length, pageInfo: { hasNextPage: false, endCursor: null } };
        break;
      }
      default: ctx.errors.push({ message: `Cannot query field "${s.name}" on type "PullRequest".` }); out[s.alias] = null; break;
    }
  }
  return out;
}
function resolveRepoFields(repo: Repo, sel: GqlSelection[], ctx: GqlCtx): Json {
  const out: Json = {};
  for (const s of sel) {
    switch (s.name) {
      case 'id': out[s.alias] = repo.gid; break;
      case 'databaseId': out[s.alias] = repo.id; break;
      case 'name': out[s.alias] = repo.name; break;
      case 'nameWithOwner': out[s.alias] = `${repo.owner}/${repo.name}`; break;
      case 'owner': out[s.alias] = resolveUserFields(s.selections, ctx); break;
      case 'defaultBranchRef': { const tip = repo.tipOf(repo.defaultBranch); out[s.alias] = tip ? { name: repo.defaultBranch } : null; break; }
      case 'viewerPermission': out[s.alias] = 'ADMIN'; break;
      case 'hasIssuesEnabled': out[s.alias] = true; break;
      case 'description': out[s.alias] = repo.description; break;
      case 'private': out[s.alias] = repo.private; break;
      case 'createdAt': out[s.alias] = tsFor(repo.createdSeq); break;
      case 'updatedAt': out[s.alias] = tsFor(repo.createdSeq); break;
      case 'issue': {
        const issue = repo.issues.get(Number(s.args.number));
        out[s.alias] = issue ? resolveIssueFields(repo, issue, s.selections, ctx) : null;
        break;
      }
      case 'issues': {
        let list = [...repo.issues.values()];
        const states = Array.isArray(s.args.states) ? (s.args.states as string[]) : null;
        if (states) list = list.filter((i) => states.includes(gqlIssueState(i.state)));
        const orderBy = isRecord(s.args.orderBy) ? s.args.orderBy : null;
        const dir = orderBy?.direction === 'ASC' ? 1 : -1;
        list.sort((a, b) => dir * (a.createdSeq - b.createdSeq) || dir * (a.number - b.number));
        const after = gqlCursorNum(s.args.after);
        if (after !== null) {
          const idx = list.findIndex((i) => i.number === after);
          if (idx >= 0) list = list.slice(idx + 1);
        }
        const first = typeof s.args.first === 'number' ? s.args.first : list.length;
        const page = list.slice(0, first);
        const nodesSel = s.selections.find((x) => x.name === 'nodes')?.selections ?? s.selections;
        out[s.alias] = {
          nodes: page.map((i) => resolveIssueFields(repo, i, nodesSel, ctx)),
          edges: page.map((i) => ({ node: resolveIssueFields(repo, i, nodesSel, ctx), cursor: gqlCursor(i.number) })),
          totalCount: list.length,
          pageInfo: { hasNextPage: list.length > first, endCursor: page.length ? gqlCursor(page[page.length - 1].number) : null },
        };
        break;
      }
      case 'pullRequests': {
        let list = [...repo.pulls.values()];
        const states = Array.isArray(s.args.states) ? (s.args.states as string[]) : null;
        if (states) list = list.filter((p) => states.includes(gqlPrState(p)));
        const first = typeof s.args.first === 'number' ? s.args.first : list.length;
        const page = list.slice(0, first);
        const nodesSel = s.selections.find((x) => x.name === 'nodes')?.selections ?? s.selections;
        out[s.alias] = {
          nodes: page.map((p) => resolvePrFields(repo, p, nodesSel, ctx)),
          edges: page.map((p) => ({ node: resolvePrFields(repo, p, nodesSel, ctx), cursor: gqlCursor(p.number) })),
          totalCount: list.length,
          pageInfo: { hasNextPage: list.length > first, endCursor: null },
        };
        break;
      }
      case 'pullRequest': {
        const pr = repo.pulls.get(Number(s.args.number));
        out[s.alias] = pr ? resolvePrFields(repo, pr, s.selections, ctx) : null;
        break;
      }
      default: ctx.errors.push({ message: `Cannot query field "${s.name}" on type "Repository".` }); out[s.alias] = null; break;
    }
  }
  return out;
}
function resolveTypeFields(name: string, sel: GqlSelection[], ctx: GqlCtx): Json {
  const out: Json = {};
  const fields = GQL_TYPE_FIELDS[name] ?? [];
  const enumValues = name === 'SearchType' ? ['ISSUE', 'REPOSITORY', 'USER'] : [];
  for (const s of sel) {
    switch (s.name) {
      case 'name': out[s.alias] = name; break;
      case 'kind': out[s.alias] = enumValues.length ? 'ENUM' : 'OBJECT'; break;
      case 'fields': out[s.alias] = fields.map((f) => ({ name: f })); break;
      case 'enumValues': out[s.alias] = enumValues.map((f) => ({ name: f })); break;
      default: ctx.errors.push({ message: `Cannot query field "${s.name}" on type "__Type".` }); out[s.alias] = null; break;
    }
  }
  return out;
}
function executeOp(op: GqlOp): { data: Json; errors: Array<{ message: string }> } {
  const ctx: GqlCtx = { errors: [] };
  const data: Json = {};
  const isMutation = op.type === 'mutation';
  for (const s of op.selections) {
    if (!isMutation) {
      switch (s.name) {
        case 'viewer': data[s.alias] = resolveUserFields(s.selections, ctx); break;
        case 'repository': {
          const repo = store.getRepo(String(s.args.owner ?? ''), String(s.args.name ?? ''));
          data[s.alias] = repo && repo.owner === VIEWER_LOGIN ? resolveRepoFields(repo, s.selections, ctx) : null;
          break;
        }
        case 'node': {
          const dec = decodeGid(String(s.args.id ?? ''));
          let node: Json | null = null;
          if (dec?.kind === 'Repository') {
            const repo = store.getRepoById(dec.dbId);
            if (repo) node = resolveRepoFields(repo, s.selections, ctx);
          } else if (dec?.kind === 'Issue') {
            const repo = store.getRepoById(dec.dbId);
            const issue = repo?.issues.get(dec.num);
            if (repo && issue) node = resolveIssueFields(repo, issue, s.selections, ctx);
          } else if (dec?.kind === 'PullRequest') {
            const repo = store.getRepoById(dec.dbId);
            const pr = repo?.pulls.get(dec.num);
            if (repo && pr) node = resolvePrFields(repo, pr, s.selections, ctx);
          }
          data[s.alias] = node;
          break;
        }
        case '__type': data[s.alias] = resolveTypeFields(String(s.args.name ?? ''), s.selections, ctx); break;
        case '__schema': data[s.alias] = { queryType: { name: 'Query' }, mutationType: { name: 'Mutation' }, types: Object.keys(GQL_TYPE_FIELDS).map((n) => ({ name: n })) }; break;
        default: ctx.errors.push({ message: `Cannot query field "${s.name}" on type "Query".` }); data[s.alias] = null; break;
      }
    } else {
      const input = isRecord(s.args.input) ? s.args.input : {};
      switch (s.name) {
        case 'createIssue': {
          const dec = decodeGid(String(input.repositoryId ?? ''));
          const repo = dec ? store.getRepoById(dec.dbId) : undefined;
          if (!repo) { ctx.errors.push({ message: 'Repository not found' }); data[s.alias] = null; break; }
          const created = createIssueIn(repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '', []);
          if (!created.issue) { ctx.errors.push({ message: created.message ?? 'Unprocessable' }); data[s.alias] = null; break; }
          const issue = repo.issues.get(Number((created.issue as Json).number));
          data[s.alias] = { issue: issue ? resolveIssueFields(repo, issue, s.selections[0]?.selections ?? [], ctx) : null };
          break;
        }
        case 'closeIssue': {
          const dec = decodeGid(String(input.issueId ?? ''));
          const repo = dec ? store.getRepoById(dec.dbId) : undefined;
          const issue = repo?.issues.get(dec?.num ?? 0);
          if (!repo || !issue) { ctx.errors.push({ message: 'Issue not found' }); data[s.alias] = null; break; }
          issue.state = 'closed'; issue.closedSeq = store.nextSeq();
          data[s.alias] = { issue: resolveIssueFields(repo, issue, s.selections[0]?.selections ?? [], ctx) };
          break;
        }
        case 'createPullRequest': {
          const dec = decodeGid(String(input.repositoryId ?? ''));
          const repo = dec ? store.getRepoById(dec.dbId) : undefined;
          if (!repo) { ctx.errors.push({ message: 'Repository not found' }); data[s.alias] = null; break; }
          const created = createPullIn(repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '', String(input.headRefName ?? ''), String(input.baseRefName ?? ''));
          if (!created.pull) { ctx.errors.push({ message: created.message ?? 'Unprocessable' }); data[s.alias] = null; break; }
          const pr = repo.pulls.get(Number((created.pull as Json).number));
          data[s.alias] = { pullRequest: pr ? resolvePrFields(repo, pr, s.selections[0]?.selections ?? [], ctx) : null };
          break;
        }
        case 'mergePullRequest': {
          const dec = decodeGid(String(input.pullRequestId ?? ''));
          const repo = dec ? store.getRepoById(dec.dbId) : undefined;
          const pr = repo?.pulls.get(dec?.num ?? 0);
          if (!repo || !pr) { ctx.errors.push({ message: 'Pull request not found' }); data[s.alias] = null; break; }
          if (mergeConflictOf(repo, pr)) { ctx.errors.push({ message: 'Merge conflict' }); data[s.alias] = null; break; }
          repo.squashMerge(pr);
          data[s.alias] = { pullRequest: resolvePrFields(repo, pr, s.selections[0]?.selections ?? [], ctx) };
          break;
        }
        case 'addComment': {
          const dec = decodeGid(String(input.subjectId ?? ''));
          const repo = dec ? store.getRepoById(dec.dbId) : undefined;
          const issue = repo?.issues.get(dec?.num ?? 0);
          if (!repo || !issue) { ctx.errors.push({ message: 'Issue not found' }); data[s.alias] = null; break; }
          const c = { id: repo.nextCommentId++, gid: gid('IssueComment', repo.id, repo.nextCommentId), body: String(input.body ?? ''), createdSeq: store.nextSeq() };
          const list = repo.comments.get(issue.number) ?? []; list.push(c); repo.comments.set(issue.number, list);
          data[s.alias] = { commentEdge: { node: { id: c.gid, body: c.body } } };
          break;
        }
        default: ctx.errors.push({ message: `Cannot query field "${s.name}" on type "Mutation".` }); data[s.alias] = null; break;
      }
    }
  }
  return { data, errors: ctx.errors };
}
async function handleGraphql(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!authOk(req)) { errJson(res, 401, 'Bad credentials'); return; }
  const raw = await readBody(req);
  let parsed: unknown;
  try { parsed = JSON.parse(raw.toString('utf8')); } catch { sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] }); return; }
  const runOne = (entry: unknown): Json => {
    if (!isRecord(entry) || typeof entry.query !== 'string') return { data: null, errors: [{ message: 'Invalid GraphQL request' }] };
    const vars = isRecord(entry.variables) ? entry.variables : {};
    try {
      const ops = new GqlParser(entry.query).parseDocument(vars);
      if (ops.length === 0) return { data: {}, errors: [{ message: 'No operation found' }] };
      // A document with several operations: execute the named one, else the first.
      let op = ops[0];
      if (typeof entry.operationName === 'string') op = ops.find((o) => o.name === entry.operationName) ?? op;
      const { data, errors } = executeOp(op);
      return errors.length ? { data, errors } : { data };
    } catch (e) {
      return { data: null, errors: [{ message: e instanceof Error ? e.message : 'GraphQL parse error' }] };
    }
  };
  if (Array.isArray(parsed)) sendJson(res, 200, parsed.map(runOne));
  else sendJson(res, 200, runOne(parsed));
}

// ---------------------------------------------------------------- MCP
const MCP_TOOLS: Array<Json> = [
  { name: 'create_repo', description: 'Create a repository for the authenticated user.', inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Repository name' }, description: { type: 'string' }, private: { type: 'boolean' } }, required: ['name'] } },
  { name: 'get_repo', description: 'Get a repository by owner and name.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' } }, required: ['owner', 'repo'] } },
  { name: 'create_issue', description: 'Create an issue in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['owner', 'repo', 'title'] } },
  { name: 'list_issues', description: 'List issues in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' } }, required: ['owner', 'repo'] } },
  { name: 'create_pull_request', description: 'Open a pull request from a head branch onto a base branch.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' } }, required: ['owner', 'repo', 'title', 'head', 'base'] } },
  { name: 'merge_pull_request', description: 'Squash-merge a pull request.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'integer' } }, required: ['owner', 'repo', 'pull_number'] } },
  { name: 'get_issue', description: 'Get one issue by number.', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, issue_number: { type: 'integer' } }, required: ['owner', 'repo', 'issue_number'] } },
  { name: 'list_repos', description: 'List repositories of the authenticated user.', inputSchema: { type: 'object', properties: {}, required: [] } },
];
function mcpToolResult(value: unknown, isError = false): Json {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError };
}
function mcpCall(name: string, args: Json): Json {
  const norm = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const getStr = (k: string): string => typeof args[k] === 'string' ? (args[k] as string) : '';
  const lookupRepo = (): Repo | null => {
    const owner = getStr('owner') || getStr('owner_login');
    const repoName = getStr('repo') || getStr('repository') || getStr('name');
    if (owner !== VIEWER_LOGIN) return null;
    return store.getRepo(owner, repoName) ?? null;
  };
  if (norm.endsWith('createrepo') || norm.endsWith('createrepository')) {
    const repoName = getStr('name') || getStr('repo');
    if (!repoName) return mcpToolResult({ error: 'Missing required argument: name' }, true);
    const repo = store.createRepo(repoName, getStr('description'), args.private === true);
    if (!repo) return mcpToolResult({ error: 'Repository already exists' }, true);
    return mcpToolResult(repoJson(repo));
  }
  if (norm.endsWith('getrepo') || norm.endsWith('getrepository')) {
    const repo = lookupRepo();
    if (!repo) return mcpToolResult({ error: 'Repository not found' }, true);
    return mcpToolResult(repoJson(repo));
  }
  if (norm.endsWith('createissue') || norm.endsWith('issuecreate')) {
    if (!getStr('title')) return mcpToolResult({ error: 'Missing required argument: title' }, true);
    const repo = lookupRepo();
    if (!repo) return mcpToolResult({ error: 'Repository not found' }, true);
    const created = createIssueIn(repo, getStr('title'), getStr('body'), []);
    if (!created.issue) return mcpToolResult({ error: created.message ?? 'Unprocessable' }, true);
    return mcpToolResult(created.issue);
  }
  if (norm.endsWith('listissues') || norm.endsWith('issueslist')) {
    const repo = lookupRepo();
    if (!repo) return mcpToolResult({ error: 'Repository not found' }, true);
    const state = getStr('state') || 'open';
    const q = new URLSearchParams({ state });
    return mcpToolResult(listIssues(repo, q));
  }
  if (norm.endsWith('createpullrequest') || norm.endsWith('createpr') || norm.endsWith('pullrequestcreate')) {
    const repo = lookupRepo();
    if (!repo) return mcpToolResult({ error: 'Repository not found' }, true);
    if (!getStr('title') || !getStr('head') || !getStr('base')) return mcpToolResult({ error: 'Missing required argument' }, true);
    const created = createPullIn(repo, getStr('title'), getStr('body'), getStr('head'), getStr('base'));
    if (!created.pull) return mcpToolResult({ error: created.message ?? 'Unprocessable' }, true);
    return mcpToolResult(created.pull);
  }
  if (norm.endsWith('mergepullrequest') || norm.endsWith('mergepr') || norm.endsWith('pullrequestmerge')) {
    const repo = lookupRepo();
    if (!repo) return mcpToolResult({ error: 'Repository not found' }, true);
    const num = Number(args.pull_number ?? args.pull_request_number ?? args.number);
    const pr = repo.pulls.get(num);
    if (!pr) return mcpToolResult({ error: 'Pull request not found' }, true);
    if (pr.merged && pr.mergeCommitSha) return mcpToolResult({ sha: pr.mergeCommitSha, merged: true, message: 'Pull request successfully merged' });
    if (mergeConflictOf(repo, pr)) return mcpToolResult({ error: 'Merge conflict' }, true);
    const sha = repo.squashMerge(pr);
    if (!sha) return mcpToolResult({ error: 'Merge conflict' }, true);
    return mcpToolResult({ sha, merged: true, message: 'Pull request successfully merged' });
  }
  if (norm.endsWith('getissue')) {
    const repo = lookupRepo();
    const issue = repo?.issues.get(Number(args.issue_number ?? args.number));
    if (!repo || !issue) return mcpToolResult({ error: 'Issue not found' }, true);
    return mcpToolResult(issueJson(repo, issue));
  }
  if (norm.endsWith('listrepos')) {
    return mcpToolResult(store.viewerRepos().map((r) => repoJson(r)));
  }
  return mcpToolResult({ error: `Unknown tool: ${name}` }, true);
}
async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req);
  let parsed: unknown;
  try { parsed = JSON.parse(raw.toString('utf8')); } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (!isRecord(parsed) || typeof parsed.method !== 'string') {
    sendJson(res, 400, { jsonrpc: '2.0', id: isRecord(parsed) ? (parsed.id ?? null) : null, error: { code: -32600, message: 'Invalid Request' } });
    return;
  }
  const id = parsed.id ?? null;
  if (parsed.method.startsWith('notifications/')) { res.writeHead(202, { 'x-github-request-id': `req-${++requestCounter}` }); res.end(); return; }
  if (!authOk(req)) { errJson(res, 401, 'Bad credentials'); return; }
  const params = isRecord(parsed.params) ? parsed.params : {};
  const ok = (result: unknown): void => sendJson(res, 200, { jsonrpc: '2.0', id, result });
  const failRpc = (code: number, message: string): void => sendJson(res, 200, { jsonrpc: '2.0', id, error: { code, message } });
  switch (parsed.method) {
    case 'server/discover':
      ok({
        protocolVersion: '2026-07-28', supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'],
        capabilities: { tools: {} }, serverInfo: { name: 'forge-mcp', version: '1.0.0' },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'forge-mcp', version: '1.0.0' }, serverInfo: { name: 'forge-mcp', version: '1.0.0' } },
      });
      return;
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
      const known = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
      ok({ protocolVersion: known.includes(requested) ? requested : '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'forge-mcp', version: '1.0.0' } });
      return;
    }
    case 'tools/list':
      ok({ tools: MCP_TOOLS });
      return;
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = isRecord(params.arguments) ? params.arguments : {};
      const tool = MCP_TOOLS.find((t) => (t.name as string).toLowerCase() === toolName.toLowerCase())
        ?? MCP_TOOLS.find((t) => (t.name as string).toLowerCase().replace(/[^a-z0-9]/g, '').endsWith(toolName.toLowerCase().replace(/[^a-z0-9]/g, '')));
      if (!tool) { failRpc(-32601, `Unknown tool: ${toolName}`); return; }
      const required = ((tool.inputSchema as Json).required as string[]) ?? [];
      const missing = required.filter((r) => args[r] === undefined || args[r] === null || args[r] === '');
      if (missing.length > 0) { ok(mcpToolResult({ error: `Missing required argument: ${missing.join(', ')}` }, true)); return; }
      ok(mcpCall(toolName, args));
      return;
    }
    case 'ping':
      ok({});
      return;
    default:
      failRpc(-32601, `Method not found: ${parsed.method}`);
  }
}

// ---------------------------------------------------------------- git smart HTTP
async function handleGit(req: IncomingMessage, res: ServerResponse, parts: string[]): Promise<void> {
  const method = req.method ?? 'GET';
  // parts: [owner, "<repo>.git", ...]
  const owner = decodeURIComponent(parts[0] ?? '');
  const repoSeg = parts[1] ?? '';
  if (!repoSeg.endsWith('.git')) { errJson(res, 404, 'Not Found'); return; }
  const repoName = decodeURIComponent(repoSeg.slice(0, -4));
  const repo = owner === VIEWER_LOGIN ? store.getRepo(owner, repoName) : undefined;
  const service = urlOf(req).searchParams.get('service');
  if (method === 'GET' && parts[2] === 'info' && parts[3] === 'refs') {
    if (!repo) { errJson(res, 404, 'Not Found'); return; }
    if (service === 'git-upload-pack') {
      const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
      sendRaw(res, 200, v2 ? v2Advertisement('git-upload-pack') : v0Advertisement(repo, 'git-upload-pack'), 'application/x-git-upload-pack-advertisement');
      return;
    }
    if (service === 'git-receive-pack') {
      sendRaw(res, 200, v0Advertisement(repo, 'git-receive-pack'), 'application/x-git-receive-pack-advertisement');
      return;
    }
    errJson(res, 404, 'Not Found'); return;
  }
  if (method === 'POST' && parts[2] === 'git-upload-pack') {
    if (!repo) { errJson(res, 404, 'Not Found'); return; }
    const body = await readBody(req);
    try {
      const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
      if (v2) {
        const packets = decodePackets(body);
        const lines = packets.filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8').replace(/\n$/, ''));
        const command = lines.find((l) => l.startsWith('command='))?.slice('command='.length);
        if (command === 'ls-refs') {
          const peel = lines.includes('peel');
          const symrefs = lines.includes('symrefs');
          const prefixes = lines.filter((l) => l.startsWith('ref-prefix ')).map((l) => l.slice('ref-prefix '.length));
          sendRaw(res, 200, lsRefsResponse(repo, { peel, symrefs, prefixes }), 'application/x-git-upload-pack-result');
          return;
        }
        if (command === 'fetch') {
          const wants = lines.filter((l) => l.startsWith('want ')).map((l) => l.slice(5).trim());
          const haves = lines.filter((l) => l.startsWith('have ')).map((l) => l.slice(5).trim());
          const shallow = lines.filter((l) => l.startsWith('shallow ')).map((l) => l.slice(8).trim());
          const deepenLine = lines.find((l) => l.startsWith('deepen '));
          const depth = deepenLine ? Number(deepenLine.slice(7)) : null;
          sendRaw(res, 200, v2FetchResponse(repo, wants, haves, Number.isFinite(depth) ? depth : null, shallow), 'application/x-git-upload-pack-result');
          return;
        }
        sendRaw(res, 200, FLUSH, 'application/x-git-upload-pack-result');
        return;
      }
      // v0 fetch
      const lines = pktTextLines(body);
      const wants: string[] = []; const haves: string[] = []; const shallow: string[] = [];
      let depth: number | null = null; let seenFlush = false;
      for (const line of lines) {
        if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0]);
        else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
        else if (line.startsWith('deepen ')) depth = Number(line.slice(7));
        else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
      }
      void seenFlush;
      sendRaw(res, 200, v0FetchResponse(repo, wants, haves, depth, shallow), 'application/x-git-upload-pack-result');
    } catch {
      sendRaw(res, 200, FLUSH, 'application/x-git-upload-pack-result');
    }
    return;
  }
  if (method === 'POST' && parts[2] === 'git-receive-pack') {
    if (!repo) { errJson(res, 404, 'Not Found'); return; }
    const body = await readBody(req);
    try {
      const { commands, pack } = parseReceiveBody(body);
      const { report } = applyPush(repo, commands, pack);
      sendRaw(res, 200, report, 'application/x-git-receive-pack-result');
    } catch {
      sendRaw(res, 200, pktLines(['unpack error\n']), 'application/x-git-receive-pack-result');
    }
    return;
  }
  errJson(res, 404, 'Not Found');
}

// ---------------------------------------------------------------- server
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const parts = pathParts(req);
        const method = req.method ?? 'GET';
        if (method === 'GET' && parts.length === 0) { sendJson(res, 200, { ok: true }); return; }
        if (parts[0] === 'healthz' && method === 'GET') { sendJson(res, 200, { ok: true }); return; }
        if (parts[0] === 'mcp' && parts.length === 1) {
          if (method === 'POST') { await handleMcp(req, res); return; }
          errJson(res, 404, 'Not Found'); return;
        }
        if (parts[0] === 'api' && parts[1] === 'graphql' && parts.length === 2) {
          if (method === 'POST') { await handleGraphql(req, res); return; }
          errJson(res, 404, 'Not Found'); return;
        }
        if (parts[0] === 'api' && parts[1] === 'v3') {
          if (method === 'GET' && parts.length === 2) {
            if (!authOk(req)) { errJson(res, 401, 'Bad credentials'); return; }
            sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
            return;
          }
          await handleRest(req, res, parts.slice(2));
          return;
        }
        if (parts.length >= 2 && parts[1].endsWith('.git')) { await handleGit(req, res, parts); return; }
        errJson(res, 404, 'Not Found');
      } catch (e) {
        if (!res.headersSent) errJson(res, 500, e instanceof Error ? e.message : 'Internal error');
        else res.end();
      }
    })();
  });
}
