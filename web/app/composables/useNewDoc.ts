import type {DocKind} from '#shared/roadmap'

// The New doc dialog: open (for a project, and the kind of doc) or closed.
export function useNewDoc() {
    const target = useState<string | null>('new-doc', () => null)
    const kind = useState<DocKind>('new-doc-kind', () => 'markdown')
    const open = (project: string, as: DocKind = 'markdown') => {
        kind.value = as
        target.value = project
    }
    const close = () => target.value = null
    return {target, kind, open, close}
}
