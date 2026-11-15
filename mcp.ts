// mcp.ts — the Model Context Protocol endpoint: JSON-RPC 2.0 over Streamable HTTP.
// Speaks the modern 2026-07-28 era (server/discover) and the legacy handshake
// (initialize + notifications/initialized). The six tools act on the same store as
// REST, so a repo or issue created over MCP reads back over /api/v3 unchanged.

import { gid, HttpError, type Store } from './store.ts';

export const MCP_REVISION = '2026-07-28';
export const MCP_SUPPORTED_REVISIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'];

interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

// The tool list is a constant: two tools/list calls answer byte for byte the same.
export const MCP_TOOLS: McpTool[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by its owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository as owner/name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
        full_name: { type: 'string', description: 'The repository as owner/name.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, newest first by default.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
        full_name: { type: 'string', description: 'The repository as owner/name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch onto a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
        full_name: { type: 'string', description: 'The repository as owner/name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request onto its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
        full_name: { type: 'string', description: 'The repository as owner/name.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** owner/repo out of a tool's arguments, accepting a full_name fallback. */
function repoScope(args: Record<string, unknown>): { owner: string; repo: string } {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let repo = typeof args.repo === 'string' ? args.repo : '';
  if ((!owner || !repo) && typeof args.full_name === 'string') {
    const slash = args.full_name.indexOf('/');
    if (slash > 0) {
      owner = owner || args.full_name.slice(0, slash);
      repo = repo || args.full_name.slice(slash + 1);
    }
  }
  return { owner, repo };
}

function repoJson(store: Store, owner: string, repoName: string): Record<string, unknown> {
  const repo = store.repoFor(owner, repoName);
  if (!repo) throw new HttpError(404, 'Not Found');
  return {
    id: repo.id,
    node_id: gid('repo', repo.id),
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    owner: { login: owner },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  };
}

function issueJson(store: Store, repo: { id: number }, issue: {
  id: number; number: number; title: string; body: string; state: string;
  labels: Array<{ name: string; color: string }>; comments: unknown[]; createdAt: string; updatedAt: string;
}): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: gid('issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

function pullJson(store: Store, owner: string, repo: { id: number }, pull: {
  id: number; number: number; title: string; body: string; state: string; merged: boolean;
  mergedAt: string | null; mergeCommitSha: string | null; headRef: string; baseRef: string;
  headSha: string; baseSha: string; createdAt: string; updatedAt: string;
}): Record<string, unknown> {
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
  };
}

function toolResult(structured: unknown): Record<string, unknown> {
  const text = typeof structured === 'string' ? structured : JSON.stringify(structured);
  return { content: [{ type: 'text', text }], structuredContent: structured };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = MCP_TOOLS.find((candidate) => candidate.name === name);
  if (!tool) return toolError(`Unknown tool: ${name}`);
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return toolError(`Missing required argument: ${required}`);
    }
  }
  try {
    switch (name) {
      case 'create_repo': {
        const repo = store.createRepo(
          String(args.name),
          args.private === true,
          typeof args.description === 'string' ? args.description : '',
        );
        const owner = store.viewerLogin ?? '';
        return toolResult(repoJson(store, owner, repo.name));
      }
      case 'get_repo': {
        const { owner, repo } = repoScope(args);
        return toolResult(repoJson(store, owner, repo));
      }
      case 'create_issue': {
        const { owner, repo: repoName } = repoScope(args);
        const repo = store.repoFor(owner, repoName);
        if (!repo) throw new HttpError(404, 'Not Found');
        const issue = store.createIssue(
          repo,
          String(args.title),
          typeof args.body === 'string' ? args.body : '',
          [],
        );
        return toolResult(issueJson(store, repo, issue));
      }
      case 'list_issues': {
        const { owner, repo: repoName } = repoScope(args);
        const repo = store.repoFor(owner, repoName);
        if (!repo) throw new HttpError(404, 'Not Found');
        const state = typeof args.state === 'string' ? args.state : 'open';
        const issues = store.listIssues(repo, state, 'desc');
        const list = issues.map((issue) => issueJson(store, repo, issue));
        return { content: [{ type: 'text', text: JSON.stringify(list) }], structuredContent: { issues: list } };
      }
      case 'create_pull_request': {
        const { owner, repo: repoName } = repoScope(args);
        const repo = store.repoFor(owner, repoName);
        if (!repo) throw new HttpError(404, 'Not Found');
        const pull = store.createPull(
          repo,
          String(args.title),
          typeof args.body === 'string' ? args.body : '',
          String(args.head),
          String(args.base),
        );
        return toolResult(pullJson(store, owner, repo, pull));
      }
      case 'merge_pull_request': {
        const { owner, repo: repoName } = repoScope(args);
        const repo = store.repoFor(owner, repoName);
        if (!repo) throw new HttpError(404, 'Not Found');
        const number = Number(args.pull_number);
        const pull = repo.pullByNumber.get(number);
        if (!pull) throw new HttpError(404, 'Pull request not found');
        if (pull.state !== 'open') throw new HttpError(422, 'Pull request is not open');
        const sha = store.squashMerge(repo, pull);
        return toolResult({
          number: pull.number,
          merged: true,
          sha,
          message: `Pull request #${pull.number} merged.`,
          state: 'closed',
        });
      }
      default:
        return toolError(`Unknown tool: ${name}`);
    }
  } catch (err) {
    if (err instanceof HttpError) return toolError(err.message);
    throw err;
  }
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

/**
 * Handle one POST /mcp body. Returns {status, body} where body is a JSON string
 * (empty for notifications, which answer 202 with no body).
 */
export function handleMcp(store: Store, bodyText: string): { status: number; body: string } {
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return {
      status: 400,
      body: JSON.stringify(rpcError(null, -32700, 'Parse error')),
    };
  }
  if (!isRecord(body) || typeof body.method !== 'string') {
    return { status: 200, body: JSON.stringify(rpcError(isRecord(body) ? body.id : null, -32600, 'Invalid Request')) };
  }
  const id = body.id;
  const method = body.method;
  const params = isRecord(body.params) ? body.params : {};

  // A notification (no id) is answered with 202 and no body.
  if (id === undefined) {
    return { status: 202, body: '' };
  }

  switch (method) {
    case 'server/discover': {
      const serverInfo = { name: 'makefun-forge', version: '1.0.0' };
      return {
        status: 200,
        body: JSON.stringify(rpcResult(id, {
          protocolVersion: MCP_REVISION,
          supportedVersions: MCP_SUPPORTED_REVISIONS,
          serverInfo,
          capabilities: { tools: {} },
          _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
        })),
      };
    }
    case 'initialize': {
      const offered = typeof (params as Record<string, unknown>).protocolVersion === 'string'
        ? (params as Record<string, unknown>).protocolVersion as string
        : MCP_REVISION;
      const negotiated = /^\d{4}-\d{2}-\d{2}$/.test(offered) ? offered : MCP_REVISION;
      return {
        status: 200,
        body: JSON.stringify(rpcResult(id, {
          protocolVersion: negotiated,
          capabilities: { tools: {} },
          serverInfo: { name: 'makefun-forge', version: '1.0.0' },
        })),
      };
    }
    case 'ping': {
      return { status: 200, body: JSON.stringify(rpcResult(id, {})) };
    }
    case 'tools/list': {
      return { status: 200, body: JSON.stringify(rpcResult(id, { tools: MCP_TOOLS })) };
    }
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = isRecord(params.arguments) ? params.arguments : {};
      // A server prefix is allowed (github__create_issue): match as a suffix.
      const canonical = MCP_TOOLS.find((tool) => name === tool.name || name.toLowerCase().endsWith(`__${tool.name}`) || name.toLowerCase().endsWith(tool.name));
      if (!canonical) {
        return { status: 200, body: JSON.stringify(rpcError(id, -32601, `Method not found: ${name}`)) };
      }
      const result = callTool(store, canonical.name, args);
      return { status: 200, body: JSON.stringify(rpcResult(id, result)) };
    }
    default: {
      return { status: 200, body: JSON.stringify(rpcError(id, -32601, `Method not found: ${method}`)) };
    }
  }
}
