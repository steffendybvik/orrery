// The New issue dialog: open (for a project, and a milestone to start in) or closed.
export function useNewIssue() {
    const target = useState<{project: string, milestone?: string} | null>('new-issue', () => null)
    const open = (project: string, milestone?: string) => target.value = {project, milestone}
    const close = () => target.value = null
    return {target, open, close}
}
