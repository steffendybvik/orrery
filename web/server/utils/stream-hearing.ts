import type {Who} from './auth'

/** What one subscriber to `/api/events` hears (ORR-1195, ORR-1347): with login off, everything; anyone signed in, the
 * owner too, only the boards in `seen`, the projects of the tab's workspace they can see (undefined: every one, as for
 * the owner with no API to ask); and the owner alone what's the owner's own (the bell, secrets, the event log, the
 * settings). A chat is heard with its project. */
export function streamHearing(who: Who | undefined, seen: () => Set<string> | undefined) {
    const held = !!who
    return {
        /** Whether what they hear is held to `seen`, which has to be asked of the API for them. */
        held,
        /** Whether events about `project` reach them. */
        sees: (project: string | null | undefined) => {
            const projects = held ? seen() : undefined
            return !projects || (!!project && projects.has(project))
        },
        /** Whether what's the owner's own reaches them. */
        ownersToo: !who || who.owner,
    }
}

/** Refuses a signed-in member who isn't the owner (ORR-1195): what's the owner's own (their chats, a folder they're
 * connecting) or the installation's. The owner, their agents, and anyone with login off go on. */
export function ownersOwn(who: Who | undefined, what: string) {
    if (who && !who.owner) throw createError({statusCode: 403, statusMessage: 'Forbidden', message: `${what} is the owner's`})
}
