import type {IssueFilter} from '../../../../utils/store'

// `GET /api/projects/:project/issues` → every issue, sub-issues included, as a flat list. Filter with
// `?status=`, `?priority=`, `?column=`, `?assignee=`, `?label=`, `?external=` (a team task), `?github_issue=` (`523` or `owner/name#523`), `?chunk=`,
// `?release=` (`none` for issues set for none), `?parent=` (`none` for top-level), `?proposal=` (`none`
// for committed work), `?blocked=` (`true` or `false`: waiting on an issue not done yet, ORR-601) and `?q=`.
export default defineEventHandler(async event => {
    const query = getQuery(event)
    const filter = Object.fromEntries(['status', 'priority', 'column', 'assignee', 'label', 'external', 'github_issue', 'chunk', 'release', 'parent', 'proposal', 'blocked', 'q']
        .filter(key => typeof query[key] === 'string' && query[key])
        .map(key => [key, String(query[key])])) as IssueFilter
    return await useStore().listIssues(param(event, 'project'), filter)
})
