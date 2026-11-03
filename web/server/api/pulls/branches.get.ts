// `GET /api/pulls/branches` → {branches, repos}: every branch on the projects' GitHub repos, with its issue and pull request
// and what to do with it (`remove`, `keep`, `look`, and why), to look at first (ORR-793). The owner's alone. Asked of GitHub
// at most once a minute (five without a GITHUB_TOKEN secret, and then there's no age or commit count).
export default defineEventHandler(async event => {
    await authorize(event, 'pulls.branches')
    return await useBranches().all()
})
