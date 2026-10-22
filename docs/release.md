# Releasing

A release is a tag that points at code whose manual macOS checklist has been run and recorded. The checklist and its record (`docs/qa`) stay on the maintainer's machine and are not committed, so the maintainer checks them locally before tagging; CI checks the versions, the changelog, the tests, and the package.

## Order

1. **Bump.** `bun run bump <version>` sets `package.json`, renames `## Unreleased` in `CHANGELOG.md` to `## <version> — <date>`, and regenerates `Workflow/info.plist`. Commit the result. Add a fresh `## Unreleased` heading above it afterwards.
2. **Candidate.** `bun run qa:candidate` builds the archive `dist/AI-Chat.alfredworkflow` and `dist/qa/probe.js`, and writes `docs/qa/v<version>.md` with every step `PENDING` (it never overwrites a record that already holds results).
3. **Manual run.** Copy the archive and the probe to a Mac with macOS 14 or later and Alfred 5.5 or later. Install the workflow and work through `docs/qa/checklist.md` by hand.
4. **Record and screenshots.** In `docs/qa/v<version>.md` set every step to `PASS` or `FAIL`, fill in the tester and date, and save the screenshots named in `docs/qa/screenshots.json` under `Workflow/images/about/` at the listed width. Run `bun run qa:verify <version>`; it checks every step, the screenshots, and that the record's content digest still matches the archive. Any code change after the manual run changes the digest, so run the checklist again. Commit the record and the screenshots.
5. **Check locally.** `bun run release:check v<version>` also checks the QA record, which is kept out of the repository, so CI cannot. Do not tag until it passes.
6. **Tag.** `git tag v<version>` on that commit and `git push origin v<version>`. The `Release` workflow runs the full checks and `bun run release:check --no-qa`, and only then publishes the `.alfredworkflow` asset with the changelog notes.

If the verify job fails, nothing is published. Fix the problem, delete the tag (`git push origin :refs/tags/v<version>` and `git tag -d v<version>`), and tag again.

## Alfred Gallery

Share the release on the Alfred forum first (see `docs/forum-post.md`). The Gallery asks that keywords be at least three characters, which `aichat`, `aimodels`, `aipresets`, and `aiimage` are. If reviewers object to a keyword, change its default in `scripts/workflow.ts`, run `bun run plist`, and update the README. The Gallery decides what it lists; nothing here depends on it.
