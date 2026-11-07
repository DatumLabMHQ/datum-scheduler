# datum-scheduler

> Part of [Atlas](https://github.com/DatumLabMHQ/atlas), Datum Labs' internal data infrastructure. Start there for how the parts fit together.

The clock for Datum's scheduled jobs. GitHub's own cron delays workflow runs by hours under load, so this
Cloudflare Worker (Datum Labs account) dispatches each workflow through the GitHub API on time. The mapping
from cron to workflow lives in `src/index.ts`; the trigger in `cloudflare.config.ts` must cover the same ticks.

Secret `GITHUB_TOKEN`: a fine-grained token with Actions read and write on datum-models, SuiLending and setnel.

It also calls app cron routes directly (what Vercel Cron used to do): SuiLending's 19 daily data crons, the
Liquidator Economy hourly scan and the Lending Terminal daily sector snapshot, with `Authorization: Bearer <secret>`. Secrets `SUILENDING_CRON_SECRET`,
`LIQUIDATOR_CRON_SECRET` and `LENDING_CRON_SECRET` must equal each app's `CRON_SECRET`; a job is skipped while its secret is unset.
Deploy: `npx cf auth login` (Datum Labs account), then `npm run deploy` (`cf deploy`; config in `cloudflare.config.ts`).
