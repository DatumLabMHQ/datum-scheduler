export interface Env { GITHUB_TOKEN: string; SETNEL_CRON_SECRET: string }

type Job = {
  when: (m: number, h: number, d: number) => boolean;
  // Either dispatch a GitHub Actions workflow (runs on a GitHub runner, bills Actions minutes)...
  repo?: string;
  workflow?: string;
  inputs?: Record<string, string>;
  // ...or call HTTP endpoint(s) straight from the worker (no runner, no Actions minutes). Used for
  // jobs whose whole GitHub workflow was a single curl — dispatching one was pure minute waste.
  urls?: (env: Env) => string[];
};

// The worker ticks every 5 minutes (UTC). Each job says which ticks it is due on.
const PLAN: Record<string, Job> = {
  hourly:      { repo: 'DatumLabMHQ/datum-models', workflow: 'hourly.yml',          when: (m) => m === 5 },
  tiering:     { repo: 'DatumLabMHQ/datum-models', workflow: 'nightly-tiering.yml', when: (m, h) => h === 3 && m === 40 },
  shadow:      { repo: 'DatumLabMHQ/SuiLending',   workflow: 'shadow-compare.yml',  when: (m, h) => h === 6 && m === 35 },

  // ── Setnel curl-only jobs — called DIRECTLY from the worker (Stage 1). These used to dispatch a
  //    GitHub runner just to run one curl; hitting the URL here keeps them off Actions entirely. ──
  ping:        { when: () => true,           urls: () => ['https://aave-dashboard-datum.vercel.app/api/setnel/cron', 'https://sui-lending-datum.vercel.app/api/setnel/cron'] },
  resolve:     { when: (m) => m % 30 === 5,  urls: (e) => [`https://setnel.datumlab.xyz/api/v1/cron/resolve?key=${e.SETNEL_CRON_SECRET}`] },
  analyze:     { when: (m) => m % 30 === 20, urls: (e) => [`https://setnel.datumlab.xyz/api/v1/analyze?key=${e.SETNEL_CRON_SECRET}`] },
  crosscheck:  { when: (m) => m === 40,      urls: (e) => [`https://setnel.datumlab.xyz/api/v1/crosscheck?key=${e.SETNEL_CRON_SECRET}`] },

  // ── Setnel node jobs — still dispatched (real code + DB/secrets), frequency cut to save minutes
  //    (Stage 2). Was every 15 min for all three. ──
  // News feed: pull sources and correlate against our data (Setnel /api/v1/news), every 30 min at :15 and :45.
  news:        { when: (m) => m % 30 === 15, urls: (e) => [`https://setnel.datumlab.xyz/api/v1/news?key=${e.SETNEL_CRON_SECRET}`] },
  watchdog:    { repo: 'DatumLabMHQ/setnel', workflow: 'setnel-watchdog.yml', when: (m) => m % 30 === 0 },  // 15m -> 30m
  platform:    { repo: 'DatumLabMHQ/setnel', workflow: 'setnel-platform.yml', when: (m) => m % 60 === 0 },  // 15m -> 60m
  rwa:         { repo: 'DatumLabMHQ/setnel', workflow: 'setnel-rwa.yml',      when: (m) => m % 60 === 10 }, // 15m -> 60m

  // Setnel rules (rules/*.yml): hourly rules at :25 after the platform's hourly build, daily rules at 07:10
  // after the 00:xx full sweep and its marts, weekly rules Mondays 07:15. The brief email at 07:25 goes out
  // only when something fired.
  rulesHourly: { repo: 'DatumLabMHQ/setnel', workflow: 'setnel-content.yml',  inputs: { schedule: 'hourly', dry_run: 'false' }, when: (m) => m === 25 },
  rulesDaily:  { repo: 'DatumLabMHQ/setnel', workflow: 'setnel-content.yml',  inputs: { schedule: 'daily', dry_run: 'false' },  when: (m, h) => h === 7 && m === 10 },
  rulesWeekly: { repo: 'DatumLabMHQ/setnel', workflow: 'setnel-content.yml',  inputs: { schedule: 'weekly', dry_run: 'false' }, when: (m, h, d) => d === 1 && h === 7 && m === 15 },
  digest:      { repo: 'DatumLabMHQ/setnel', workflow: 'setnel-content-digest.yml', inputs: { dry_run: 'false' }, when: (m, h) => h === 7 && m === 25 },
  escalations: { repo: 'DatumLabMHQ/setnel', workflow: 'setnel-escalation-weekly.yml', inputs: { dry_run: 'false' }, when: (m, h, d) => d === 1 && h === 8 && m === 0 },
};

function due(at: Date): [string, Job][] {
  const m = at.getUTCMinutes(), h = at.getUTCHours(), d = at.getUTCDay();
  return Object.entries(PLAN).filter(([, j]) => j.when(m, h, d));
}

// Hide a ?key=<secret> query param before logging or echoing a URL.
function redact(url: string): string {
  return url.replace(/([?&]key=)[^&]+/i, '$1***');
}

async function dispatch(env: Env, repo: string, workflow: string, inputs?: Record<string, string>): Promise<string> {
  const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json', 'user-agent': 'datum-scheduler', 'x-github-api-version': '2022-11-28' },
    body: JSON.stringify({ ref: 'main', ...(inputs ? { inputs } : {}) }),
  });
  return `${repo}/${workflow} -> ${res.status}${res.ok ? '' : ' ' + (await res.text()).slice(0, 120)}`;
}

async function hit(url: string): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 120_000);
  try {
    const res = await fetch(url, { headers: { 'user-agent': 'datum-scheduler' }, signal: ctrl.signal });
    return `${redact(url)} -> ${res.status}${res.ok ? '' : ' ' + (await res.text().catch(() => '')).slice(0, 120)}`;
  } catch (e) {
    return `${redact(url)} -> ERR ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    clearTimeout(t);
  }
}

async function runJob(env: Env, name: string, j: Job): Promise<string> {
  if (j.urls) return `${name}: ${(await Promise.all(j.urls(env).map(hit))).join(' | ')}`;
  if (j.workflow) return `${name}: ${await dispatch(env, j.repo!, j.workflow, j.inputs)}`;
  return `${name}: no action`;
}

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const jobs = due(new Date(event.scheduledTime));
    ctx.waitUntil(Promise.all(jobs.map(([name, j]) => runJob(env, name, j).then((r) => console.log(r)))));
  },
  async fetch(req: Request, env: Env) {
    const url = new URL(req.url);
    if (url.pathname === '/run' && req.method === 'POST') {
      // Manual trigger: POST /run?job=ping  (protected by the same token)
      if (req.headers.get('authorization') !== `Bearer ${env.GITHUB_TOKEN}`) return new Response('unauthorized', { status: 401 });
      const name = url.searchParams.get('job') ?? ''; const j = PLAN[name];
      if (!j) return Response.json({ error: 'unknown job', jobs: Object.keys(PLAN) }, { status: 404 });
      return Response.json({ job: name, result: await runJob(env, name, j) });
    }
    const display = { ...env, SETNEL_CRON_SECRET: '***' } as Env;
    return Response.json({
      name: 'datum-scheduler',
      tick: 'every 5 minutes UTC',
      jobs: Object.fromEntries(Object.entries(PLAN).map(([n, j]) => [
        n,
        j.workflow ? `dispatch ${j.repo}/${j.workflow}` : `http ${(j.urls?.(display) ?? []).map(redact).join(', ')}`,
      ])),
    });
  },
};
