// The Start session form: closed, or open with the project it starts on picked (or none yet).
export function useStartSession() {
    const target = useState<{project: string | null} | null>('start-session', () => null)
    const open = (project: string | null = null) => target.value = {project}
    const close = () => target.value = null
    return {target, open, close}
}
