# Redeploy to Contentstack Launch with Bitbucket Pipelines using the Launch API

This repository shows how to redeploy a Next.js application to **Contentstack Launch** from
**Bitbucket Pipelines** using the [Launch Public API](https://www.contentstack.com/docs/developers/apis/launch-api)
file-upload flow.

After the project has been created and deployed once, every push to `main` runs
[`bitbucket-pipelines.yml`](bitbucket-pipelines.yml), which zips the source and redeploys it through
[`deploy-api.js`](deploy-api.js).

This is the Bitbucket counterpart to
[`launch-api-github-ci-example`](https://github.com/contentstack-launch-examples/launch-api-github-ci-example)
and [`launch-api-gitlab-ci-example`](https://github.com/contentstack-launch-examples/launch-api-gitlab-ci-example).

---

## Prerequisites

- A Launch **project and environment that already exist**. The first deployment must be done from
  the Launch UI (or the Launch APIs) — this pipeline redeploys an existing environment, it does not
  create one.
- A Contentstack app with the `launch:manage` (or `launch.projects:write`) scope. The Launch API
  supports [**M2M**, **OAuth**, or **Authtoken**](https://www.contentstack.com/docs/developers/apis/launch-api#authentication);
  this example uses **M2M** (client ID + client secret), which is the right fit for CI.

| Variable | Description |
|----------|-------------|
| `CONTENTSTACK_CLIENT_ID` | M2M / OAuth app ID |
| `CONTENTSTACK_CLIENT_SECRET` | M2M / OAuth app secret |
| `CONTENTSTACK_REGION` | `AWS_NA`, `AWS_EU`, `AWS_AU`, `AZURE_NA`, `AZURE_EU`, `GCP_NA`, `GCP_EU`, `DEV11` |
| `PROJECT_UID` | Launch project UID |
| `ENVIRONMENT_UID` | Launch environment UID to redeploy |

Optional: `LAUNCH_INCLUDE`, `WAIT_FOR_DEPLOYMENT`, `DEPLOYMENT_TIMEOUT_SECONDS` — see
[`.env.example`](.env.example).

To target a stack the region list does not cover, set `CONTENTSTACK_AUTH_HOST` and
`CONTENTSTACK_LAUNCH_API_HOST` (hostnames, or full URLs — they are trimmed) instead of
`CONTENTSTACK_REGION`. Explicit hosts always win over the region lookup.

---

## Quick start

1. Create the project and deploy it once from the **Launch UI** or the **Launch APIs**.
2. Copy this repository into your Bitbucket repository.
3. Create an M2M app with the `launch:manage` scope and note its client ID and secret.
4. **Repository settings → Pipelines → Settings → Enable Pipelines.**
5. **Repository settings → Repository variables** — add the five variables above. Tick **Secured**
   for `CONTENTSTACK_CLIENT_ID` and `CONTENTSTACK_CLIENT_SECRET` so they are masked in build logs.
   Bitbucket injects repository variables into the build as environment variables automatically, so
   there is nothing to map inside `bitbucket-pipelines.yml`.
6. Push to `main`. The pipeline redeploys the project and fails the build if the deployment fails.

**Run it locally:** `cp .env.example .env`, fill in the values, then `npm install && npm run deploy`.

---

## The pipeline

`bitbucket-pipelines.yml` defines one step, used by two pipelines:

- `pipelines.branches.main` — runs automatically on every push to `main`.
- `pipelines.custom.redeploy-to-launch` — run any branch on demand from
  **Pipelines → Run pipeline → Custom: redeploy-to-launch**.

The step installs only `archiver` and `form-data` (what `deploy-api.js` needs at runtime) and then
runs `node deploy-api.js`. There is no build step: Launch builds the uploaded source itself, using
the build command and output directory configured on the environment.

To redeploy from a branch other than `main`, add it under `pipelines.branches`.

### Per-environment deployments (optional)

If you have separate Launch environments for staging and production, use Bitbucket **Deployments**
instead of repository variables for `ENVIRONMENT_UID`: add `deployment: staging` /
`deployment: production` to the step and set `ENVIRONMENT_UID` per deployment environment under
**Repository settings → Deployments**. Deployment variables override repository variables, so
`deploy-api.js` needs no change.

---

## How the redeploy works

`deploy-api.js` performs the file-upload deployment flow end to end:

1. `POST https://<region-app-host>/apps-api/apps/token` — exchange the M2M client credentials for an
   access token (`grant_type=client_credentials`, `scopes=launch:manage`). The response also carries
   the `organization_uid` that later calls send as a header.
2. Zip the source files listed in `LAUNCH_INCLUDE` (see below).
3. `GET /projects/{project_uid}/environments/{environment_uid}/deployments/upload/signed_url` —
   returns `uploadUrl`, `uploadUid`, `method`, and either `fields` (S3/GCS-style multipart POST) or
   `headers` (Azure-style raw PUT).
4. Upload the zip to `uploadUrl`. The script handles both shapes, so it works on every Launch cloud
   provider.
5. `POST /projects/{project_uid}/environments/{environment_uid}/deployments` with `{ "uploadUid": … }`.
6. Poll `GET …/deployments/{deployment_uid}` every 5s until the status is terminal — `LIVE` /
   `DEPLOYED` exits 0, `FAILED` / `CANCELLED` / `SKIPPED` exits 1 so the Bitbucket build turns red.
   Set `WAIT_FOR_DEPLOYMENT=false` to queue and exit immediately instead.

> Launch also exposes a project-level `GET /projects/upload/signed_url`, which is intended for
> uploads made while *creating* a project. This example uses the deployment-level endpoint because
> it is scoped to the project and environment being deployed.

---

## What goes into the deployment zip

Launch builds the upload, so the zip contains **source, not build output**, and `node_modules`,
`.git`, and `.next` are always excluded.

Default contents: `package.json`, `package-lock.json`, `next.config.js`, `pages`, `public`, `app`,
`functions`.

Anything in that list which does not exist is skipped and logged. To change the list, set
`LAUNCH_INCLUDE` as a repository variable rather than editing the script:

```
LAUNCH_INCLUDE=package.json,package-lock.json,src,public,launch.json
```

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `could not fetch an access token (HTTP 401)` | Wrong client ID/secret, or the app has no `launch:manage` scope |
| `HTTP 403` on the signed-URL call | The app is not installed in the organization that owns the project |
| `HTTP 404` on the signed-URL or deployments call | Wrong `PROJECT_UID` / `ENVIRONMENT_UID`, or wrong `CONTENTSTACK_REGION` |
| `received an XML error body -- check CONTENTSTACK_REGION` | The region host does not match the project's region |
| `nothing to upload` | `LAUNCH_INCLUDE` does not match this repository's layout |
| Deployment finishes `FAILED` | A build failure in Launch — open the deployment in the Launch UI for logs |

---

## References

- [Contentstack Launch API](https://www.contentstack.com/docs/developers/apis/launch-api)
- [Launch API — Authentication](https://www.contentstack.com/docs/developers/apis/launch-api#authentication)
- [Launch API — File Upload](https://www.contentstack.com/docs/developers/apis/launch-api/file-upload)
- [Launch API — Deployments](https://www.contentstack.com/docs/developers/apis/launch-api/deployments)
- [Contentstack OAuth](https://www.contentstack.com/docs/developers/developer-hub/contentstack-oauth)
- [Bitbucket Pipelines — variables and secrets](https://support.atlassian.com/bitbucket-cloud/docs/variables-and-secrets/)
