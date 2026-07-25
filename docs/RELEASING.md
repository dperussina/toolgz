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

### The first publish

Trusted publishing is configured on a package that already exists, so the very
first release of a brand-new name generally needs a token:

1. Create a **granular access token** on npmjs.com scoped to publish `toolgz`.
2. Add it as the repo secret `NPM_TOKEN`.
3. Cut the first release (below). The workflow uses the token when present.
4. Configure the Trusted Publisher as above, then **delete the `NPM_TOKEN`
   secret** — subsequent releases authenticate over OIDC.

Alternatively publish `0.1.0` once from your machine (`npm publish`), then
configure the Trusted Publisher and never use a token in CI at all.

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
