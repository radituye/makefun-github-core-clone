# makefun-github-core-clone

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/radituye/makefun-github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/radituye/makefun-github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in one Node process: git smart HTTP (upload-pack protocol v2, receive-pack v0), the REST v3 API, GraphQL v4, and a Model Context Protocol endpoint, all over an in-memory store. No git binary, no database, no network beyond the suite that grades it — just Node 22's standard library.

## Run it

```sh
node --experimental-strip-types main.ts
```

The entry binds an ephemeral port, registers it with the trial env at `$MAKEFUN_ENV_URL`, and exits when the env reports done. The shop token comes from `$MAKEFUN_SHOP_TOKEN`.

## What it serves

- **Git smart HTTP** at `/{owner}/{repo}.git`: protocol v2 `ls-refs` and `fetch` (shallow, deepen, incremental by haves), v0 fetch, and v0 receive-pack with fast-forward enforcement and a sideband report-status answer. Packs are written without deltas and read with OFS/REF delta resolution.
- **REST v3** under `/api/v3`: repositories, branches, commits, refs, contents (create/update/delete with sha checks), labels, issues, comments, pull requests with file diffs and squash merges (real 3-way mergeability, 405 on conflict).
- **GraphQL v4** at `/api/graphql`: the documents `gh` and `github-mcp-server` send — viewer, repository fields, issue/PR introspection, issue lists with cursor pagination, and the create/close/merge/comment mutations.
- **MCP** at `/mcp`: JSON-RPC 2.0 Streamable HTTP, revision 2026-07-28 via `server/discover` (legacy `initialize` also works), with six tools — `create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request` — acting on the same store as REST.

## Layout

- `main.ts` — the entrypoint and harness lifecycle (bind, register, poll done, exit 0)
- `app.ts` — the HTTP server and REST v3 router
- `git-http.ts` — git smart-HTTP handlers and fetch planning
- `git.ts` — the object layer: SHA-1 objects, trees, commits, tags, packfiles, pkt-lines
- `store.ts` — the in-memory store: repos, refs, issues, pull requests, contents, merges
- `graphql.ts` — the GraphQL executor for the suite's known documents
- `mcp.ts` — the MCP endpoint and its six tools

---

<sub>Entered on [make.fun](https://make.fun/?ref=8ak5ahcj&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
