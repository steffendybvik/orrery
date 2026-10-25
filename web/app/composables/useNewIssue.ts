// The New issue dialog: open (for a project, and a chunk to start in) or closed.
export function useNewIssue() {
    const target = useState<{project: string, chunk?: string} | null>('new-issue', () => null)
    const open = (project: string, chunk?: string) => target.value = {project, chunk}
    const close = () => target.value = null
    return {target, open, close}
}
