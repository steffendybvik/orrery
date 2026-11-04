// `GET /api/pulls/:owner/:name/:number` → {repo, pull, issues}: pull request `number` on GitHub repo `owner/name`, as
// orrery keeps it (`issue_pulls`), merged and closed ones too, with every issue it's linked to, on any project, each with
// its title and status (ORR-880). 404 when orrery keeps no such PR: it names no issue, or hasn't been polled.
// Anyone but the owner gets the PR without what an outsider may have written (ORR-532).
export default defineEventHandler(async event => {
    const number = Number(param(event, 'number').replace(/^#/, ''))
    if (!Number.isInteger(number) || number < 1) throw badRequest('Give the pull request by its number, e.g. 788')
    const found = await usePulls().forPull(`${param(event, 'owner')}/${param(event, 'name')}`, number)
    const {done} = await pullsForAsker(event, {pulls: [], done: [found.pull]})
    return {...found, pull: done[0]}
})
