// `POST /api/pulls/poll?repo=` → {pulls, needs, repos}: the owner's Poll now (ORR-534). Every repo (or `repo`, `you/shop`)
// is polled at once, whenever it was last, as the background poll would, and the answer is `GET /api/pulls`'s, fresh. A
// repo GitHub is holding (its rate limit, a refused token), or one read without a token in the last minute, isn't asked:
// its `held` says why. A second ask while one runs gets the same result.
export default defineEventHandler(async event => {
    await authorize(event, 'pulls.poll')
    const repo = getQuery(event).repo
    const held = await usePullPoll().pollNow(typeof repo === 'string' && repo ? repo : undefined)
    const all = await usePulls().all()
    return {...all, repos: all.repos.map(r => held.has(r.repo) ? {...r, held: held.get(r.repo)} : r)}
})
