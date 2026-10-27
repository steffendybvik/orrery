# Releasing Orrery

Orrery ships as release candidates (`1.0.0-rc.7`) on the way to `1.0.0`. Each one gathers on a branch of
its own, goes to `main` in one pull request, and is tagged there, which publishes its image.

## While a release is open

- **Its branch** is `v<version>` (`v1.0.0-rc.7`), cut from `main` right after the last one shipped. The
  Orrery has a release with that version and branch, so issues can be set for it.
- **Every change is a pull request into that branch**, not `main`: a branch per issue
  (`feat/orr-288-short-description`), cut from the release branch, squashed when it lands. Check
  `git branch -r` for the current one before opening a pull request.
- **Pull requests leave `CHANGELOG.md` alone.** Two of them adding a line under the same heading always
  conflict. What a changelog line would say goes in the pull request's body instead.
- **Don't stack pull requests.** Base each on the release branch and say "merge #N first" when one needs
  another; a pull request built on another's branch conflicts once that one is squashed in.

## Shipping it

1. **Close out the release.** Its page in the Orrery lists its issues: each is done, or moves to the next
   release. Every pull request into the branch is merged, or moved (see below), and CI is green on it.
2. **Write the changelog** on the release branch: a `## <version> (<day>)` section at the top of
   `CHANGELOG.md`, one bold-led line per change a user would notice, from the merged pull requests and the
   release page's changelog draft. Commit it as `docs(repo): …`.
3. **Open the release pull request** from the release branch into `main`: titled
   `chore(repo): release v<version>`, with a paragraph on what the release brings, a line
   `Release notes: <orrery>/p/orrery/releases/<version>`, and a `> [!CAUTION]` block listing what's
   **Breaking** and what it **Affects**, when anything is. Out of draft, it runs the browser tests too.
4. **Squash it into `main`.**
5. **Tag `main`'s release commit** with an annotated tag whose message is the tag:
   `git tag -a v1.0.0-rc.7 -m v1.0.0-rc.7 && git push origin v1.0.0-rc.7`. CI runs on the tag, and only
   once it passes does `release.yml` publish the image (`ghcr.io/steffendybvik/orrery:1.0.0-rc.7`; a
   release candidate doesn't move `:latest`).
6. **Make the GitHub release** for the tag, titled with it, with the changelog section as its notes (each
   entry on one line, unwrapped), marked as a pre-release while it's a release candidate.
7. **Mark it shipped in the Orrery**: *Mark shipped today* on the release's page, and the changelog section
   as its notes.

## Starting the next one

1. Cut the next branch from the new `main`: `git switch -c v1.0.0-rc.8 origin/main && git push -u origin HEAD`.
2. Make its release in the Orrery, with that branch, and move over the issues left for it.
3. **A pull request still on the old branch** moves by cherry-picking its own commits onto a new branch off
   the new one, in a new pull request; close the old one. Merging the new release branch into it instead
   drags every commit of the last release into its history. To only change a pull request's base,
   `gh api -X PATCH repos/steffendybvik/orrery/pulls/<n> -f base=<branch>` (`gh pr edit --base` fails on
   this repo).
