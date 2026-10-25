// An issue has a page of its own: `/p/:project/issues/:issue`. The last one opened stays marked
// in the lists, so coming back from it (Esc) lands where you were.
export function useIssueLink() {
    const router = useRouter()
    const last = useState<string | null>('last-issue', () => null)

    const pathOf = (project: string, issue: string) => `/p/${encodeURIComponent(project)}/issues/${encodeURIComponent(issue)}`

    function open(project: string, issue: string) {
        last.value = `${project}/${issue}`
        router.push(pathOf(project, issue))
    }

    const isLast = (project: string, issue: string) => last.value === `${project}/${issue}`
    return {open, pathOf, isLast, last}
}
