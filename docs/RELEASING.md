# Releasing flakefinder

## Prepare the release PR

1. Choose the version and start a release branch from current `main`. Fetch
   remote tags and confirm the intended tag is available. Use `X.Y.Z` or
   `X.Y.Z-prerelease`. npm normalizes build metadata, so release versions use
   the same literal version in Git, the manifests, and the installed CLI.
2. Add a `## X.Y.Z` section to `CHANGELOG.md` with the reviewed release notes.
   Commit the notes on the release branch so preparation starts with a clean
   index and working tree.
3. Use Node 24, install dependencies with `npm ci`, and make Go and Python
   with pytest available on `PATH`. Replace `X.Y.Z` with the chosen version.

   ```sh
   node scripts/release.mjs X.Y.Z
   ```

   The script checks the changelog and working tree before updating
   `package.json`, both root version fields in `package-lock.json`, and
   `FLAKEFINDER_VERSION` in `src/types.ts`. It runs the source checks, builds
   the bundles, and runs the performance smoke and strict fixture E2E tests.
   The resulting edits are unstaged. If a check fails after preparation starts,
   inspect the local diff and address the failure before continuing.
4. Review the version and bundle diff and stage the intended release files.

   ```sh
   git add -- package.json package-lock.json src/types.ts dist/action/index.cjs dist/cli.js.map
   git add --chmod=+x -- dist/cli.js
   git diff --cached --stat
   ```

   Commit the preparation, open the release PR, and merge it after review and
   a successful `Release parity` check.

## Tag and publish

Set up the repository's `NPM_TOKEN` Actions secret with an npm token that can
publish `flakefinder`. Confirm the credential and package permissions before
pushing the tag. The workflow requires the secret and publishes with npm
provenance. The release also needs permission to create a GitHub Release.

Fetch the latest default branch and tags with `git fetch origin --tags`.
In a clean checkout of the reviewed release commit from `origin/main`, verify
the commit SHA and confirm the selected tag is available. Replace `X.Y.Z`
in the commands below with the reviewed release version.

```sh
node scripts/release.mjs --validate-tag vX.Y.Z
git tag vX.Y.Z
git push origin refs/tags/vX.Y.Z:refs/tags/vX.Y.Z
```

Run each command after its predecessor succeeds. The validation command
compares the tag string to all four version fields and prints the exact
changelog section. The tag push starts the `release` workflow. It requires the
tagged commit to be on the default branch history and runs the same checks as
PR CI. It computes a SHA-256 when it packs the CLI. Every runtime job verifies
and installs that artifact on Windows, Ubuntu, or macOS with Node 18 or 24. The publish
job verifies the digest again and passes the tested tarball to npm. Stable
releases use the `latest` npm dist-tag. Prereleases use `next` and are marked as
prereleases on GitHub.

After the workflow succeeds, confirm the GitHub Release notes and npm version.
If the workflow fails, inspect the failed job before re-running it. A re-run
can resume an npm publication if the existing version has the same SHA-512
integrity and a provenance attestation. A mismatch stops the workflow.
The GitHub Release step also accepts an existing published release of the
same kind for the tag.

## Require the CI check on main

A repository administrator can add `Release parity` as a required status
check in a GitHub ruleset or branch protection rule for `main`. Select the check
after it has run on a PR so it is available in GitHub's selector. The final
check covers all of the upstream jobs and its name stays the same across
matrix changes.
