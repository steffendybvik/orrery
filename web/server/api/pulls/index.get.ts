// `GET /api/pulls?page=&limit=&q=` → {pulls, open, needs, repos}: every open pull request on the projects' GitHub repos
// (ORR-491), each with the issue it names, conflicting, failing and behind first, oldest first; `open` and `needs` count
// them all. With `page` (from 1) or `limit` (50, at most 200), only that page of them, and its `page` and `limit`
// (ORR-615). Each repo is listed once however many projects share it, with its own counts, and GitHub is asked at most
// once a minute (five without a GITHUB_TOKEN secret, and then only the lists: every PR not a draft is `checking`).
// Anyone but the owner gets each PR without what an outsider may have written (ORR-532). `q` keeps only those with
// every word of it, in what the asker is sent, and `matched` counts them (ORR-941).
// A member who isn't the owner gets the pull requests on the repos of the projects they can see alone (ORR-1195).
export default defineEventHandler(async event => {
    const all = await usePulls().all()
    const who = event.context?.who as Who | undefined
    if (!who || who.owner) return pullsPage(await pullsForAsker(event, all), getQuery(event))
    const repos = new Set((await readAsAsker<{repo?: string | null}[]>(event, '/api/projects?every=1') ?? []).flatMap(p => p.repo ? [p.repo.toLowerCase()] : []))
    const mine = {...all, pulls: all.pulls.filter(p => repos.has(p.repo.toLowerCase())), repos: all.repos.filter(r => repos.has(r.repo.toLowerCase()))}
    return pullsPage(await pullsForAsker(event, mine), getQuery(event))
})
