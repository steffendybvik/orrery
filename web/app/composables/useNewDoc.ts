// The New doc dialog: open (for a project) or closed.
export function useNewDoc() {
    const target = useState<string | null>('new-doc', () => null)
    const open = (project: string) => target.value = project
    const close = () => target.value = null
    return {target, open, close}
}
