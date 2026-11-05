// The menu of things to do with a milestone, opened by right-clicking its card on the roadmap: where it opens, and on which milestone.
export function useMilestoneMenu() {
    const target = useState<{project: string, milestone: string, x: number, y: number} | null>('milestone-menu', () => null)
    function open(event: MouseEvent, project: string, milestone: string) {
        event.preventDefault()
        target.value = {project, milestone, x: event.clientX, y: event.clientY}
    }
    const close = () => target.value = null
    return {target, open, close}
}
