// The menu of things to do with a chunk, opened by right-clicking its card on the roadmap: where it opens, and on which chunk.
export function useChunkMenu() {
    const target = useState<{project: string, chunk: string, x: number, y: number} | null>('chunk-menu', () => null)
    function open(event: MouseEvent, project: string, chunk: string) {
        event.preventDefault()
        target.value = {project, chunk, x: event.clientX, y: event.clientY}
    }
    const close = () => target.value = null
    return {target, open, close}
}
