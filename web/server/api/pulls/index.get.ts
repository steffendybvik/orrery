// `GET /api/pulls` → {pulls, needs, repos}: every open pull request on the projects' GitHub repos (ORR-491), each with
// the issue it names, conflicting, failing and behind first, oldest first; `needs` counts those. Each repo is listed
// once however many projects share it, and GitHub is asked at most once a minute (five without a GITHUB_TOKEN secret,
// and then only the lists: every PR not a draft is `checking`).
export default defineEventHandler(async () => usePulls().all())
