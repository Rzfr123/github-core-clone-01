// main.ts — the entry process: start the forge, hand its port to the trial
// environment, then stay alive until the environment says the trial is over.
//
// The trial environment (the "env") owns port 8080 and drives everything from
// there. This process only has to do three things, in order, and do them
// patiently: listen on a port the kernel picks, tell the env which port that
// is, and wait. Nothing here serves the contest itself — that is app.ts —
// and nothing here touches the store, the git layer, or any model.
//
//   1. Read MAKEFUN_ENV_URL. It is the env's origin (in a trial pod it looks
//      like http://store:8080). No URL, no env to talk to: print why and
//      leave with status 1 right away.
//   2. Start the app server on port 0 so the kernel hands us a free one.
//      Binding 8080 ourselves would collide with the env, so never do that.
//   3. POST {port} to $ENV/register. The env notes where the request came
//      from, appends our port, and calls us there from then on. A 200 means
//      we won the registration; a 409 means some other entry registered
//      first, which is also a settled answer — we just keep waiting like
//      everyone else. A 400/405 means our request itself broke the contract,
//      so there is no point retrying. Anything else (env still booting,
//      network hiccup, odd status) gets retried with a growing pause.
//   4. GET $ENV/done over and over until the body reads {"done": true}.
//      The env answers immediately — false while the suite is still
//      running — so this is a poll loop, never a held-open request. A poll
//      that errors, times out, or comes back without done:true simply means
//      "not yet": wait a little and ask again. This loop never gives up on
//      its own; only the env may end it.
//   5. Shut the server down and exit 0. The harness then stops the env,
//      which writes the export the scorer reads.
//
// Only Node's standard library is involved, via app.ts. No packages, no
// network calls beyond the two env endpoints above.

import { createApp } from './app.ts';

// How long a single register or done request may run before we drop it and
// try again. The env is local, so 30s is generous; the retry loop below is
// what actually absorbs a slow or still-starting env.
const REQUEST_TIMEOUT_MS = 30_000;
// Retry pauses start here and double each time, up to the cap.
const FIRST_PAUSE_MS = 250;
const LONGEST_PAUSE_MS = 5_000;
// The longest a Retry-After header may make us wait on one retry.
const LONGEST_RETRY_AFTER_MS = 30_000;

/** The env origin with any trailing slashes removed, or null when unusable. */
function envOrigin(): string | null {
  const raw = (process.env.MAKEFUN_ENV_URL ?? '').trim().replace(/\/+$/, '');
  if (raw === '') return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  // An env URL carrying credentials would leak them into every fetch's
  // Host/Authorization handling; refuse it rather than guess which part to keep.
  if (parsed.username !== '' || parsed.password !== '') return null;
  return raw;
}

const envUrl = envOrigin();
if (envUrl === null) {
  process.stderr.write(
    '[entry] MAKEFUN_ENV_URL is missing or not an http(s) URL: there is no env to register with\n',
  );
  process.exit(1);
}

/** Sleep `ms` milliseconds. */
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Pause after the `attempt`-th failed request: doubling from 250ms, capped. */
function backoffMs(attempt: number): number {
  const doubled = FIRST_PAUSE_MS * 2 ** Math.min(attempt, 8);
  return Math.min(LONGEST_PAUSE_MS, doubled);
}

/** True for register statuses that mean "our request is wrong": retrying is futile. */
function isContractError(status: number): boolean {
  return status === 400 || status === 405;
}

/**
 * How long a 429 response asks us to wait, in ms, from its Retry-After
 * header (seconds, or an HTTP date). Null when the header is absent or
 * unusable, so the caller falls back to exponential backoff.
 */
function retryAfterMs(response: Response): number | null {
  const header = response.headers.get('retry-after');
  if (header === null) return null;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(LONGEST_RETRY_AFTER_MS, seconds * 1_000);
  }
  const when = Date.parse(header.trim());
  if (Number.isFinite(when)) {
    return Math.min(LONGEST_RETRY_AFTER_MS, Math.max(0, when - Date.now()));
  }
  return null;
}

/**
 * Tell the env the port we bound. Returns once the env has accepted the
 * registration (200) or told us someone else already registered (409).
 * Throws only on a contract error; every other failure is retried forever.
 */
async function announce(port: number): Promise<void> {
  let attempt = 0;
  for (;;) {
    let response: Response | null = null;
    try {
      response = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      // Env not reachable yet (still starting, or the request timed out):
      // fall through to the pause below and try again.
    }
    if (response !== null) {
      if (response.status === 200 || response.status === 409) return;
      if (isContractError(response.status)) {
        throw new Error(`register rejected with HTTP ${response.status}: ${await response.text()}`);
      }
      // 429: the env is asking for a breather — honour its Retry-After when
      // it gives one instead of hammering it with exponential backoff.
      if (response.status === 429) {
        const wait = retryAfterMs(response);
        if (wait !== null) {
          await pause(wait);
          attempt += 1;
          continue;
        }
      }
      // Any other status (e.g. 500/503 while the env warms up): retry.
    }
    await pause(backoffMs(attempt));
    attempt += 1;
  }
}

/** Ask the env whether the trial is over, until it says yes. Never returns early. */
async function waitUntilDone(): Promise<void> {
  let attempt = 0;
  for (;;) {
    let finished = false;
    let rateLimitedWait: number | null = null;
    try {
      const response = await fetch(`${envUrl}/done`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.ok) {
        const body: unknown = await response.json();
        finished =
          typeof body === 'object' &&
          body !== null &&
          (body as { done?: unknown }).done === true;
      } else if (response.status === 429) {
        rateLimitedWait = retryAfterMs(response);
      }
    } catch {
      // No answer, a timeout, or a body that is not JSON: not done yet.
    }
    if (finished) return;
    if (rateLimitedWait !== null) await pause(rateLimitedWait);
    else await pause(backoffMs(attempt));
    attempt += 1;
  }
}

/** Start the app server on a kernel-chosen port and report which one it got. */
async function bindServer(): Promise<{ port: number; close: () => void }> {
  const server = createApp();
  // Keep one connection alive across a whole timed round: the suite drives the read
  // workload over a single keep-alive socket and the clone workload over fifty at
  // once, and Node's 5 s default would drop an idle socket mid-round if the suite
  // ever pauses between calls. 60 s matches the per-check timeouts and costs nothing.
  server.keepAliveTimeout = 60_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    server.close();
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  return { port: bound.port, close: () => server.close() };
}

/** The whole life of the process: bind, register, wait, shut down. */
async function run(): Promise<void> {
  const { port, close } = await bindServer();
  process.stdout.write(`[entry] listening on port ${port}\n`);

  await announce(port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitUntilDone();
  close();
  process.stdout.write('[entry] done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
