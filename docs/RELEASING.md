# Releasing

## One-time setup: publish without a long-lived token

npm supports **trusted publishing** — GitHub Actions authenticates over OIDC, so
there is no `NPM_TOKEN` to store or rotate.

**Linking your npm account to GitHub is not the same thing.** Account linking is
website sign-in; trusted publishing is a **per-package** authorisation of one
specific workflow. You need to configure it explicitly.

1. On npmjs.com, open the **`toolgz` package → Settings → Trusted Publisher**.
2. Add a GitHub Actions publisher:
   - Organisation / user: `dperussina`
   - Repository: `toolgz`
   - Workflow filename: `publish.yml`
   - Environment: `npm-publish`
3. In GitHub → Settings → Environments, create an environment named
   **`npm-publish`**. Add reviewers if you want a manual gate on releases.

That is all. No secret required.

### Current state of this repo

- [x] `npm-publish` environment created
- [x] `NPM_TOKEN` repository secret set
- [x] Workflow validated end to end via `dry_run` (npm 12.0.1 / Node 22.23.1 in CI)
- [ ] **A token type that works unattended** — see below; the current one does not
- [ ] Trusted Publisher configured on npmjs.com

> **`NPM_TOKEN` belongs in GitHub secrets, not in `.env`.** Nothing in this repo
> reads it from the environment — `.env` is only for benchmark provider keys. A
> publish credential sitting in a file that every bench script loads is
> avoidable exposure.

### Not every npm token can publish from CI

Observed on the first `v0.1.0` release attempt
([run 30173955410](https://github.com/dperussina/toolgz/actions/runs/30173955410)):

```
npm notice publish Signed provenance statement with source and build information
npm error code EOTP
npm error This operation requires a one-time password.
```

The token authenticated correctly. It failed because it **honours 2FA**, and a
GitHub runner has no way to supply a one-time password. Token type is what
decides this:

| Token | Unattended publish with 2FA on |
|---|---|
| Classic → **Read-only** | no (cannot publish) |
| Classic → **Publish** | ❌ prompts for an OTP → `EOTP` |
| Classic → **Automation** | ✅ bypasses 2FA — the CI-intended type |
| **Granular access** | ✅ when granted Read *and write* on the package |
| **Trusted publishing (OIDC)** | ✅ no token at all |

A classic token is `npm_` + 36 characters (40 total); granular tokens are longer.
So a 40-character token that hits `EOTP` is a classic **Publish** token, and the
fix is to reissue it as **Automation** — not to change the workflow.

Note that npm is actively restricting 2FA-bypassing tokens (the run log warns
about it), so treat any token as a stepping stone to trusted publishing.

### The first publish

Trusted publishing is configured under a package's own settings, so it cannot be
set up for a name that does not exist yet. The first release therefore needs a
token — after which the token can be deleted permanently:

1. npmjs.com → **Access Tokens → Generate New Token → Classic → Automation**
   (or a **Granular** token with *Read and write* on `toolgz`).
2. Replace the repo secret: `gh secret set NPM_TOKEN --repo dperussina/toolgz`.
3. Re-run the publish for the existing release — no new tag or release needed:
   `gh run rerun <run-id> --repo dperussina/toolgz`.
4. Configure the Trusted Publisher as above, then **delete the `NPM_TOKEN`
   secret**. Every later release authenticates over OIDC.

Publishing from a laptop instead (`npm publish`, entering the OTP interactively)
also works, but that build gets **no provenance attestation** — provenance
requires the OIDC token that only CI has. Doing the first publish through CI is
what keeps every published version attested.

#### A failed publish does not burn the version

`npm publish` is atomic: the `EOTP` failure above left `toolgz@0.1.0` unpublished
and reusable, so the fix is a re-run rather than a version bump. Verify with
`npm view toolgz version` before assuming otherwise.

One harmless artifact: provenance is signed *before* the registry call, so a
Sigstore transparency-log entry exists for a version that was never published. It
is an append-only public log of a build that really did happen; nothing needs
cleaning up.

## Cutting a release

```bash
npm version patch        # or minor / major — commits and tags
git push --follow-tags
```

Then create a GitHub Release for that tag. The workflow will:

- run the offline test suite and build
- **fail if the tag does not match `package.json`** (`v1.2.3` ↔ `1.2.3`)
- **fail if that version is already on npm**
- print the exact tarball contents
- publish with provenance

### Dry run first

Actions → **Publish to npm** → Run workflow, leaving `dry_run` checked. It does
everything except the publish, so you can inspect the tarball listing.

## Requirements the workflow handles for you

Trusted publishing needs **npm ≥ 11.5.1** and **Node ≥ 22.14.0**. Node 22 still
ships npm 10.x, so the workflow upgrades npm explicitly before publishing —
without that step, OIDC silently falls back to wanting a token.

## Before the first release

- [ ] `docs/RESULTS.md` figures match the committed data
      (`npx tsx bench/analyze-multi.ts`)
- [ ] `docs/BEFORE-AFTER.md` regenerated (`npx tsx docs/generate-examples.ts`)
- [ ] Charts regenerated if results changed (`npx tsx bench/charts.ts`)
- [ ] `npm test` green, `npx tsc --noEmit` clean
- [ ] `npm pack --dry-run` contains `dist/`, `README.md`, `LICENSE`, `NOTICE`
      and nothing else
