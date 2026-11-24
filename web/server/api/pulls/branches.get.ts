// `GET /api/pulls/branches` → {branches, repos}: every branch on the projects' GitHub repos, with its issue and pull request
// and what to do with it (`remove`, `keep`, `look`, and why), to look at first (ORR-793). The owner's alone. Asked of GitHub
// at most once a minute (five without a GITHUB_TOKEN secret, and then there's no age or commit count). Only the repos of
// the projects the asker can see (ORR-1347), so none from another person's workspace.
export default defineEventHandler(async event => {
    await authorize(event, 'pulls.branches')
    const all = await useBranches().all()
    const repos = await reposSeen(event)
    if (!repos) return all
    return {...all, branches: all.branches.filter(b => repos.has(b.repo.toLowerCase())), repos: all.repos.filter(r => repos.has(r.repo.toLowerCase()))}
})
