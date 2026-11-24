import type {Who} from './auth'

/** What one subscriber to `/api/events` hears (ORR-1195, ORR-1347): with login off, everything; anyone signed in, the
 * owner too, only the boards in `seen`, the projects of the tab's workspace they can see (undefined: every one, as for
 * the owner with no API to ask); and the owner alone what's the owner's own (the bell, secrets, the event log, the
 * settings). A chat is heard with its project. `workspace` is the tab's (`default` when it names none): an event log
 * line is heard in its own workspace's tabs alone (ORR-1386). */
export function streamHearing(who: Who | undefined, seen: () => Set<string> | undefined, workspace = 'default') {
    const held = !!who
    const sees = (project: string | null | undefined) => {
        const projects = held ? seen() : undefined
        return !projects || (!!project && projects.has(project))
    }
    return {
        /** Whether what they hear is held to `seen`, which has to be asked of the API for them. */
        held,
        /** Whether events about `project` reach them. */
        sees,
        /** Whether what's the owner's own reaches them. */
        ownersToo: !who || who.owner,
        /** Whether a bell notice reaches them (ORR-1353): the owner's, with a project they see, as `GET /notices` keeps it. */
        hearsNotice: (notice: unknown) => (!who || who.owner) && sees((notice as {project?: string} | null)?.project),
        /** Whether an event log row reaches them (ORR-1353): the owner's, in the tab's workspace (ORR-1386: a member's
         * refusal is in the member's), with a project they see, as `/events/log` keeps it; a row naming no project (a
         * server error) is the installation's, so the owner's. A row from before lines named their workspace is `default`'s. */
        hearsLogged: (logged: unknown) => {
            const line = (logged as {event?: {project?: string | null, workspace?: string | null}} | null)?.event
            if ((line?.workspace || 'default') !== workspace) return false
            return (!who || who.owner) && (!line?.project || sees(line.project))
        },
    }
}

/** Refuses a signed-in member who isn't the owner (ORR-1195): what's the owner's own (their chats, a folder they're
 * connecting) or the installation's. The owner, their agents, and anyone with login off go on. */
export function ownersOwn(who: Who | undefined, what: string) {
    if (who && !who.owner) throw createError({statusCode: 403, statusMessage: 'Forbidden', message: `${what} is the owner's`})
}
