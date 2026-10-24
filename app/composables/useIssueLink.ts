// The issue panel follows the URL: `?issue=MOT-5` on a project's page, plus `&project=` elsewhere
// (Now spans projects). Opening an issue keeps the rest of the query, so the view stays.
export function useIssueLink() {
    const route = useRoute()
    const router = useRouter()

    const projectId = computed(() => (route.params.project as string | undefined) ?? (route.query.project as string | undefined))
    const issueId = computed(() => route.query.issue as string | undefined)

    function open(project: string, issue: string) {
        const onProject = route.params.project === project
        router.push({query: {...route.query, issue, project: onProject ? undefined : project}})
    }

    function close() {
        router.push({query: {...route.query, issue: undefined, project: undefined}})
    }

    const isOpen = (project: string, issue: string) => issueId.value === issue && projectId.value === project
    return {projectId, issueId, open, close, isOpen}
}
