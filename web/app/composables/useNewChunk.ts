// The New chunk dialog: open (for a project) or closed.
export function useNewChunk() {
    const target = useState<string | null>('new-chunk', () => null)
    const open = (project: string) => target.value = project
    const close = () => target.value = null
    return {target, open, close}
}
