# Releasing

You release from GitHub: open **Actions → Release → Run workflow**, pick `main`, and choose what to release. Nothing is published by an ordinary push.

## What the workflow does

1. **Checks.** Dependency audit (`bun audit`), typecheck, tests, build, the stale `Workflow/` check.
2. **Bump.** The `bump` input picks the version. `auto` (the default) releases the version in `package.json` as it is if it was never released, and otherwise counts the patch up; `patch`, `minor`, and `major` count up from the current version.
3. **Changelog.** `## Unreleased` in `CHANGELOG.md` becomes `## <version> — <date>`, with a fresh, empty `## Unreleased` above it. An empty `## Unreleased` stops the run, so write the notes there as you work.
4. **Package.** It builds `AI-Chat.alfredworkflow` and writes the release notes from that version's changelog section and adds the package's SHA-256 to them. The `.sha256` file is attached to the release too. The package is reproducible, so anyone can rebuild it from the tag and compare.
5. **Publish.** A second job takes the archive, the notes, and the bumped files from the first. It records build provenance for the archive, commits `package.json`, `CHANGELOG.md`, and `Workflow/info.plist` to `main` as `release: v<version>`, then creates the tag and the GitHub release with the archive and the notes. Check a downloaded archive with `gh attestation verify AI-Chat.alfredworkflow --repo Sillybit-io/silly-alfred-aichat`.

Steps 1 to 4 install the dependencies and run project code, so their job has a read-only token. Only the publish job can write to the repository, and it installs and runs nothing from the project.

If the build job fails, nothing changed. The publish job records the provenance first, so if it fails after that (at the commit or the release), the attestation stays on GitHub for an archive that was never released. It only states that this workflow built those bytes from the commit the run started on, so it is harmless; run the workflow again. If the run failed before the commit, `main` is unchanged and the same version is picked again. If it failed after the commit, run it with `auto`: the version is already bumped, so it only publishes. If `main` protects pushes from `github-actions[bot]`, allow the bot, or the commit step fails.

The attestation names the commit the run started on, not the `release: v<version>` commit: that commit only adds the version bump in `package.json`, `CHANGELOG.md`, and `Workflow/info.plist`, which the build job applied before it built the archive.

## Checking by hand (optional)

The manual macOS checklist and its record live in `docs/qa` on your machine and are not committed, so CI never checks them. When you want that gate, run it before you start the workflow:

1. `bun run qa:candidate` builds the archive and writes `docs/qa/v<version>.md` with every step `PENDING`.
2. Install the archive on a Mac with macOS 14+ and Alfred 5.5+ and work through `docs/qa/checklist.md`.
3. Set every step to `PASS` or `FAIL` in the record, fill in the tester and date, and run `bun run qa:verify <version>`.
4. `bun run release:check v<version>` also checks the record against the archive.

## Alfred Gallery

Share the release on the Alfred forum first (see `docs/forum-post.md`). The Gallery asks that keywords be at least three characters, which `aichat`, `aimodels`, `aipresets`, and `aiimage` are. If reviewers object to a keyword, change its default in `scripts/workflow.ts`, run `bun run plist`, and update the README. The Gallery decides what it lists; nothing here depends on it.
