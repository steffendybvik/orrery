// The menu of things to do with an issue, opened by right-clicking its row or card: where it opens, and on which issue.
export function useIssueMenu() {
    const target = useState<{project: string, issue: string, x: number, y: number} | null>('issue-menu', () => null)
    function open(event: MouseEvent, project: string, issue: string) {
        event.preventDefault()
        target.value = {project, issue, x: event.clientX, y: event.clientY}
    }
    const close = () => target.value = null
    return {target, open, close}
}
