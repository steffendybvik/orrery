// `GET /api/pulls?page=&limit=` → {pulls, open, needs, repos}: every open pull request on the projects' GitHub repos
// (ORR-491), each with the issue it names, conflicting, failing and behind first, oldest first; `open` and `needs` count
// them all. With `page` (from 1) or `limit` (50, at most 200), only that page of them, and its `page` and `limit`
// (ORR-615). Each repo is listed once however many projects share it, with its own counts, and GitHub is asked at most
// once a minute (five without a GITHUB_TOKEN secret, and then only the lists: every PR not a draft is `checking`).
// Anyone but the owner gets each PR without what an outsider may have written (ORR-532).
export default defineEventHandler(async event => pullsForAsker(event, pullsPage(await usePulls().all(), getQuery(event))))
