// `POST /api/pulls/poll?repo=&page=&limit=&q=` → {pulls, open, needs, repos}: the owner's Poll now (ORR-534). Every repo (or
// `repo`, `you/shop`) is polled at once, whenever it was last, as the background poll would, and the answer is `GET
// /api/pulls`'s, fresh, paged as it pages (ORR-615). A repo GitHub is holding (its rate limit, a refused token), or
// without a token one polled now in the last five minutes or read in the last minute, isn't asked: its `held` says why.
// A second ask for the same while one runs gets the same result; a repo no project is on, a 404.
// Signed in, "every repo" is those of the projects the asker can see, and the answer keeps to them as `GET /api/pulls`
// does (ORR-1371): another person's repo is a 404, as one no project is on, and isn't polled with their token.
export default defineEventHandler(async event => {
    await authorize(event, 'pulls.poll')
    const asked = getQuery(event).repo
    const repo = typeof asked === 'string' && asked ? asked : undefined
    const seen = await reposSeen(event)
    const known = [...(await usePulls().repos()).keys()]
    const mine = seen ? known.filter(r => seen.has(r.toLowerCase())) : known
    if (repo && !mine.includes(repo)) throw notFound(`No project's repo is ${repo} on GitHub`)
    const poll = usePullPoll()
    const held = new Map<string, string>()
    for (const only of repo ? [repo] : seen ? mine : [undefined]) {
        for (const [r, why] of await poll.pollNow(only)) held.set(r, why)
    }
    const all = await usePulls().all()
    const kept = seen ? {...all, pulls: all.pulls.filter(p => seen.has(p.repo.toLowerCase())), repos: all.repos.filter(r => seen.has(r.repo.toLowerCase()))} : all
    const page = pullsPage(kept, getQuery(event))
    return {...page, repos: page.repos.map(r => held.has(r.repo) ? {...r, held: held.get(r.repo)} : r)}
})
