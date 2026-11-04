// The New milestone dialog: open (for a project) or closed.
export function useNewMilestone() {
    const target = useState<string | null>('new-milestone', () => null)
    const open = (project: string) => target.value = project
    const close = () => target.value = null
    return {target, open, close}
}
