// `POST /api/pulls/poll?repo=` → {pulls, needs, repos}: the owner's Poll now (ORR-534). Every repo (or `repo`, `you/shop`)
// is polled at once, whenever it was last, as the background poll would, and the answer is `GET /api/pulls`'s, fresh. A
// repo GitHub is holding (its rate limit, a refused token), or without a token one polled now in the last five minutes or
// read in the last minute, isn't asked: its `held` says why. A second ask for the same while one runs gets the same result; a repo no project is on, a 404.
export default defineEventHandler(async event => {
    await authorize(event, 'pulls.poll')
    const asked = getQuery(event).repo
    const repo = typeof asked === 'string' && asked ? asked : undefined
    if (repo && !(await usePulls().repos()).has(repo)) throw notFound(`No project's repo is ${repo} on GitHub`)
    const held = await usePullPoll().pollNow(repo)
    const all = await usePulls().all()
    return {...all, repos: all.repos.map(r => held.has(r.repo) ? {...r, held: held.get(r.repo)} : r)}
})
