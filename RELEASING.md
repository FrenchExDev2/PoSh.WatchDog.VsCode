# Release to Visual Studio Marketplace

The `.github/workflows/publish.yaml` workflow tests and packages each push to
`develop`, pull request and manual run. Pushing a stable version tag such as
`v0.2.0` additionally publishes the built VSIX to Visual Studio Marketplace and
attaches the VSIX and its SHA-256 checksum to the GitHub release for that tag.

The tag must exactly match `v` followed by the version in both `package.json` and
`package-lock.json`. Builds use the locked dependencies, Node 22 and PowerShell
Core 7.6 or later on a Windows runner. CI runs the automated unit and prepared
process-graph tests; installed Desktop integration remains the separate
qualification described in `QUALIFICATION.md`.

## Build and install locally

After `npm ci --ignore-scripts`, run `./scripts/Build-InstallVsix.ps1` in PowerShell Core 7.6+ to build and install the version from `package.json` into VS Code Insiders. Use `-Channel Stable` for Stable, `-Profile 'Development'` for a specific profile, or `-WhatIf` to preview. The script calls native tools directly with readable terminal output, checks the VSIX identity and SHA-256, stops on failed steps and confirms the installed version. No PowerShell module is required. Reload the target window after installation.

The local script does not run the test suite. Run the existing tests before preparing a release; Marketplace publication follows the workflow below.

## One-time Marketplace setup

Sign in to the [Marketplace publisher management page](https://marketplace.visualstudio.com/manage/publishers/FrenchExDev).
Under publisher **FrenchExDev**, open **Trusted Publishing** and create a policy:

| Field | Value |
| --- | --- |
| Provider | GitHub Actions |
| Repository owner | `FrenchExDev2` |
| Repository | `PoSh.WatchDog.PoSh` |
| Workflow | `publish.yaml` |
| Environment | `release` |

The repository owner is the GitHub organization. The extension publisher remains
`FrenchExDev`. The workflow filename includes its `.yaml` extension and is entered
without the `.github/workflows/` prefix.

Check that the policy is active and honor any activation deadline shown in the
Marketplace interface. The publishing job selects GitHub environment `release`,
which must match this policy exactly. The workflow requests
`id-token: write` and uses `vsce publish --oidc`; no Marketplace PAT or `VSCE_PAT`
repository secret is required. GitHub supplies its own `GITHUB_TOKEN` for creating
the GitHub release and uploading assets.

See the [official Trusted Publishing instructions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#publish-with-github-actions-and-trusted-publishing).

## Changelog before committing

Before every `git commit`, update `CHANGELOG.md` for all files included in that commit, as required by [AGENTS.md](AGENTS.md). Use the concrete release version rather than an Unreleased heading. Before tagging, verify that the latest changelog entry, `package.json`, both root versions in `package-lock.json` and the intended tag agree. Preserve historical entries and published tags.

## Publish a version

1. Update `package.json`, the root package entries in `package-lock.json`, and
   `CHANGELOG.md`; update the qualification evidence where behavior changed.
2. Commit and push all required source, tests, assets and the workflow. Confirm
   the **Test and publish** build succeeds on the intended commit.
3. Create and push tag `v0.2.0` on that commit, or the corresponding tag for a
   later version. The tag must include the workflow and all release source files.
4. Follow the workflow in [GitHub Actions](https://github.com/FrenchExDev2/PoSh.WatchDog.PoSh/actions/workflows/publish.yaml).
   A successful publish job uploads to Marketplace and creates the GitHub release
   with its assets. Reruns preserve matching assets and upload missing ones;
   conflicting existing assets fail explicitly. Marketplace validation and public availability can lag
   the accepted upload; check the extension page before announcing availability.

When the version has already been uploaded manually, `--skip-duplicate` preserves
the existing Marketplace version and allows the GitHub release assets to be
created. It does not replace an existing Marketplace package. Publish changed
runtime code under a new version and tag.

If publishing fails because the policy is missing or mismatched, fix its exact
owner/repository/workflow values and rerun the failed publish job. The SHA-256
check ensures it consumes the saved build artifact. If that artifact has expired,
rerun the entire workflow for the same immutable tag. A manual workflow run on a
branch only tests and packages; selecting an existing version tag also publishes.
