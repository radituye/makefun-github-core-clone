// git-http.ts — git smart HTTP: info/refs advertisements (v0 + v2), upload-pack
// (v2 ls-refs/fetch, v0 fetch) and receive-pack (v0 push with report-status).
// The request and response shapes mirror what the suite's git client sends and
// parses, including the section framing of a v2 fetch and the sideband report
// of a push.

import {
  ZERO_OID,
  collectReachable,
  collectReachableBounded,
  decodePktLines,
  hashObject,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  pktLine,
  pktLines,
  readPack,
  sideband,
  writePack,
  PKT_DELIM,
  PKT_FLUSH,
  type GitObject,
} from './git.ts';
import { HttpError, type Repo, type Store } from './store.ts';

export const AGENT = 'makefun-forge/1.0';

const UPLOAD_V2_CAPABILITIES = [
  'ls-refs=unborn',
  'fetch=shallow thin-pack ofs-delta',
  'object-format=sha1',
  `agent=${AGENT}`,
];

const UPLOAD_V0_CAPABILITIES =
  'symref=HEAD:refs/heads/main side-band-64k ofs-delta thin-pack shallow multi_ack agent=' + AGENT;

const RECEIVE_V0_CAPABILITIES =
  'report-status side-band-64k delete-refs ofs-delta agent=' + AGENT;

// ---------------------------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------------------------

/** The v2 capability advertisement: `version 2` + one capability per pkt-line. */
export function v2Advertisement(): Buffer {
  return pktLines(['version 2\n', ...UPLOAD_V2_CAPABILITIES.map((cap) => `${cap}\n`), 'flush']);
}

/** The v0 advertisement: `# service=...` preamble, flush, ref lines, flush. */
export function v0Advertisement(store: Store, repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const capabilities = service === 'git-upload-pack' ? UPLOAD_V0_CAPABILITIES : RECEIVE_V0_CAPABILITIES;
  const items: Array<string | Buffer | 'flush'> = [`# service=${service}\n`, 'flush'];
  const refs = store.listRefs(repo);
  if (refs.length === 0) {
    items.push(`${ZERO_OID} capabilities^{}\0${capabilities}\n`);
  } else {
    refs.forEach((ref, index) => {
      if (index === 0) items.push(`${ref.oid} ${ref.name}\0${capabilities}\n`);
      else items.push(`${ref.oid} ${ref.name}\n`);
    });
    for (const ref of refs) {
      if (!ref.name.startsWith('refs/tags/')) continue;
      const peeled = store.peeledCommit(repo, ref.name);
      if (peeled) items.push(`${peeled} ${ref.name}^{}\n`);
    }
  }
  items.push('flush');
  return pktLines(items);
}

// ---------------------------------------------------------------------------------------------
// fetch computation
// ---------------------------------------------------------------------------------------------

export interface FetchPlan {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
}

/** Collect a tree's objects (the tree itself, nested trees, blobs) into `out`. */
function collectTreeObjects(objects: Map<string, GitObject>, treeOid: string, out: Map<string, GitObject>): void {
  const tree = objects.get(treeOid);
  if (!tree || tree.type !== 'tree') return;
  if (out.has(treeOid)) return;
  out.set(treeOid, tree);
  for (const entry of parseTree(tree.data)) {
    const child = objects.get(entry.oid);
    if (!child) continue;
    if (entry.mode === '40000') collectTreeObjects(objects, entry.oid, out);
    else out.set(entry.oid, child);
  }
}

/**
 * Work out what a fetch sends. Wants are commit/tag oids; haves are oids the client
 * already holds; depth caps the walk (boundary commits are shallow); deepen-since
 * cuts by committer date; deepen-not excludes a ref's history; the client's own
 * shallow boundaries stay shallow unless the walk deepens past them.
 */
export function computeFetch(
  repo: Repo,
  wants: string[],
  haves: string[],
  depth: number | null,
  deepenSince: number | null,
  deepenNot: string[],
  clientShallow: string[],
): FetchPlan {
  const objects = repo.objects;
  const clientShallowSet = new Set(clientShallow);
  // Objects the client already holds: reachable from its haves, but never past
  // a shallow boundary it declared — it holds the boundary commit, not its
  // parents, so a deepen can still walk past the boundary to older commits.
  const heldSet = collectReachableBounded(objects, haves, clientShallowSet);
  const notReachable = new Set<string>();
  for (const ref of deepenNot) {
    const tip = repo.resolveRef(repo, ref);
    if (tip !== ZERO_OID) for (const oid of collectReachable(objects, [tip])) notReachable.add(oid);
  }
  const excluded = (oid: string): boolean => heldSet.has(oid) || notReachable.has(oid);

  const included = new Map<string, GitObject>();
  const shallow = new Set<string>();
  const unshallow = new Set<string>();
  const commitDepth = new Map<string, number>();

  // A want may be a tag: include the tag chain, then walk from its commit.
  const enqueueCommits: Array<{ oid: string; depth: number }> = [];
  const addObject = (oid: string): void => {
    if (excluded(oid)) return;
    const object = objects.get(oid);
    if (object) included.set(oid, object);
  };
  for (const want of wants) {
    let current = want;
    for (let hops = 0; hops < 10; hops += 1) {
      const object = objects.get(current);
      if (!object) break;
      if (object.type === 'tag') {
        addObject(current);
        current = parseTag(object.data).object;
        continue;
      }
      break;
    }
    if (isObjectId(current) && objects.get(current)?.type === 'commit') {
      enqueueCommits.push({ oid: current, depth: 1 });
    } else if (isObjectId(current)) {
      addObject(current);
    }
  }

  // Breadth-first walk from the wants; first visit wins, so depth is shallowest.
  const queue = [...enqueueCommits];
  while (queue.length > 0) {
    const { oid, depth: d } = queue.shift()!;
    if (commitDepth.has(oid)) continue;
    const object = objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    const held = excluded(oid);
    // A held commit that is not a shallow boundary is fully held: skip it and
    // do not walk past it. A held shallow boundary is held itself, but its
    // parents are not — walk past it so a deepen can reach them.
    if (held && !clientShallowSet.has(oid)) continue;
    commitDepth.set(oid, d);
    const commit = parseCommit(object.data);
    if (!held) {
      included.set(oid, object);
      collectTreeObjects(objects, commit.tree, included);
    }
    // Boundary? Depth cap, a client shallow boundary with no deepen, or the
    // deepen-since cutoff: include the commit and its tree, not its parents.
    let boundary = false;
    if (depth !== null && d >= depth) boundary = true;
    if (depth === null && clientShallowSet.has(oid)) boundary = true;
    if (deepenSince !== null) {
      const committerEpoch = Number((commit.committer.match(/ (\d+) [+-]\d{4}$/) ?? [])[1] ?? 0);
      if (committerEpoch !== 0 && committerEpoch < deepenSince) boundary = true;
    }
    if (boundary) {
      shallow.add(oid);
      continue;
    }
    if (clientShallowSet.has(oid)) unshallow.add(oid);
    for (const parent of commit.parents) {
      if (!commitDepth.has(parent)) queue.push({ oid: parent, depth: d + 1 });
    }
  }

  // Client shallow boundaries that were never reached stay out of the report;
  // ones reached but still boundaries are shallow, ones deepened past are unshallow.
  for (const oid of clientShallowSet) {
    if (!commitDepth.has(oid)) continue;
    if (shallow.has(oid)) unshallow.delete(oid);
    else unshallow.add(oid);
  }

  const out: GitObject[] = [];
  for (const [oid, object] of included) {
    if (!excluded(oid)) out.push(object);
  }
  return { objects: out, shallow: [...shallow], unshallow: [...unshallow] };
}

// ---------------------------------------------------------------------------------------------
// upload-pack
// ---------------------------------------------------------------------------------------------

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  deepenSince: number | null;
  deepenNot: string[];
}

function parseFetchArgs(lines: string[]): FetchRequest {
  const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: null, deepenSince: null, deepenNot: [] };
  for (const line of lines) {
    if (line.startsWith('want ')) request.wants.push(line.slice(5).split(' ')[0]);
    else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number(line.slice(7).trim());
      if (Number.isFinite(n)) request.depth = n;
    } else if (line.startsWith('deepen-since ')) {
      const n = Number(line.slice(13).trim());
      if (Number.isFinite(n)) request.deepenSince = n;
    } else if (line.startsWith('deepen-not ')) {
      request.deepenNot.push(line.slice(11).trim());
    }
  }
  return request;
}

/** The v2 ls-refs answer: ref lines with symref-target / peeled attributes, then flush. */
export function handleLsRefs(store: Store, repo: Repo, packets: ReturnType<typeof decodePktLines>['packets']): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  let pastDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (packet.kind !== 'data' || !pastDelim) continue;
    const line = packet.data.toString('utf8').replace(/\n$/, '');
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const out: string[] = [];
  const tip = repo.refs.get(store.defaultRef(repo));
  if (!tip) {
    if (unborn && keep('HEAD')) out.push('unborn HEAD symref-target:refs/heads/main\n');
  } else {
    if (keep('HEAD')) {
      out.push(`${tip} HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`);
    }
    for (const [ref, oid] of [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      if (!keep(ref)) continue;
      let line = `${oid} ${ref}`;
      if (ref.startsWith('refs/tags/') && peel) {
        const peeled = store.peeledCommit(repo, ref);
        if (peeled) line += ` peeled:${peeled}`;
      }
      out.push(`${line}\n`);
    }
  }
  return pktLines([...out, 'flush']);
}

/** The v2 fetch answer: acknowledgments, shallow-info, packfile sections. */
export function handleFetchV2(store: Store, repo: Repo, packets: ReturnType<typeof decodePktLines>['packets']): Buffer {
  const lines: string[] = [];
  let pastDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (packet.kind !== 'data' || !pastDelim) continue;
    lines.push(packet.data.toString('utf8').replace(/\n$/, ''));
  }
  const request = parseFetchArgs(lines);
  const plan = computeFetch(repo, request.wants, request.haves, request.depth, request.deepenSince, request.deepenNot, request.shallow);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  const knownHave = request.haves.find((have) => repo.objects.has(have));
  parts.push(pktLine(knownHave ? `ACK ${knownHave}\n` : 'NAK\n'));
  parts.push(PKT_DELIM);
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sideband(1, pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** The v0 fetch answer: NAK/ACK and shallow lines as plain packets, then the pack on sideband. */
export function handleFetchV0(store: Store, repo: Repo, packets: ReturnType<typeof decodePktLines>['packets']): Buffer {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    lines.push(packet.data.toString('utf8').replace(/\n$/, ''));
  }
  const request = parseFetchArgs(lines);
  const plan = computeFetch(repo, request.wants, request.haves, request.depth, request.deepenSince, request.deepenNot, request.shallow);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  const knownHave = request.haves.find((have) => repo.objects.has(have));
  parts.push(pktLine(knownHave ? `ACK ${knownHave}\n` : 'NAK\n'));
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(sideband(1, pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------------------------

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
  capabilities: string[];
}

interface ParsedPush {
  commands: PushCommand[];
  pack: Buffer;
}

/**
 * Parse a receive-pack body: command pkt-lines up to the first flush, then the
 * packfile raw. Returns null when the body is not pkt-lines at all.
 */
export function parsePushBody(body: Buffer): ParsedPush | null {
  const commands: PushCommand[] = [];
  let offset = 0;
  for (;;) {
    if (offset + 4 > body.length) return null;
    const head = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) return null;
    const len = parseInt(head, 16);
    if (len === 0) {
      offset += 4;
      break;
    }
    if (len < 4 || offset + len > body.length) return null;
    const text = body.subarray(offset + 4, offset + len).toString('utf8');
    offset += len;
    const nul = text.indexOf('\0');
    const capabilities = nul >= 0 ? text.slice(nul + 1).replace(/\n$/, '').split(' ').filter(Boolean) : [];
    const commandText = (nul >= 0 ? text.slice(0, nul) : text).replace(/\n$/, '');
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(commandText);
    if (!match) return null;
    commands.push({ oldOid: match[1], newOid: match[2], ref: match[3], capabilities });
  }
  if (commands.length === 0) return null;
  return { commands, pack: body.subarray(offset) };
}

/**
 * Apply a push: unpack the pack into the repo's object store, then fast-forward
 * each ref. The report is pkt-lined inside sideband band 1 when the client
 * negotiated side-band-64k, else the raw pkt-line stream.
 */
export function handleReceivePack(store: Store, repo: Repo, body: Buffer): { status: number; body: Buffer; contentType: string } {
  const parsed = parsePushBody(body);
  if (!parsed) {
    return { status: 400, body: Buffer.from('malformed pkt-line stream', 'utf8'), contentType: 'text/plain' };
  }
  const { commands } = parsed;
  const sidebandNegotiated = commands[0].capabilities.includes('side-band-64k');
  const updatesRef = commands.some((command) => command.newOid !== ZERO_OID);

  let unpackError: string | null = null;
  if (updatesRef) {
    if (parsed.pack.length === 0) {
      unpackError = 'missing packfile';
    } else {
      try {
        const objects = readPack(parsed.pack, (oid) => repo.objects.get(oid));
        for (const [oid, object] of objects) repo.objects.set(oid, object);
      } catch (err) {
        unpackError = (err as Error).message;
      }
    }
  }

  const lines: string[] = [];
  lines.push(unpackError ? `unpack ${unpackError}\n` : 'unpack ok\n');
  for (const command of commands) {
    if (unpackError) {
      lines.push(`ng ${command.ref} unpacker error\n`);
      continue;
    }
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (!current) lines.push(`ng ${command.ref} no such ref\n`);
      else if (current !== command.oldOid) lines.push(`ng ${command.ref} non-fast-forward\n`);
      else {
        repo.refs.delete(command.ref);
        lines.push(`ok ${command.ref}\n`);
      }
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      // Create.
      if (current) lines.push(`ng ${command.ref} already exists\n`);
      else if (!repo.objects.has(command.newOid)) lines.push(`ng ${command.ref} object not found\n`);
      else {
        repo.refs.set(command.ref, command.newOid);
        lines.push(`ok ${command.ref}\n`);
      }
      continue;
    }
    // Update: the ref must be at oldOid and the new tip must descend from it.
    if (!current || current !== command.oldOid) {
      lines.push(`ng ${command.ref} non-fast-forward\n`);
      continue;
    }
    if (!isFastForward(repo, command.oldOid, command.newOid)) {
      lines.push(`ng ${command.ref} non-fast-forward\n`);
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    lines.push(`ok ${command.ref}\n`);
  }

  const report = pktLines([...lines, 'flush']);
  const out = sidebandNegotiated
    ? Buffer.concat([sideband(1, report), PKT_FLUSH])
    : Buffer.concat([report, PKT_FLUSH]);
  return { status: 200, body: out, contentType: 'application/x-git-receive-pack-result' };
}

function isFastForward(repo: Repo, oldOid: string, newOid: string): boolean {
  if (oldOid === newOid) return true;
  const object = repo.objects.get(newOid);
  if (!object) return false;
  if (object.type === 'tag') {
    const target = parseTag(object.data).object;
    return isFastForward(repo, oldOid, target);
  }
  if (object.type !== 'commit') return false;
  const seen = new Set<string>();
  const stack = [newOid];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (oid === oldOid) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const current = repo.objects.get(oid);
    if (!current || current.type !== 'commit') continue;
    for (const parent of parseCommit(current.data).parents) stack.push(parent);
  }
  return false;
}
