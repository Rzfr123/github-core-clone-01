// git.ts — git smart HTTP over the store: pkt-line codec, packfile read/write
// (plain objects; OFS/REF deltas resolved on read), protocol v2 ls-refs/fetch
// and v0 upload-pack/receive-pack. No git binary, only node:zlib + node:crypto.
import { deflateSync, inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { ZERO_OID, hashObject, parseCommit, parseTag, parseTree, type GitObjectType, type Repo } from './store.ts';

export function pkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  // One buffer for the length head and the payload, instead of concat-ing two:
  // advertisements and ls-refs build a pkt-line per ref, and the pack framer per chunk.
  const out = Buffer.allocUnsafe(4 + data.length);
  out.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  data.copy(out, 4);
  return out;
}
export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');
export function pktLines(items: Array<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(FLUSH);
    else if (item === 'delim') parts.push(DELIM);
    else parts.push(pkt(item));
  }
  return Buffer.concat(parts);
}
/** Decode a whole pkt-line stream into packets (data payloads + control markers). The
 *  4-hex-digit length is validated by hand: the per-packet regex test it replaces cost
 *  more than the parse itself on the fetch/advertisement paths. */
export function decodePackets(buf: Buffer): Array<{ kind: 'data' | 'flush' | 'delim' | 'end'; payload: Buffer }> {
  const out: Array<{ kind: 'data' | 'flush' | 'delim' | 'end'; payload: Buffer }> = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    let len = 0;
    let bad = false;
    for (let i = 0; i < 4; i += 1) {
      const c = buf[off + i];
      const d = c >= 48 && c <= 57 ? c - 48 : c >= 97 && c <= 102 ? c - 87 : c >= 65 && c <= 70 ? c - 55 : -1;
      if (d < 0) { bad = true; break; }
      len = len * 16 + d;
    }
    if (bad) throw new Error(`bad pkt-line length ${JSON.stringify(buf.subarray(off, off + 4).toString('ascii'))}`);
    if (len === 0) { out.push({ kind: 'flush', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (len === 1) { out.push({ kind: 'delim', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (len === 2) { out.push({ kind: 'end', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (len < 4 || off + len > buf.length) throw new Error('truncated pkt-line');
    out.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return out;
}
export function pktTextLines(buf: Buffer): string[] {
  return decodePackets(buf).filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8'));
}

// ---------------------------------------------------------------- packfile
const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function writePack(objects: Array<{ type: GitObjectType; data: Buffer }>): Buffer {
  const parts: Buffer[] = [Buffer.from('PACK'), Buffer.alloc(4), Buffer.alloc(4)];
  parts[1].writeUInt32BE(2, 0);
  parts[2].writeUInt32BE(objects.length, 0);
  for (const obj of objects) {
    const comp = deflateSync(obj.data);
    const size = obj.data.length;
    const first = (TYPE_CODE[obj.type] << 4) | (size & 0x0f);
    let rest = size >> 4;
    const header: number[] = [];
    if (rest === 0) header.push(first);
    else {
      header.push(first | 0x80);
      while (rest > 0) {
        const b = rest & 0x7f; rest >>= 7;
        header.push(rest > 0 ? b | 0x80 : b);
      }
    }
    parts.push(Buffer.from(header), comp);
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

function readVarint(buf: Buffer, off: number): { value: number; next: number; first: number } {
  let byte = buf[off]; const first = byte;
  let value = byte & 0x0f; let shift = 4; let pos = off + 1;
  while (byte & 0x80) { byte = buf[pos++]; value += (byte & 0x7f) * 2 ** shift; shift += 7; }
  return { value, next: pos, first };
}
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readSize = (): number => {
    let v = 0; let sh = 0;
    for (;;) { const b = delta[off++]; v += (b & 0x7f) * 2 ** sh; sh += 7; if (!(b & 0x80)) break; }
    return v;
  };
  const srcSize = readSize(); const tgtSize = readSize();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(tgtSize); let written = 0;
  while (off < delta.length) {
    const op = delta[off++];
    if (op & 0x80) {
      let copyOff = 0; let copySize = 0; let sh = 0;
      for (let bit = 0; bit < 4; bit += 1) if (op & (1 << bit)) copyOff += delta[off++] * 2 ** sh, sh += 8; else sh += 8;
      sh = 0;
      for (let bit = 4; bit < 7; bit += 1) if (op & (1 << bit)) copySize += delta[off++] * 2 ** sh, sh += 8; else sh += 8;
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOff, copyOff + copySize); written += copySize;
    } else if (op !== 0) {
      const n = op & 0x7f;
      delta.copy(out, written, off, off + n); off += n; written += n;
    } else throw new Error('delta opcode 0');
  }
  if (written !== tgtSize) throw new Error('delta size mismatch');
  return out;
}

export interface PackObject { type: GitObjectType; data: Buffer; oid: string }
/** Parse a packfile; deltas resolve against earlier pack entries and the repo store. */
export function readPack(buf: Buffer, repo: Repo): PackObject[] {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const count = buf.readUInt32BE(8);
  const byOffset = new Map<number, PackObject>();
  const byOid = new Map<string, PackObject>();
  const pending: Array<{ offset: number; baseOid: string; delta: Buffer }> = [];
  let off = 12;
  for (let i = 0; i < count; i += 1) {
    const start = off;
    const { value: size, next, first } = readVarint(buf, off);
    const typeCode = (first >> 4) & 0x07;
    off = next;
    let baseOid: string | null = null; let baseOffset: number | null = null;
    if (typeCode === 6) {
      let byte = buf[off]; let v = byte & 0x7f; off += 1;
      while (byte & 0x80) { byte = buf[off++]; v = ((v + 1) * 128) + (byte & 0x7f); }
      baseOffset = start - v;
    } else if (typeCode === 7) {
      baseOid = buf.subarray(off, off + 20).toString('hex'); off += 20;
    }
    const inflated = inflateSync(buf.subarray(off), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    const data = inflated.buffer; off += inflated.engine.bytesWritten;
    if (data.length !== size) throw new Error('pack object size mismatch');
    if (typeCode === 6 || typeCode === 7) {
      const base = baseOffset !== null ? byOffset.get(baseOffset) : byOid.get(baseOid!);
      if (base) {
        const resolved = applyDelta(base.data, data);
        const oid = hashObject(base.type, resolved);
        const obj: PackObject = { type: base.type, data: resolved, oid };
        byOffset.set(start, obj); byOid.set(oid, obj);
      } else {
        pending.push({ offset: start, baseOid: baseOid ?? byOffset.get(baseOffset!)?.oid ?? '', delta: data });
        // keep a placeholder so later deltas can chain; resolved below
        byOffset.set(start, { type: 'blob', data: Buffer.alloc(0), oid: '' });
      }
      continue;
    }
    const type = CODE_TYPE[typeCode];
    if (!type) throw new Error(`unknown pack type ${typeCode}`);
    const oid = hashObject(type, data);
    const obj: PackObject = { type, data, oid };
    byOffset.set(start, obj); byOid.set(oid, obj);
  }
  // Resolve pending deltas (base may live in the repo store or earlier in the pack).
  for (const p of pending) {
    let base = byOid.get(p.baseOid);
    if (!base) {
      const stored = repo.objects.get(p.baseOid);
      if (stored) base = { type: stored.type, data: stored.data, oid: p.baseOid };
    }
    if (!base) throw new Error(`delta base ${p.baseOid} not found`);
    const resolved = applyDelta(base.data, p.delta);
    const oid = hashObject(base.type, resolved);
    const obj: PackObject = { type: base.type, data: resolved, oid };
    byOffset.set(p.offset, obj); byOid.set(oid, obj);
  }
  return [...byOid.values()];
}

// ---------------------------------------------------------------- fetch selection
export interface FetchPlan { objects: PackObject[]; shallow: string[]; unshallow: string[] }
/** Objects for a fetch: reachable from wants minus reachable from haves, honoring depth. */
export function planFetch(repo: Repo, wants: string[], haves: string[], depth: number | null, oldShallow: string[]): FetchPlan {
  // What the client already holds: the closure of its haves, but never past a shallow
  // boundary it declared — a shallow commit's parents are NOT held, even though the
  // commit graph names them. (A full reachable() walk here would wrongly exclude the
  // parent a deepen fetch is asking for.)
  const shallowSet = new Set(oldShallow);
  const haveReach = new Set<string>();
  const hq: string[] = [...haves];
  while (hq.length) {
    const oid = hq.pop()!;
    if (haveReach.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    haveReach.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      const tree = repo.objects.get(c.tree);
      if (tree?.type === 'tree') {
        const stack = [c.tree];
        while (stack.length) {
          const tOid = stack.pop()!;
          if (haveReach.has(tOid)) continue;
          haveReach.add(tOid);
          const t = repo.objects.get(tOid);
          if (t?.type === 'tree') for (const e of parseTree(t.data)) { if (e.mode === '40000') stack.push(e.oid); else haveReach.add(e.oid); }
        }
      }
      if (!shallowSet.has(oid)) for (const p of c.parents) hq.push(p);
    } else if (obj.type === 'tag') hq.push(parseTag(obj.data).object);
    else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) hq.push(e.oid);
    }
  }
  // Commit generations from wants.
  const gen = new Map<string, number>();
  const queue: Array<[string, number]> = wants.map((w) => [w, 0] as [string, number]);
  let qHead = 0;
  const wantCommits = new Set<string>();
  while (qHead < queue.length) {
    const [oid, g] = queue[qHead++]!;
    if (gen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    if (obj.type === 'tag') { queue.push([parseTag(obj.data).object, g]); continue; }
    if (obj.type !== 'commit') continue;
    gen.set(oid, g); wantCommits.add(oid);
    if (depth === null || g + 1 < depth) {
      for (const p of parseCommit(obj.data).parents) queue.push([p, g + 1]);
    }
  }
  const shallow: string[] = [];
  const shallowSet2 = new Set<string>();
  for (const [oid, g] of gen) {
    if (depth !== null && g === depth - 1) {
      const obj = repo.objects.get(oid);
      if (obj?.type === 'commit' && parseCommit(obj.data).parents.length > 0) { shallow.push(oid); shallowSet2.add(oid); }
    }
  }
  const unshallow: string[] = [];
  for (const s of oldShallow) {
    if (gen.has(s) && !shallowSet2.has(s)) unshallow.push(s);
  }
  // Depth-limited closure: only the included commits and the trees/blobs they name.
  // repo.reachable() walks parents without a depth bound, so it cannot be used here.
  const reach = new Set<string>();
  const addTree = (treeOid: string) => {
    const t = repo.objects.get(treeOid);
    if (!t || t.type !== 'tree' || reach.has(treeOid)) return;
    reach.add(treeOid);
    for (const e of parseTree(t.data)) {
      if (e.mode === '40000') addTree(e.oid);
      else reach.add(e.oid);
    }
  };
  for (const w of wants) {
    const obj = repo.objects.get(w);
    if (obj?.type === 'tag') { reach.add(w); }
  }
  for (const c of wantCommits) {
    reach.add(c);
    const obj = repo.objects.get(c);
    if (obj?.type === 'commit') addTree(parseCommit(obj.data).tree);
  }
  const send = [...reach].filter((oid) => !haveReach.has(oid));
  const objects: PackObject[] = send.sort().map((oid) => {
    const o = repo.objects.get(oid)!;
    return { type: o.type, data: o.data, oid };
  });
  return { objects, shallow, unshallow };
}

export function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  let off = 0;
  while (off < pack.length) {
    // pkt-line total must stay <= 65520: 4 header + 1 band byte + data, so data <= 65515.
    const chunk = pack.subarray(off, Math.min(pack.length, off + 65500));
    parts.push(pkt(Buffer.concat([Buffer.from([1]), chunk])));
    off += chunk.length;
  }
  if (pack.length === 0) parts.push(pkt(Buffer.from([1])));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- advertisements
/** Refs in byte order: plain code-unit comparison is both faster than localeCompare and
 *  independent of the runtime's locale data, so two runs list refs in the same order. */
export function sortedRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}
export function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack'
    ? 'side-band-64k thin-pack ofs-delta multi_ack multi_ack_detailed shallow agent=forge/1.0 symref=HEAD:refs/heads/main'
    : 'report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=forge/1.0 symref=HEAD:refs/heads/main';
  const parts: Buffer[] = [pkt(`# service=${service}\n`), FLUSH];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pkt(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headTip = repo.tipOf(repo.defaultBranch);
    parts.push(pkt(`${headTip ?? ZERO_OID} HEAD\0${caps}\n`));
    for (const [name, oid] of refs) {
      parts.push(pkt(`${oid} ${name}\n`));
      const obj = repo.objects.get(oid);
      if (obj?.type === 'tag') parts.push(pkt(`${repo.peel(oid)} ${name}^{}\n`));
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}
export function v2Advertisement(service: 'git-upload-pack'): Buffer {
  return Buffer.concat([
    pkt(`# service=${service}\n`),
    pkt('version 2\n'),
    pkt('ls-refs=unborn\n'),
    pkt('fetch=shallow filter\n'),
    pkt('object-format=sha1\n'),
    pkt('agent=forge/1.0\n'),
    FLUSH,
  ]);
}

/** ls-refs v2 response lines for the requested prefixes/flags. */
export function lsRefsResponse(repo: Repo, opts: { peel: boolean; symrefs: boolean; prefixes: string[] }): Buffer {
  const parts: Buffer[] = [];
  const headTip = repo.tipOf(repo.defaultBranch);
  const keep = (name: string): boolean => opts.prefixes.length === 0 || opts.prefixes.some((p) => name.startsWith(p));
  if (opts.symrefs && opts.prefixes.length === 0) {
    if (headTip) parts.push(pkt(`${headTip} HEAD symref-target:refs/heads/main\n`));
    else parts.push(pkt(`unborn HEAD symref-target:refs/heads/main\n`));
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!keep(name)) continue;
    let line = `${oid} ${name}`;
    if (opts.peel) {
      const obj = repo.objects.get(oid);
      if (obj?.type === 'tag') line += ` peeled:${repo.peel(oid)}`;
    }
    parts.push(pkt(`${line}\n`));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** The memo key for a fetch: the exact request — same wants, haves, depth and shallow lines
 *  always build the same pack, because a fetch's reachable set from fixed wants is fixed once
 *  those commits exist and objects are never deleted. */
export function fetchCacheKey(wants: string[], haves: string[], depth: number | null, oldShallow: string[]): string {
  return JSON.stringify([[...wants].sort(), [...haves].sort(), depth, [...oldShallow].sort()]);
}

/** v2 fetch response: acknowledgments, shallow-info, packfile sections. */
export function v2FetchResponse(repo: Repo, wants: string[], haves: string[], depth: number | null, oldShallow: string[]): Buffer {
  const key = fetchCacheKey(wants, haves, depth, oldShallow);
  const cached = repo.cachedPack(key);
  if (cached !== undefined) return cached;
  const plan = planFetch(repo, wants, haves, depth, oldShallow);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  parts.push(pkt('acknowledgments\n'), pkt('NAK\n'), FLUSH);
  if (depth !== null || oldShallow.length > 0) {
    parts.push(pkt('shallow-info\n'));
    for (const s of plan.shallow) parts.push(pkt(`shallow ${s}\n`));
    for (const s of plan.unshallow) parts.push(pkt(`unshallow ${s}\n`));
    parts.push(FLUSH);
  }
  parts.push(pkt('packfile\n'));
  parts.push(sidebandPack(pack));
  parts.push(FLUSH);
  const out = Buffer.concat(parts);
  repo.rememberPack(key, out);
  return out;
}

/** v0 fetch response: NAK, shallow lines, sideband pack. */
export function v0FetchResponse(repo: Repo, wants: string[], haves: string[], depth: number | null, oldShallow: string[]): Buffer {
  const key = `v0:${fetchCacheKey(wants, haves, depth, oldShallow)}`;
  const cached = repo.cachedPack(key);
  if (cached !== undefined) return cached;
  const plan = planFetch(repo, wants, haves, depth, oldShallow);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [pkt('NAK\n')];
  for (const s of plan.shallow) parts.push(pkt(`shallow ${s}\n`));
  for (const s of plan.unshallow) parts.push(pkt(`unshallow ${s}\n`));
  parts.push(sidebandPack(pack), FLUSH);
  const out = Buffer.concat(parts);
  repo.rememberPack(key, out);
  return out;
}

export interface PushCommand { oldOid: string; newOid: string; ref: string }
/** Parse a receive-pack body into commands + pack bytes (pack follows the flush). */
export function parseReceiveBody(body: Buffer): { commands: PushCommand[]; pack: Buffer } {
  const commands: PushCommand[] = [];
  let off = 0;
  while (off + 4 <= body.length) {
    const hex = body.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
    const len = parseInt(hex, 16);
    if (len === 0) { off += 4; break; }
    if (len < 4 || off + len > body.length) break;
    const line = body.subarray(off + 4, off + len).toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    const clean = nul >= 0 ? line.slice(0, nul) : line;
    const [oldOid, newOid, ref] = clean.split(' ');
    if (oldOid && newOid && ref) commands.push({ oldOid, newOid, ref });
    off += len;
  }
  return { commands, pack: body.subarray(off) };
}

/** Apply a push: import the pack, validate fast-forward per ref, build the report. */
export function applyPush(repo: Repo, commands: PushCommand[], pack: Buffer): { report: Buffer; unpackOk: boolean } {
  let unpackOk = true;
  if (pack.length > 0) {
    try {
      const objects = readPack(pack, repo);
      // readPack already hashed every object it resolved: store by known oid, no second hash.
      for (const o of objects) repo.putObjectKnown(o.oid, o.type, o.data);
    } catch {
      unpackOk = false;
    }
  }
  const lines: string[] = [unpackOk ? 'unpack ok' : 'unpack error'];
  for (const cmd of commands) {
    const current = repo.refs.get(cmd.ref);
    let ok = false; let reason = '';
    if (!unpackOk) { reason = 'unpack error'; }
    else if (cmd.newOid === ZERO_OID) {
      // delete
      if (current === undefined) { reason = 'no such ref'; }
      else if (current !== cmd.oldOid) { reason = 'non-fast-forward'; }
      else ok = true;
    } else {
      const target = repo.objects.get(cmd.newOid);
      if (!target) { reason = 'object not found'; }
      else if (current === undefined) {
        if (cmd.oldOid !== ZERO_OID) reason = 'non-fast-forward';
        else ok = true;
      } else if (current === cmd.newOid) ok = true;
      else if (cmd.oldOid !== current) reason = 'non-fast-forward';
      else if (cmd.ref.startsWith('refs/heads/') && target.type === 'commit' && !repo.isAncestor(current, cmd.newOid)) reason = 'non-fast-forward';
      else if (cmd.ref.startsWith('refs/heads/') && target.type !== 'commit') reason = 'non-fast-forward';
      else ok = true;
    }
    if (ok) {
      if (cmd.newOid === ZERO_OID) repo.refs.delete(cmd.ref);
      else repo.refs.set(cmd.ref, cmd.newOid);
      lines.push(`ok ${cmd.ref}`);
    } else {
      lines.push(`ng ${cmd.ref} ${reason || 'failed'}`);
    }
  }
  const reportText = pktLines(lines.map((l) => `${l}\n`));
  // Report inside sideband band 1, then a flush.
  const framed = Buffer.concat([pkt(Buffer.concat([Buffer.from([1]), reportText])), FLUSH]);
  return { report: framed, unpackOk };
}
