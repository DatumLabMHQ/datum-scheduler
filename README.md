# datum-scheduler

The clock for Datum's scheduled jobs. GitHub's own cron delays workflow runs by hours under load, so this
Cloudflare Worker (Datum Labs account) dispatches each workflow through the GitHub API on time. The mapping
from cron to workflow lives in `src/index.ts`; the trigger list in `wrangler.toml` must contain the same crons.

Secret `GITHUB_TOKEN`: a fine-grained token with Actions read and write on datum-models, SuiLending and setnel.
Deploy: `CLOUDFLARE_ACCOUNT_ID=c9bf3d8e875ffe933a9bf895695e0fd1 npx wrangler@latest deploy`.
