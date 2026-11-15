// main.ts — the entrypoint: bind an ephemeral port, register it with the env,
// then poll until the env says the trial is over and exit 0. The forge itself
// lives in app.ts; this file only owns the harness lifecycle.
//
//   1. MAKEFUN_ENV_URL names the env's origin. Without it there is nothing to
//      talk to, so the program exits 1 at once.
//   2. The server binds listen(0): the kernel picks a free port. Never 8080,
//      which the env owns.
//   3. POST $MAKEFUN_ENV_URL/register {"port": N}. The env records the address
//      the request came from plus N as the forge's base URL. A 409 means another
//      entry already registered; this process keeps waiting like any other.
//   4. GET $MAKEFUN_ENV_URL/done until the body is {"done": true}. The env
//      answers at once ({"done": false} while the suite runs), so this is a
//      poll, not a long-held request. A failed or slow poll is retried with a
//      short exponential backoff; the process never exits before done.
//   5. Close the server and exit 0.

import { createApp } from './app.ts';
import { Store } from './store.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_URL === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

/** How long one register or done request may take before it is abandoned and retried. */
const REQUEST_TIMEOUT_MS = 30_000;
/** The first wait between retries, and the longest. */
const RETRY_INITIAL_MS = 250;
const RETRY_MAX_MS = 2_000;
/** The wait between done polls while the suite is still running. */
const DONE_POLL_MS = 500;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The wait after `attempt` failed requests: exponential from RETRY_INITIAL_MS, capped. */
function retryDelay(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_INITIAL_MS * 2 ** Math.min(attempt, 8));
}

/**
 * POST the bound port until the env accepts it. 200 is the normal answer; 409
 * means a first register already won, which is not this process's to fix. 400
 * and 405 are contract errors and end the program; a network error or another
 * status is retried, since the env may still be starting.
 */
async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await sleep(retryDelay(attempt));
  }
}

/** GET /done until the env answers {"done": true}. */
async function waitForDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.status === 200) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // A failed poll is retried; the env may be restarting. The wait stays
      // short and flat: the env answers at once, so polling is cheap.
    }
    await sleep(DONE_POLL_MS);
  }
}

const store = new Store(TOKEN);
const server = createApp(store);

server.listen(0, () => {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    process.stderr.write('[entry] the server bound no port\n');
    process.exit(1);
  }
  const port = address.port;
  void (async () => {
    try {
      await register(port);
      await waitForDone();
    } catch (err) {
      process.stderr.write(`[entry] lifecycle failed: ${(err as Error).message}\n`);
      process.exit(1);
    }
    server.close(() => {
      process.exit(0);
    });
    // If the server does not close promptly (a lingering keep-alive), leave anyway.
    setTimeout(() => process.exit(0), 5_000).unref();
  })();
});

server.on('error', (err) => {
  process.stderr.write(`[entry] server error: ${err.message}\n`);
  process.exit(1);
});
