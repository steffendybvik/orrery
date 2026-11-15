import type {Who} from './auth'

/** What one subscriber to `/api/events` hears (ORR-1195): the owner, or anyone with login off, everything; a member who
 * isn't the owner only the boards in `seen` (the projects they can see), and none of what's the owner's own (the bell,
 * chats, secrets, the event log, the settings). */
export function streamHearing(who: Who | undefined, seen: () => Set<string>) {
    const member = !!who && !who.owner
    return {
        member,
        /** Whether events about `project` reach them. */
        sees: (project: string | null | undefined) => !member || (!!project && seen().has(project)),
        /** Whether what's the owner's own reaches them. */
        ownersToo: !member,
    }
}

/** Refuses a signed-in member who isn't the owner (ORR-1195): what's the owner's own (their chats, a folder they're
 * connecting) or the installation's. The owner, their agents, and anyone with login off go on. */
export function ownersOwn(who: Who | undefined, what: string) {
    if (who && !who.owner) throw createError({statusCode: 403, statusMessage: 'Forbidden', message: `${what} is the owner's`})
}
