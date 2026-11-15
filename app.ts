// app.ts — the HTTP server: routing, auth, the REST v3 API, and the dispatch to
// the git smart-HTTP, GraphQL and MCP surfaces. Every REST reply is
// application/json with a non-empty X-GitHub-Request-Id; errors carry a JSON
// {"message": ...} body; unknown routes are 404 JSON, never HTML.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { gid, HttpError, type Issue, type Label, type Pull, type Repo, type Store } from './store.ts';
import {
  decodePktLines,
  isObjectId,
  parseCommit,
  ZERO_OID,
} from './git.ts';
import {
  handleFetchV0,
  handleFetchV2,
  handleLsRefs,
  handleReceivePack,
  v0Advertisement,
  v2Advertisement,
} from './git-http.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

// ---------------------------------------------------------------------------------------------
// response helpers
// ---------------------------------------------------------------------------------------------

function requestId(): string {
  return `req_${randomBytes(8).toString('hex')}`;
}

function sendJson(res: ServerResponse, status: number, value: unknown, extraHeaders: Record<string, string> = {}): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json',
    'x-github-request-id': requestId(),
    'content-length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'x-github-request-id': requestId(),
    'content-length': body.length,
  });
  res.end(body);
}

// ---------------------------------------------------------------------------------------------
// REST shapes
// ---------------------------------------------------------------------------------------------

function repoJson(store: Store, owner: string, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: gid('repo', repo.id),
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    owner: { login: owner, id: 1, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    html_url: `https://github.com/${owner}/${repo.name}`,
    url: `/api/v3/repos/${owner}/${repo.name}`,
    git_url: `git://github.com/${owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${owner}/${repo.name}.git`,
    clone_url: `https://github.com/${owner}/${repo.name}.git`,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    has_downloads: true,
    archived: false,
    disabled: false,
    fork: false,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    license: null,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return { id: label.id, node_id: gid('label', label.id), name: label.name, color: label.color, description: label.description, default: false };
}

function issueJson(store: Store, owner: string, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: gid('issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map(labelJson),
    comments: issue.comments.length,
    comments_url: `/api/v3/repos/${owner}/${repo.name}/issues/${issue.number}/comments`,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    user: { login: owner, type: 'User' },
    html_url: `https://github.com/${owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${owner}/${repo.name}/issues/${issue.number}`,
  };
}

function commentJson(store: Store, owner: string, repo: Repo, comment: { id: number; body: string; createdAt: string; updatedAt: string }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: gid('comment', repo.id, comment.id),
    body: comment.body,
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    user: { login: owner, type: 'User' },
    html_url: `https://github.com/${owner}/${repo.name}/issues/${comment.id}`,
  };
}

function pullJson(store: Store, owner: string, repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: gid('pr', repo.id, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${owner}:${pull.baseRef}` },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    user: { login: owner, type: 'User' },
    html_url: `https://github.com/${owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${owner}/${repo.name}/pulls/${pull.number}`,
    draft: false,
    additions: 0,
    deletions: 0,
    changed_files: 0,
    commits: 1,
  };
}

// ---------------------------------------------------------------------------------------------
// pagination
// ---------------------------------------------------------------------------------------------

function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  const perPageRaw = Number(query.get('per_page') ?? '30') || 30;
  const perPage = Math.min(100, Math.max(1, perPageRaw));
  return { page, perPage };
}

function paginate<T>(items: T[], page: number, perPage: number): { page: T[]; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  return { page: items.slice(start, start + perPage), totalPages };
}

function linkHeader(req: IncomingMessage, pathname: string, query: URLSearchParams, page: number, perPage: number, totalPages: number): string | null {
  if (page >= totalPages) return null;
  const host = req.headers.host ?? 'localhost';
  const base = `http://${host}${pathname}`;
  const build = (targetPage: number): string => {
    const params = new URLSearchParams(query);
    params.set('page', String(targetPage));
    params.set('per_page', String(perPage));
    return `${base}?${params.toString()}`;
  };
  const links = [`<${build(page + 1)}>; rel="next"`, `<${build(totalPages)}>; rel="last"`];
  if (page > 1) links.push(`<${build(1)}>; rel="first"`, `<${build(page - 1)}>; rel="prev"`);
  return links.join(', ');
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

// ---------------------------------------------------------------------------------------------
// the server
// ---------------------------------------------------------------------------------------------

export function createApp(store: Store): ReturnType<typeof createServer> {
  const server = createServer((req, res) => {
    void handleRequest(store, req, res).catch((err) => {
      if (!res.headersSent) {
        if (err instanceof HttpError) sendError(res, err.status, err.message);
        else sendError(res, 500, (err as Error).message || 'Internal Server Error');
      } else {
        res.end();
      }
    });
  });
  return server;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function handleRequest(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = url.pathname;
  const query = url.searchParams;

  // -- health: the only unauthenticated route -------------------------------------
  if (pathname === '/healthz' && method === 'GET') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // -- auth: every other request carries the shop token ----------------------------
  const authorization = req.headers.authorization ?? '';
  if (authorization !== `Bearer ${store.token}`) {
    sendError(res, 401, 'Requires authentication');
    return;
  }

  // -- git smart HTTP ---------------------------------------------------------------
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(pathname);
  if (gitMatch) {
    await handleGit(store, req, res, decodeSegment(gitMatch[1]), decodeSegment(gitMatch[2]), gitMatch[3] ?? '', query);
    return;
  }

  // -- GraphQL ----------------------------------------------------------------------
  if (pathname === '/api/graphql') {
    if (method !== 'POST') {
      sendError(res, 405, 'Method Not Allowed');
      return;
    }
    const body = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      sendError(res, 400, 'Invalid JSON body');
      return;
    }
    const result = executeGraphQL(store, parsed);
    sendJson(res, 200, result);
    return;
  }

  // -- MCP --------------------------------------------------------------------------
  if (pathname === '/mcp') {
    if (method === 'DELETE') {
      sendError(res, 405, 'Method Not Allowed');
      return;
    }
    if (method !== 'POST') {
      sendError(res, 405, 'Method Not Allowed');
      return;
    }
    const body = await readBody(req);
    const outcome = handleMcp(store, body.toString('utf8'));
    if (outcome.body === '') {
      res.writeHead(outcome.status, { 'x-github-request-id': requestId() });
      res.end();
      return;
    }
    sendRaw(res, outcome.status, 'application/json', Buffer.from(outcome.body, 'utf8'));
    return;
  }

  // -- REST v3 ----------------------------------------------------------------------
  if (pathname === '/api/v3' || pathname === '/api/v3/') {
    if (method !== 'GET') {
      sendError(res, 405, 'Method Not Allowed');
      return;
    }
    sendJson(res, 200, {
      current_user_url: '/api/v3/user',
      current_user_authorizations_html_url: 'https://github.com/settings/applications',
      authorizations_url: '/api/v3/authorizations',
      code_search_url: '/api/v3/search/code?q={query}',
      commit_search_url: '/api/v3/search/commits?q={query}',
      emails_url: '/api/v3/user/emails',
      emojis_url: '/api/v3/emojis',
      events_url: '/api/v3/events',
      feeds_url: '/api/v3/feeds',
      followers_url: '/api/v3/user/followers',
      following_url: '/api/v3/user/following{/other_user}',
      gists_url: '/api/v3/gists{/gist_id}',
      hub_url: '/api/v3/hub',
      issue_search_url: '/api/v3/search/issues?q={query}',
      issues_url: '/api/v3/issues',
      keys_url: '/api/v3/user/keys',
      label_search_url: '/api/v3/search/labels?q={query}',
      notifications_url: '/api/v3/notifications',
      organization_repositories_url: '/api/v3/orgs/{org}/repos',
      organization_teams_url: '/api/v3/orgs/{org}/teams',
      public_gists_url: '/api/v3/gists/public',
      rate_limit_url: '/api/v3/rate_limit',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      repository_search_url: '/api/v3/search/repositories?q={query}',
      current_user_repositories_url: '/api/v3/user/repos',
      starred_url: '/api/v3/user/starred{/owner}{/repo}',
      starred_gists_url: '/api/v3/gists/starred',
      topic_search_url: '/api/v3/search/topics?q={query}',
      user_url: '/api/v3/users/{user}',
      user_organizations_url: '/api/v3/user/orgs',
      user_repositories_url: '/api/v3/users/{user}/repos',
      user_search_url: '/api/v3/search/users?q={query}',
    }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }

  if (pathname.startsWith('/api/v3/')) {
    await handleRest(store, req, res, method, pathname.slice('/api/v3/'.length), query);
    return;
  }

  sendError(res, 404, 'Not Found');
}

// ---------------------------------------------------------------------------------------------
// git smart HTTP
// ---------------------------------------------------------------------------------------------

async function handleGit(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  repoName: string,
  suffix: string,
  query: URLSearchParams,
): Promise<void> {
  const method = req.method ?? 'GET';
  const repo = store.repoFor(owner, repoName);
  if (suffix === '/info/refs' && method === 'GET') {
    const service = query.get('service') ?? '';
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      sendError(res, 400, 'Unknown service');
      return;
    }
    if (!repo) {
      sendError(res, 404, 'Not Found');
      return;
    }
    const wantsV2 = service === 'git-upload-pack' && req.headers['git-protocol'] === 'version=2';
    const body = wantsV2 ? v2Advertisement() : v0Advertisement(store, repo, service as 'git-upload-pack' | 'git-receive-pack');
    sendRaw(res, 200, `application/x-${service}-advertisement`, body);
    return;
  }
  if (!repo) {
    sendError(res, 404, 'Not Found');
    return;
  }
  if (suffix === '/git-upload-pack' && method === 'POST') {
    const body = await readBody(req);
    let packets;
    try {
      packets = decodePktLines(body).packets;
    } catch {
      sendRaw(res, 400, 'text/plain', Buffer.from('malformed pkt-line stream', 'utf8'));
      return;
    }
    const first = packets.find((packet) => packet.kind === 'data');
    const firstLine = first ? first.data.toString('utf8').replace(/\n$/, '') : '';
    const isV2 = req.headers['git-protocol'] === 'version=2';
    let out: Buffer;
    if (isV2 && firstLine === 'command=ls-refs') {
      out = handleLsRefs(store, repo, packets);
    } else if (isV2 && firstLine === 'command=fetch') {
      out = handleFetchV2(store, repo, packets);
    } else if (!isV2 && firstLine.startsWith('want ')) {
      out = handleFetchV0(store, repo, packets);
    } else {
      sendRaw(res, 400, 'text/plain', Buffer.from('unknown upload-pack command', 'utf8'));
      return;
    }
    sendRaw(res, 200, 'application/x-git-upload-pack-result', out);
    return;
  }
  if (suffix === '/git-receive-pack' && method === 'POST') {
    const body = await readBody(req);
    const outcome = handleReceivePack(store, repo, body);
    sendRaw(res, outcome.status, outcome.contentType, outcome.body);
    return;
  }
  sendError(res, 404, 'Not Found');
}

// ---------------------------------------------------------------------------------------------
// REST v3
// ---------------------------------------------------------------------------------------------

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readBody(req);
  if (body.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, 'Invalid JSON body');
  }
  return parsed as Record<string, unknown>;
}

async function handleRest(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  tail: string,
  query: URLSearchParams,
): Promise<void> {
  const segments = tail.split('/').filter((part) => part !== '').map(decodeSegment);
  const { page, perPage } = pageParams(query);

  // -- /meta -----------------------------------------------------------------------
  if (segments.length === 1 && segments[0] === 'meta' && method === 'GET') {
    sendJson(res, 200, {
      verifiable_password_authentication: false,
      installed_version: '1.0.0',
      api_version: 'v3',
    });
    return;
  }

  // -- /user -----------------------------------------------------------------------
  if (segments.length === 1 && segments[0] === 'user' && method === 'GET') {
    if (store.viewerLogin === null) {
      sendError(res, 404, 'Not Found');
      return;
    }
    sendJson(res, 200, {
      login: store.viewerLogin,
      id: 1,
      node_id: gid('user', store.viewerLogin),
      type: 'User',
      html_url: `https://github.com/${store.viewerLogin}`,
      url: '/api/v3/user',
    });
    return;
  }

  // -- /user/repos ------------------------------------------------------------------
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'GET') {
      const repos = store.listRepos();
      const { page: pageItems, totalPages } = paginate(repos, page, perPage);
      const link = linkHeader(req, '/api/v3/user/repos', query, page, perPage, totalPages);
      const owner = store.viewerLogin ?? '';
      sendJson(res, 200, pageItems.map((repo) => repoJson(store, owner, repo)), link ? { link } : {});
      return;
    }
    if (method === 'POST') {
      const body = await readJsonBody(req);
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '') throw new HttpError(422, 'name is required');
      const repo = store.createRepo(name, body.private === true, typeof body.description === 'string' ? body.description : '');
      const owner = store.viewerLogin ?? '';
      sendJson(res, 201, repoJson(store, owner, repo));
      return;
    }
    sendError(res, 405, 'Method Not Allowed');
    return;
  }

  // -- /repos/{owner}/{repo}[...] ----------------------------------------------------
  if (segments.length >= 3 && segments[0] === 'repos') {
    const owner = segments[1];
    const repoName = segments[2];
    const repo = store.repoFor(owner, repoName);
    if (!repo) {
      sendError(res, 404, 'Not Found');
      return;
    }
    const rest = segments.slice(3);

    // GET /repos/{o}/{r}
    if (rest.length === 0) {
      if (method === 'GET') {
        sendJson(res, 200, repoJson(store, owner, repo));
        return;
      }
      if (method === 'PATCH') {
        const body = await readJsonBody(req);
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.isPrivate = body.private;
        repo.updatedAt = store.nowIso();
        sendJson(res, 200, repoJson(store, owner, repo));
        return;
      }
      if (method === 'DELETE') {
        store.deleteRepo(repo);
        res.writeHead(204, { 'x-github-request-id': requestId() });
        res.end();
        return;
      }
      sendError(res, 405, 'Method Not Allowed');
      return;
    }

    // /branches
    if (rest[0] === 'branches') {
      if (rest.length === 1 && method === 'GET') {
        const branches = store.listBranches(repo).map((branch) => ({
          name: branch.name,
          commit: { sha: branch.sha, url: `/api/v3/repos/${owner}/${repoName}/commits/${branch.sha}` },
          protected: false,
        }));
        sendJson(res, 200, branches);
        return;
      }
      if (rest.length >= 2 && method === 'GET') {
        const branchName = rest.slice(1).join('/');
        const tip = repo.refs.get(`refs/heads/${branchName}`);
        if (!tip) {
          sendError(res, 404, 'Not Found');
          return;
        }
        sendJson(res, 200, {
          name: branchName,
          commit: { sha: tip, url: `/api/v3/repos/${owner}/${repoName}/commits/${tip}` },
          protected: false,
        });
        return;
      }
      sendError(res, 405, 'Method Not Allowed');
      return;
    }

    // /commits
    if (rest[0] === 'commits' && method === 'GET') {
      const sha = query.get('sha') ?? undefined;
      const commits = store.listCommits(repo, sha, perPage).map((entry) => {
        const commit = parseCommit(repo.objects.get(entry.sha)!.data);
        const authorLine = commit.author;
        const authorName = authorLine.split(' <')[0];
        const authorEmail = (authorLine.match(/<([^>]*)>/) ?? [])[1] ?? '';
        return {
          sha: entry.sha,
          node_id: gid('commit', entry.sha),
          commit: {
            message: entry.message,
            author: { name: authorName, email: authorEmail, date: store.nowIso() },
            committer: { name: authorName, email: authorEmail, date: store.nowIso() },
            tree: { sha: commit.tree },
          },
          author: { login: owner, type: 'User' },
          committer: { login: owner, type: 'User' },
          parents: commit.parents.map((parent) => ({ sha: parent })),
          html_url: `https://github.com/${owner}/${repoName}/commit/${entry.sha}`,
          url: `/api/v3/repos/${owner}/${repoName}/commits/${entry.sha}`,
        };
      });
      sendJson(res, 200, commits);
      return;
    }

    // /git/refs
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (rest.length >= 4 && rest[2] === 'heads' && method === 'GET') {
        const branchName = rest.slice(3).join('/');
        const tip = repo.refs.get(`refs/heads/${branchName}`);
        if (!tip) {
          sendError(res, 404, 'Not Found');
          return;
        }
        sendJson(res, 200, {
          ref: `refs/heads/${branchName}`,
          node_id: gid('ref', repo.id, branchName),
          url: `/api/v3/repos/${owner}/${repoName}/git/refs/heads/${branchName}`,
          object: { sha: tip, type: 'commit', url: `/api/v3/repos/${owner}/${repoName}/git/commits/${tip}` },
        });
        return;
      }
      if (rest.length === 2 && method === 'POST') {
        const body = await readJsonBody(req);
        const ref = typeof body.ref === 'string' ? body.ref : '';
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (!ref.startsWith('refs/') || !isObjectId(sha)) throw new HttpError(422, 'Invalid ref or sha');
        if (repo.refs.has(ref)) throw new HttpError(422, `Reference already exists: ${ref}`);
        const object = repo.objects.get(sha);
        if (!object || object.type !== 'commit') throw new HttpError(422, 'Invalid commit sha');
        repo.refs.set(ref, sha);
        sendJson(res, 201, {
          ref,
          node_id: gid('ref', repo.id, ref),
          url: `/api/v3/repos/${owner}/${repoName}/git/refs/${ref}`,
          object: { sha, type: 'commit', url: `/api/v3/repos/${owner}/${repoName}/git/commits/${sha}` },
        });
        return;
      }
      sendError(res, 404, 'Not Found');
      return;
    }

    // /contents/{path}
    if (rest[0] === 'contents') {
      const path = rest.slice(1).join('/');
      if (method === 'GET') {
        const ref = query.get('ref') ?? undefined;
        const tip = store.resolveRef(repo, ref);
        if (tip === ZERO_OID) {
          sendError(res, 404, 'Not Found');
          return;
        }
        const found = store.lookupPath(repo, tip, path);
        if (!found) {
          sendError(res, 404, 'Not Found');
          return;
        }
        if (found.kind === 'file') {
          const blob = repo.objects.get(found.oid);
          sendJson(res, 200, {
            type: 'file',
            encoding: 'base64',
            size: found.size,
            name: path.split('/').pop() ?? path,
            path,
            content: blob ? blob.data.toString('base64') : '',
            sha: found.oid,
            url: `/api/v3/repos/${owner}/${repoName}/contents/${path}`,
            html_url: `https://github.com/${owner}/${repoName}/blob/${repo.defaultBranch}/${path}`,
            git_url: `/api/v3/repos/${owner}/${repoName}/git/blobs/${found.oid}`,
          });
          return;
        }
        sendJson(res, 200, found.entries.map((entry) => ({
          type: entry.mode === '40000' ? 'dir' : 'file',
          size: entry.mode === '40000' ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
          name: entry.name,
          path: entry.path,
          sha: entry.oid,
          url: `/api/v3/repos/${owner}/${repoName}/contents/${entry.path}`,
          html_url: `https://github.com/${owner}/${repoName}/tree/${repo.defaultBranch}/${entry.path}`,
          git_url: `/api/v3/repos/${owner}/${repoName}/git/trees/${entry.oid}`,
        })));
        return;
      }
      if (method === 'PUT') {
        const body = await readJsonBody(req);
        const message = typeof body.message === 'string' ? body.message : 'Update';
        const contentB64 = typeof body.content === 'string' ? body.content : '';
        const branch = typeof body.branch === 'string' ? body.branch : undefined;
        const sha = typeof body.sha === 'string' ? body.sha : undefined;
        let content: Buffer;
        try {
          content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
        } catch {
          throw new HttpError(400, 'Invalid base64 content');
        }
        const result = store.putContent(repo, path, content, message, branch, sha);
        sendJson(res, result.status, {
          content: {
            name: path.split('/').pop() ?? path,
            path,
            sha: result.blobSha,
            size: content.length,
            encoding: 'base64',
            url: `/api/v3/repos/${owner}/${repoName}/contents/${path}`,
          },
          commit: { sha: result.commitSha, message },
        });
        return;
      }
      if (method === 'DELETE') {
        const body = await readJsonBody(req);
        const message = typeof body.message === 'string' ? body.message : 'Delete';
        const branch = typeof body.branch === 'string' ? body.branch : undefined;
        const sha = typeof body.sha === 'string' ? body.sha : '';
        const result = store.deleteContent(repo, path, message, branch, sha);
        sendJson(res, 200, { commit: { sha: result.commitSha, message } });
        return;
      }
      sendError(res, 405, 'Method Not Allowed');
      return;
    }

    // /labels
    if (rest[0] === 'labels') {
      if (rest.length === 1 && method === 'GET') {
        sendJson(res, 200, [...repo.labels.values()].map(labelJson));
        return;
      }
      if (rest.length === 1 && method === 'POST') {
        const body = await readJsonBody(req);
        const name = typeof body.name === 'string' ? body.name : '';
        if (name === '') throw new HttpError(422, 'name is required');
        const label = store.createLabel(repo, name, typeof body.color === 'string' ? body.color : 'ededed');
        sendJson(res, 201, labelJson(label));
        return;
      }
      sendError(res, 404, 'Not Found');
      return;
    }

    // /issues
    if (rest[0] === 'issues') {
      if (rest.length === 1 && method === 'GET') {
        const state = query.get('state') ?? 'open';
        const sort = query.get('sort') ?? 'created';
        const direction = (query.get('direction') ?? 'desc') as 'asc' | 'desc';
        let issues = store.listIssues(repo, state, sort === 'created' ? direction : 'desc');
        const { page: pageItems, totalPages } = paginate(issues, page, perPage);
        const link = linkHeader(req, `/api/v3/repos/${owner}/${repoName}/issues`, query, page, perPage, totalPages);
        sendJson(res, 200, pageItems.map((issue) => issueJson(store, owner, repo, issue)), link ? { link } : {});
        return;
      }
      if (rest.length === 1 && method === 'POST') {
        const body = await readJsonBody(req);
        const title = typeof body.title === 'string' ? body.title : '';
        if (title === '') throw new HttpError(422, 'title is required');
        const labelNames = Array.isArray(body.labels)
          ? body.labels.map((label: unknown) => (typeof label === 'string' ? label : (label as { name?: string }).name ?? '')).filter(Boolean)
          : [];
        const issue = store.createIssue(repo, title, typeof body.body === 'string' ? body.body : '', labelNames);
        sendJson(res, 201, issueJson(store, owner, repo, issue));
        return;
      }
      if (rest.length >= 2) {
        const number = Number(rest[1]);
        const issue = repo.issueByNumber.get(number);
        if (!issue) {
          sendError(res, 404, 'Not Found');
          return;
        }
        if (rest.length === 2 && method === 'GET') {
          sendJson(res, 200, issueJson(store, owner, repo, issue));
          return;
        }
        if (rest.length === 2 && method === 'PATCH') {
          const body = await readJsonBody(req);
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
          issue.updatedAt = store.nowIso();
          sendJson(res, 200, issueJson(store, owner, repo, issue));
          return;
        }
        if (rest.length === 3 && rest[2] === 'comments') {
          if (method === 'GET') {
            sendJson(res, 200, issue.comments.map((comment) => commentJson(store, owner, repo, comment)));
            return;
          }
          if (method === 'POST') {
            const body = await readJsonBody(req);
            const commentBody = typeof body.body === 'string' ? body.body : '';
            if (commentBody === '') throw new HttpError(422, 'body is required');
            const comment = store.addComment(repo, issue, commentBody);
            sendJson(res, 201, commentJson(store, owner, repo, comment));
            return;
          }
        }
      }
      sendError(res, 404, 'Not Found');
      return;
    }

    // /pulls
    if (rest[0] === 'pulls') {
      if (rest.length === 1 && method === 'GET') {
        const state = query.get('state') ?? 'open';
        const pulls = store.listPulls(repo, state);
        const { page: pageItems, totalPages } = paginate(pulls, page, perPage);
        const link = linkHeader(req, `/api/v3/repos/${owner}/${repoName}/pulls`, query, page, perPage, totalPages);
        sendJson(res, 200, pageItems.map((pull) => pullJson(store, owner, repo, pull)), link ? { link } : {});
        return;
      }
      if (rest.length === 1 && method === 'POST') {
        const body = await readJsonBody(req);
        const title = typeof body.title === 'string' ? body.title : '';
        const head = typeof body.head === 'string' ? body.head : '';
        const base = typeof body.base === 'string' ? body.base : repo.defaultBranch;
        if (title === '' || head === '') throw new HttpError(422, 'title and head are required');
        const pull = store.createPull(repo, title, typeof body.body === 'string' ? body.body : '', head, base);
        sendJson(res, 201, pullJson(store, owner, repo, pull));
        return;
      }
      if (rest.length >= 2) {
        const number = Number(rest[1]);
        const pull = repo.pullByNumber.get(number);
        if (!pull) {
          sendError(res, 404, 'Not Found');
          return;
        }
        if (rest.length === 2 && method === 'GET') {
          sendJson(res, 200, pullJson(store, owner, repo, pull));
          return;
        }
        if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
          sendJson(res, 200, store.pullFiles(repo, pull).map((file) => ({
            filename: file.filename,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
            changes: file.changes,
            sha: '',
            raw_url: '',
            blob_url: '',
            patch: '',
          })));
          return;
        }
        if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
          const body = await readJsonBody(req);
          if (pull.state !== 'open') throw new HttpError(405, 'Pull request is not open');
          const mergeMethod = typeof body.merge_method === 'string' ? body.merge_method : 'squash';
          if (mergeMethod !== 'squash' && mergeMethod !== 'merge' && mergeMethod !== 'rebase') {
            throw new HttpError(422, 'Invalid merge_method');
          }
          const sha = store.squashMerge(repo, pull);
          sendJson(res, 200, {
            sha,
            merged: true,
            message: `Pull Request #${pull.number} successfully merged`,
          });
          return;
        }
      }
      sendError(res, 404, 'Not Found');
      return;
    }

    sendError(res, 404, 'Not Found');
    return;
  }

  sendError(res, 404, 'Not Found');
}
