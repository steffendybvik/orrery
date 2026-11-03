// `DELETE /api/pulls/branches?repo=&name=` → 204: the owner removing a branch on GitHub. Read afresh first: one that no longer
// reads as `remove` is a 409, saying why, and so is a token that can't write, saying what would do it. Its name stays out of
// the log, which sessions can read.
export default defineEventHandler(async event => {
    await authorize(event, 'pulls.branches')
    const {repo, name} = getQuery(event)
    if (typeof repo !== 'string' || typeof name !== 'string' || !repo || !name) throw badRequest('Send ?repo=&name=')
    await useBranches().remove(repo, name)
    useEventLog().note({level: 'info', kind: 'branch.removed', message: `A branch on ${repo} was removed`, details: {repo}})
    setResponseStatus(event, 204)
    return null
})
