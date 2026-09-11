export interface Env { GITHUB_TOKEN: string }

type Job = { repo: string; workflow: string; inputs?: Record<string, string>; when: (m: number, h: number, d: number) => boolean };

// The worker ticks every 5 minutes (UTC). Each job says which ticks it is due on.
const PLAN: Record<string, Job> = {
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
};
function due(at: Date): [string, Job][] {
  const m = at.getUTCMinutes(), h = at.getUTCHours(), d = at.getUTCDay();
  return Object.entries(PLAN).filter(([, j]) => j.when(m, h, d));
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
    ctx.waitUntil(Promise.all(jobs.map(([name, j]) => dispatch(env, j.repo, j.workflow, j.inputs).then((r) => console.log(name, r)))));
  },
  async fetch(req: Request, env: Env) {
    const url = new URL(req.url);
    if (url.pathname === '/run' && req.method === 'POST') {
      // Manual trigger: POST /run?job=hourly  (protected by the same token)
      if (req.headers.get('authorization') !== `Bearer ${env.GITHUB_TOKEN}`) return new Response('unauthorized', { status: 401 });
      const name = url.searchParams.get('job') ?? ''; const j = PLAN[name];
      if (!j) return Response.json({ error: 'unknown job', jobs: Object.keys(PLAN) }, { status: 404 });
      return Response.json({ job: name, result: await dispatch(env, j.repo, j.workflow, j.inputs) });
    }
    return Response.json({ name: 'datum-scheduler', tick: 'every 5 minutes UTC', jobs: Object.fromEntries(Object.entries(PLAN).map(([n, j]) => [n, `${j.repo}/${j.workflow}`])) });
  },
};
