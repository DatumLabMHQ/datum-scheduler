export interface Env { GITHUB_TOKEN: string; SUILENDING_CRON_SECRET?: string; LIQUIDATOR_CRON_SECRET?: string }

type When = (m: number, h: number, d: number) => boolean;
// A job either dispatches a GitHub workflow or calls an app's cron route directly (the routes that
// Vercel Cron used to call). HTTP jobs send `Authorization: Bearer <secret>` and are skipped while
// their secret is unset, so a route never gets called without auth.
type DispatchJob = { repo: string; workflow: string; inputs?: Record<string, string>; when: When };
type HttpJob = { url: string; secret: 'SUILENDING_CRON_SECRET' | 'LIQUIDATOR_CRON_SECRET'; when: When };
type Job = DispatchJob | HttpJob;

const SUI = 'https://suilending.datumlabs.workers.dev';
const daily = (h: number, m: number): When => (mm, hh) => hh === h && mm === m;
// SuiLending's former vercel.json crons, same times (UTC).
const SUI_CRONS: Record<string, HttpJob> = Object.fromEntries(([
  ['navi/cron/collect-pools', 0, 0], ['navi/cron/index-liquidations', 0, 15], ['navi/cron/aggregate-pairs', 0, 45], ['navi/cron/aggregate-daily', 1, 5],
  ['suilend/cron/collect-pools', 0, 10], ['suilend/cron/index-liquidations', 0, 25], ['suilend/cron/aggregate-daily', 1, 15],
  ['scallop/cron/collect-pools', 0, 20], ['scallop/cron/index-liquidations', 0, 35], ['scallop/cron/aggregate-daily', 1, 25],
  ['alphalend/cron/collect-pools', 0, 30], ['alphalend/cron/index-liquidations', 0, 45], ['alphalend/cron/aggregate-daily', 1, 35],
  ['bucket/cron/collect-pools', 0, 40], ['bucket/cron/index-liquidations', 0, 55], ['bucket/cron/aggregate-daily', 1, 45],
  ['cron/backfill-defillama', 2, 0], ['cron/catch-up', 3, 0],
] as const).map(([path, h, m]) => [`sui:${path.replace('/cron/', '-').replace('cron/', '')}`, { url: `${SUI}/api/${path}`, secret: 'SUILENDING_CRON_SECRET', when: daily(h, m) }]));
SUI_CRONS['sui:navi-index-wallets'] = { url: `${SUI}/api/navi/cron/index-wallets`, secret: 'SUILENDING_CRON_SECRET', when: (m, h, d) => d === 0 && h === 0 && m === 30 };

// The worker ticks every 5 minutes (UTC). Each job says which ticks it is due on.
const PLAN: Record<string, Job> = {
  ...SUI_CRONS,
  // Liquidator Economy: incremental on-chain liquidation scan, hourly so each run stays small (Workers CPU limit).
  liquidatorScan: { url: 'https://liquidator-economy-dashboard.datumlabs.workers.dev/api/cron/scan-liquidations', secret: 'LIQUIDATOR_CRON_SECRET', when: (m) => m === 50 },
  hourly:      { repo: 'DatumLabMHQ/datum-models', workflow: 'hourly.yml',          when: (m) => m === 5 },
  tiering:     { repo: 'DatumLabMHQ/datum-models', workflow: 'nightly-tiering.yml', when: (m, h) => h === 3 && m === 40 },
  shadow:      { repo: 'DatumLabMHQ/SuiLending',   workflow: 'shadow-compare.yml',  when: (m, h) => h === 6 && m === 35 },
  ping:        { repo: 'DatumLabMHQ/setnel',       workflow: 'setnel-ping.yml',     when: () => true },
  // Setnel ops jobs, moved off GitHub's own cron on 2026-09-11 (it delivered 3 runs in 3 days for */15 schedules).
  rwa:         { repo: 'DatumLabMHQ/setnel',       workflow: 'setnel-rwa.yml',      when: (m) => m % 15 === 10 },
  analyze:     { repo: 'DatumLabMHQ/setnel',       workflow: 'setnel-analyze.yml',  when: (m) => m % 30 === 20 },
  resolve:     { repo: 'DatumLabMHQ/setnel',       workflow: 'setnel-resolve.yml',  when: (m) => m % 30 === 5 },
  crosscheck:  { repo: 'DatumLabMHQ/setnel',       workflow: 'setnel-crosscheck.yml', when: (m) => m === 40 },
  watchdog:    { repo: 'DatumLabMHQ/setnel',       workflow: 'setnel-watchdog.yml', when: (m) => m % 15 === 0 },
  platform:    { repo: 'DatumLabMHQ/setnel',       workflow: 'setnel-platform.yml', when: (m) => m % 15 === 0 },
  // Setnel rules (rules/*.yml): hourly rules at :25 after the platform's hourly build, daily rules at 07:10
  // after the 00:xx full sweep and its marts, weekly rules Mondays 07:15. The brief email at 07:25 goes out
  // only when something fired.
  rulesHourly: { repo: 'DatumLabMHQ/setnel',       workflow: 'setnel-content.yml',  inputs: { schedule: 'hourly', dry_run: 'false' }, when: (m) => m === 25 },
  rulesDaily:  { repo: 'DatumLabMHQ/setnel',       workflow: 'setnel-content.yml',  inputs: { schedule: 'daily', dry_run: 'false' },  when: (m, h) => h === 7 && m === 10 },
  rulesWeekly: { repo: 'DatumLabMHQ/setnel',       workflow: 'setnel-content.yml',  inputs: { schedule: 'weekly', dry_run: 'false' }, when: (m, h, d) => d === 1 && h === 7 && m === 15 },
  digest:      { repo: 'DatumLabMHQ/setnel',       workflow: 'setnel-content-digest.yml', inputs: { dry_run: 'false' }, when: (m, h) => h === 7 && m === 25 },
  escalations: { repo: 'DatumLabMHQ/setnel',       workflow: 'setnel-escalation-weekly.yml', inputs: { dry_run: 'false' }, when: (m, h, d) => d === 1 && h === 8 && m === 0 },
};
function due(at: Date): [string, Job][] {
  const m = at.getUTCMinutes(), h = at.getUTCHours(), d = at.getUTCDay();
  return Object.entries(PLAN).filter(([, j]) => j.when(m, h, d));
}

async function call(env: Env, j: HttpJob): Promise<string> {
  const secret = env[j.secret];
  if (!secret) return `${j.url} -> skipped (${j.secret} not set)`;
  const res = await fetch(j.url, { headers: { authorization: `Bearer ${secret}`, 'user-agent': 'datum-scheduler' } });
  return `${j.url} -> ${res.status}${res.ok ? '' : ' ' + (await res.text()).slice(0, 120)}`;
}

function run(env: Env, j: Job): Promise<string> {
  return 'url' in j ? call(env, j) : dispatch(env, j.repo, j.workflow, j.inputs);
}

async function dispatch(env: Env, repo: string, workflow: string, inputs?: Record<string, string>): Promise<string> {
  const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json', 'user-agent': 'datum-scheduler', 'x-github-api-version': '2022-11-28' },
    body: JSON.stringify({ ref: 'main', ...(inputs ? { inputs } : {}) }),
  });
  return `${repo}/${workflow} -> ${res.status}${res.ok ? '' : ' ' + (await res.text()).slice(0, 120)}`;
}

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const jobs = due(new Date(event.scheduledTime));
    ctx.waitUntil(Promise.all(jobs.map(([name, j]) => run(env, j).then((r) => console.log(name, r)))));
  },
  async fetch(req: Request, env: Env) {
    const url = new URL(req.url);
    if (url.pathname === '/run' && req.method === 'POST') {
      // Manual trigger: POST /run?job=hourly  (protected by the same token)
      if (req.headers.get('authorization') !== `Bearer ${env.GITHUB_TOKEN}`) return new Response('unauthorized', { status: 401 });
      const name = url.searchParams.get('job') ?? ''; const j = PLAN[name];
      if (!j) return Response.json({ error: 'unknown job', jobs: Object.keys(PLAN) }, { status: 404 });
      return Response.json({ job: name, result: await run(env, j) });
    }
    return Response.json({ name: 'datum-scheduler', tick: 'every 5 minutes UTC', jobs: Object.fromEntries(Object.entries(PLAN).map(([n, j]) => [n, 'url' in j ? j.url : `${j.repo}/${j.workflow}`])) });
  },
};
