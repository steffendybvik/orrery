import type {H3Event} from 'h3'

/** The project a path under `/api/projects/:project/…` names, decoded; none for any other path. */
function projectIn(path: string): string | undefined {
    const named = /^\/api\/projects\/([^/?#]+)/.exec(path)?.[1]
    if (!named) return undefined
    try {
        return decodeURIComponent(named)
    } catch {
        return undefined
    }
}

/** The workspace a session's calls say it works in (`Orrery-Workspace`, ORR-1109), only when they come from a session
 * (`Orrery-Session`). A page names one too, from its address, but isn't held to it, nor is the launcher, which serves
 * every workspace and names none. */
function sessionWorkspace(event: H3Event): string | undefined {
    if (!sessionHeader(event)) return undefined
    return getHeader(event, 'orrery-workspace')?.trim() || undefined
}

/** Refuses a session working in one workspace that reaches a project in another (ORR-1309), as the Rust API's rails do
 * for its routes (`workspace_check` in api/src/access/rails.rs): a 403 naming both. The owner's sessions are held too,
 * as a workspace is where a session works, not what it may see. A project that isn't here is its route's to say so. */
export async function heldToWorkspace(event: H3Event): Promise<void> {
    const held = sessionWorkspace(event)
    const project = held && projectIn(event.path)
    if (!held || !project) return
    const workspace = await useStore().projectWorkspace(project).catch(() => undefined)
    if (workspace && workspace !== held) {
        throw forbidden(`This session works in workspace ${held}, and ${project} is in ${workspace}: start a session there to work on it`)
    }
}
