# Agent instructions

## Changelog before every commit

- Before every `git commit`, update `CHANGELOG.md` to describe all changes included in that commit. This is mandatory for code, tests, documentation, packaging and tooling changes.
- Use English and describe concrete behavior, validation and material limitations. Do not claim checks that have not run.
- Before staging, review the changelog against the intended staged files. Do not commit until the corresponding changelog entry is ready.
- Put new entries under the concrete version being prepared, matching the intended Git tag (for example, `0.5.4` for `v0.5.4`). Do not use an `Unreleased` heading. Preserve historical release entries.
- Before creating a release tag, make `package.json`, both root version entries in `package-lock.json`, the latest changelog version and the tag agree. Update `QUALIFICATION.md` with the validation performed and its limits.
- Do not move or replace an existing published tag. Create a new version for subsequent changes.

These instructions supplement the inherited workspace rules, including QuietCli execution and visible test monitoring.
