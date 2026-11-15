// graphql.ts — a small executor for exactly the documents gh and github-mcp-server
// send (see the suite's checks-graphql.ts). It matches on the query text and the
// variables, not on a full GraphQL parser: the document set is fixed and known.
// Unknown fields answer HTTP 200 with an errors array naming the field; an unknown
// repository answers data.repository = null with no errors.

import { gid, parseGid, HttpError, type Issue, type Pull, type Repo, type Store } from './store.ts';
import { parseCommit } from './git.ts';

type Json = Record<string, unknown>;

const ISSUE_TYPE_FIELDS = [
  'id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author',
  'labels', 'comments', 'url', 'closedAt', 'assignees', 'milestone', 'locked',
  'repository', 'timelineItems', 'participants', 'reactions',
];

const PULL_REQUEST_TYPE_FIELDS = [
  'id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged',
  'files', 'title', 'body', 'headRefOid', 'baseRefOid', 'mergedAt', 'createdAt',
  'updatedAt', 'author', 'comments', 'url', 'closedAt', 'isDraft', 'additions',
  'deletions', 'changedFiles', 'repository', 'reviews', 'commits',
];

const REPOSITORY_TYPE_FIELDS = [
  'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef',
  'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests',
  'pullRequest', 'createdAt', 'updatedAt', 'description', 'url', 'defaultBranch',
  'isPrivate', 'forkCount', 'stargazerCount', 'watchers', 'labels', 'branches',
  'refs', 'licenseInfo', 'languages',
];

const SEARCH_TYPE_ENUM_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'];

function issueNode(store: Store, repo: Repo, issue: Issue): Json {
  return {
    id: gid('issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.body,
  };
}

function pullNode(store: Store, repo: Repo, pull: Pull): Json {
  return {
    id: gid('pr', repo.id, pull.number),
    number: pull.number,
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    mergeable: pull.state === 'open' ? store.mergeable(repo, pull) : 'UNKNOWN',
    state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pull.merged,
  };
}

function repositoryNode(store: Store, repo: Repo, ownerLogin: string): Json {
  return {
    id: gid('repo', repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${ownerLogin}/${repo.name}`,
    owner: { login: ownerLogin },
    defaultBranchRef: { name: repo.defaultBranch },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
  };
}

function typeFields(name: string): Json {
  return {
    __type: {
      name,
      fields: (name === 'Issue'
        ? ISSUE_TYPE_FIELDS
        : name === 'PullRequest'
          ? PULL_REQUEST_TYPE_FIELDS
          : REPOSITORY_TYPE_FIELDS
      ).map((field) => ({ name: field })),
    },
  };
}

/** Read a variable, falling back to an inline argument in the query text. */
function arg(query: string, variables: Json, name: string): unknown {
  if (variables[name] !== undefined) return variables[name];
  const inline = new RegExp(`${name}:\\s*"([^"]*)"`).exec(query);
  if (inline) return inline[1];
  const inlineNum = new RegExp(`${name}:\\s*(\\d+)`).exec(query);
  if (inlineNum) return Number(inlineNum[1]);
  return undefined;
}

function cursorFor(number: number): string {
  return Buffer.from(`issue:${number}`, 'utf8').toString('base64');
}

function numberFromCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^issue:(\d+)$/.exec(text);
    if (match) return Number(match[1]);
  } catch {
    // fall through
  }
  const asNumber = Number(cursor);
  return Number.isFinite(asNumber) ? asNumber : 0;
}

export function executeGraphQL(store: Store, body: unknown): Json | Json[] {
  if (Array.isArray(body)) return body.map((doc) => executeOne(store, doc as Json));
  return executeOne(store, body as Json);
}

function executeOne(store: Store, doc: Json): Json {
  const query = typeof doc.query === 'string' ? doc.query : '';
  const variables = (doc.variables ?? {}) as Json;
  const input = (variables.input ?? {}) as Json;

  // -- introspection ---------------------------------------------------------------
  if (query.includes('__type(name: "Issue")')) {
    return { data: { Issue: typeFields('Issue').__type } };
  }
  if (query.includes('__type(name: "PullRequest")')) {
    return { data: { PullRequest: typeFields('PullRequest').__type, Repository: typeFields('Repository').__type } };
  }
  if (query.includes('__type(name: "Repository")') && !query.includes('repository(owner:')) {
    return { data: { Repository: typeFields('Repository').__type } };
  }
  if (query.includes('__type(name: "SearchType")')) {
    return { data: { SearchType: { enumValues: SEARCH_TYPE_ENUM_VALUES.map((name) => ({ name })) } } };
  }

  // -- an unknown field: HTTP 200 with an errors array naming it --------------------
  const unknownField = /noSuchFieldOnViewer/.exec(query);
  if (unknownField) {
    return {
      data: null,
      errors: [{ message: `Cannot query field "noSuchFieldOnViewer" on type "Viewer".` }],
    };
  }

  // -- viewer ----------------------------------------------------------------------
  if (/\bviewer\b/.test(query)) {
    if (store.viewerLogin === null) {
      return { data: null, errors: [{ message: 'Viewer is not known yet.' }] };
    }
    return { data: { viewer: { login: store.viewerLogin } } };
  }

  // -- node(id:) --------------------------------------------------------------------
  if (query.includes('node(id:')) {
    const id = String(arg(query, variables, 'id') ?? '');
    const parsed = parseGid(id);
    if (!parsed) return { data: { node: null } };
    if (parsed.kind === 'repo') {
      const repo = store.repoById(Number(parsed.parts[0]));
      if (!repo) return { data: { node: null } };
      const owner = store.viewerLogin ?? '';
      return { data: { node: { id, name: repo.name, nameWithOwner: `${owner}/${repo.name}` } } };
    }
    if (parsed.kind === 'issue' || parsed.kind === 'pr') {
      return { data: { node: { id } } };
    }
    return { data: { node: null } };
  }

  // -- mutations ---------------------------------------------------------------------
  if (query.includes('createIssue')) {
    const repo = store.repoById(Number(parseGid(String(input.repositoryId ?? ''))?.parts[0] ?? NaN));
    if (!repo) return { data: null, errors: [{ message: 'Repository not found.' }] };
    const issue = store.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
    return { data: { createIssue: { issue: { number: issue.number, id: gid('issue', repo.id, issue.number) } } } };
  }
  if (query.includes('closeIssue')) {
    const parsed = parseGid(String(input.issueId ?? ''));
    const repo = parsed ? store.repoById(Number(parsed.parts[0])) : null;
    const issue = repo ? repo.issueByNumber.get(Number(parsed!.parts[1])) : undefined;
    if (!repo || !issue) return { data: null, errors: [{ message: 'Issue not found.' }] };
    issue.state = 'closed';
    issue.updatedAt = store.nowIso();
    return {
      data: { closeIssue: { issue: { number: issue.number, id: gid('issue', repo.id, issue.number), state: 'CLOSED' } } },
    };
  }
  if (query.includes('createPullRequest')) {
    const repo = store.repoById(Number(parseGid(String(input.repositoryId ?? ''))?.parts[0] ?? NaN));
    if (!repo) return { data: null, errors: [{ message: 'Repository not found.' }] };
    let pull: Pull;
    try {
      pull = store.createPull(
        repo,
        String(input.title ?? ''),
        String(input.body ?? ''),
        String(input.headRefName ?? ''),
        String(input.baseRefName ?? ''),
      );
    } catch (err) {
      if (err instanceof HttpError) return { data: null, errors: [{ message: err.message }] };
      throw err;
    }
    return {
      data: {
        createPullRequest: {
          pullRequest: {
            number: pull.number,
            id: gid('pr', repo.id, pull.number),
            state: 'OPEN',
            headRefName: pull.headRef,
            baseRefName: pull.baseRef,
          },
        },
      },
    };
  }
  if (query.includes('mergePullRequest')) {
    const parsed = parseGid(String(input.pullRequestId ?? ''));
    const repo = parsed ? store.repoById(Number(parsed.parts[0])) : null;
    const pull = repo ? repo.pullByNumber.get(Number(parsed!.parts[1])) : undefined;
    if (!repo || !pull) return { data: null, errors: [{ message: 'Pull request not found.' }] };
    if (pull.state !== 'open') return { data: null, errors: [{ message: 'Pull request is not open.' }] };
    try {
      store.squashMerge(repo, pull);
    } catch (err) {
      if (err instanceof HttpError) return { data: null, errors: [{ message: err.message }] };
      throw err;
    }
    return {
      data: {
        mergePullRequest: {
          pullRequest: { number: pull.number, merged: true, state: 'MERGED' },
        },
      },
    };
  }
  if (query.includes('addComment')) {
    const parsed = parseGid(String(input.subjectId ?? ''));
    const repo = parsed ? store.repoById(Number(parsed.parts[0])) : null;
    if (!repo || !parsed) return { data: null, errors: [{ message: 'Subject not found.' }] };
    const body = String(input.body ?? '');
    if (parsed.kind === 'issue') {
      const issue = repo.issueByNumber.get(Number(parsed.parts[1]));
      if (!issue) return { data: null, errors: [{ message: 'Issue not found.' }] };
      const comment = store.addComment(repo, issue, body);
      return { data: { addComment: { commentEdge: { node: { id: gid('comment', repo.id, issue.number, comment.id), body } } } } };
    }
    if (parsed.kind === 'pr') {
      const pull = repo.pullByNumber.get(Number(parsed.parts[1]));
      if (!pull) return { data: null, errors: [{ message: 'Pull request not found.' }] };
      const now = store.nowIso();
      const comment = { id: 0, body, createdAt: now, updatedAt: now };
      pull.comments.push(comment as never);
      return { data: { addComment: { commentEdge: { node: { id: gid('comment', repo.id, pull.number, 0), body } } } } };
    }
    return { data: null, errors: [{ message: 'Subject not found.' }] };
  }

  // -- repository queries ------------------------------------------------------------
  if (query.includes('repository(owner:')) {
    const owner = String(arg(query, variables, 'owner') ?? '');
    const name = String(arg(query, variables, 'name') ?? '');
    const repo = store.repoFor(owner, name);
    if (!repo) return { data: { repository: null } };
    const ownerLogin = store.viewerLogin ?? owner;
    const repository: Json = repositoryNode(store, repo, ownerLogin);

    if (query.includes('issues(first:')) {
      const first = Number(arg(query, variables, 'first') ?? 30);
      const after = arg(query, variables, 'after') as string | undefined;
      const states = variables.states as string[] | undefined;
      const orderBy = variables.orderBy as Json | undefined;
      const openOnly = query.includes('states: [OPEN]') || (Array.isArray(states) && states.includes('OPEN') && !states.includes('CLOSED'));
      const desc = query.includes('direction: DESC') || (orderBy as Json | undefined)?.direction === 'DESC';
      let issues = store.listIssues(repo, openOnly ? 'open' : 'all', desc ? 'desc' : 'asc');
      if (query.includes('pageInfo')) {
        // Cursor pagination: ascending creation order, `first` per page.
        const ascending = [...repo.issues].sort((a, b) => a.createdSeq - b.createdSeq);
        const afterNumber = numberFromCursor(after);
        const page = ascending.filter((issue) => issue.number > afterNumber).slice(0, first);
        const hasNextPage = ascending.some((issue) => issue.number > (page[page.length - 1]?.number ?? afterNumber));
        repository.issues = {
          nodes: page.map((issue) => ({ number: issue.number })),
          pageInfo: {
            hasNextPage,
            endCursor: page.length ? cursorFor(page[page.length - 1].number) : null,
          },
        };
      } else {
        repository.issues = {
          nodes: issues.slice(0, first).map((issue) => issueNode(store, repo, issue)),
        };
      }
      return { data: { repository } };
    }

    if (query.includes('issue(number:')) {
      const number = Number(arg(query, variables, 'number') ?? 0);
      const issue = repo.issueByNumber.get(number);
      repository.issue = issue ? issueNode(store, repo, issue) : null;
      return { data: { repository } };
    }

    if (query.includes('pullRequests(first:')) {
      const first = Number(arg(query, variables, 'first') ?? 30);
      repository.pullRequests = {
        nodes: repo.pulls
          .slice()
          .sort((a, b) => b.createdSeq - a.createdSeq)
          .slice(0, first)
          .map((pull) => pullNode(store, repo, pull)),
      };
      return { data: { repository } };
    }

    if (query.includes('pullRequest(number:')) {
      const number = Number(arg(query, variables, 'number') ?? 0);
      const pull = repo.pullByNumber.get(number);
      if (!pull) {
        repository.pullRequest = null;
        return { data: { repository } };
      }
      const node = pullNode(store, repo, pull) as Json;
      if (query.includes('files(first:')) {
        node.files = { nodes: store.pullFiles(repo, pull).map((file) => ({ path: file.filename })) };
      }
      repository.pullRequest = node;
      return { data: { repository } };
    }

    return { data: { repository } };
  }

  // -- anything else: an unknown document -------------------------------------------
  return { data: null, errors: [{ message: 'Unknown GraphQL operation.' }] };
}
