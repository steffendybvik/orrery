import type {IssueFilter} from '../../../../utils/store'

// `GET /api/projects/:project/issues` → every issue, sub-issues included, as a flat list. Filter with
// `?status=`, `?plan=`, `?priority=`, `?column=`, `?assignee=`, `?label=`, `?chunk=`,
// `?parent=` (`none` for top-level) and `?q=`.
export default defineEventHandler(event => {
    const query = getQuery(event)
    const filter = Object.fromEntries(['status', 'plan', 'priority', 'column', 'assignee', 'label', 'chunk', 'parent', 'q']
        .filter(key => typeof query[key] === 'string' && query[key])
        .map(key => [key, String(query[key])])) as IssueFilter
    return useStore().listIssues(param(event, 'project'), filter)
})
