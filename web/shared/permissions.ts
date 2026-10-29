// What a session may do in orrery, said once (ORR-459): the Sessions page's Permissions tab shows it, `GET
// /api/permissions` gives it to agents so they ask rather than try and be refused, and test/permissions.test.ts holds
// each row to what the server enforces (the store's checks, the owner-only routes, and the chat's and an untrusted
// session's guards), so the table can't drift from the code. A change to a rule changes its row here too.

/** How far a kind of session gets with something: `free` does it; `limited` does it within the row's note; `asks`
 * asks the owner, and it's done only on their Allow or Send; `owned` is saved but runs only once the owner makes it
 * theirs; `owner` is the owner's alone (a 403, or for a signal, no session hears it); `refused` is turned away. */
export type PermissionLevel = 'free' | 'limited' | 'asks' | 'owned' | 'owner' | 'refused'

export interface PermissionCell {
    level: PermissionLevel
    /** What the limit is, or what happens instead. */
    note?: string
}

/** The kinds of session, as the table's columns: one working in a repo, the owner's chat, and an untrusted schedule's. */
export const SESSION_KINDS = {
    session: 'A working session',
    chat: "The owner's chat",
    untrusted: 'An untrusted session',
} as const
export type SessionKind = keyof typeof SESSION_KINDS

export interface Permission {
    id: string
    area: string
    /** The thing, as the owner would say it. */
    action: string
    /** Why it's this way, in a line. */
    why: string
    /** The routes that do it (`METHOD /api/…`), which the guards are tested against. */
    routes: string[]
    session: PermissionCell
    chat: PermissionCell
    untrusted: PermissionCell
}

export const PERMISSION_LEVELS: Record<PermissionLevel, string> = {
    free: 'Free',
    limited: 'Free, within limits',
    asks: 'Asks you',
    owned: 'Runs once it’s yours',
    owner: 'Owner only',
    refused: 'Refused',
}

/** The anchor for an area's table on the Sessions page. */
export const areaId = (area: string) => `permissions-${area.toLowerCase().replace(/[^a-z]+/g, '-')}`

/** The areas in the table's order. */
export const permissionAreas = (): string[] => [...new Set(PERMISSIONS.map(p => p.area))]

const refused: PermissionCell = {level: 'refused'}

export const PERMISSIONS: Permission[] = [
    {
        id: 'issues.create', area: 'Roadmap', action: 'Make issues',
        why: 'Issues are material: what a session reads and weighs, not orders it must follow.',
        routes: ['POST /api/projects/:project/issues'],
        session: {level: 'free'},
        chat: {level: 'limited', note: 'Unstarted and unassigned'},
        untrusted: {level: 'limited', note: 'Only as a proposal labelled external'},
    },
    {
        id: 'issues.edit', area: 'Roadmap', action: 'Change an issue: its status, assignee, priority, chunk, release',
        why: 'Only one session works an issue at a time, and a proposal is work only once the owner approves it.',
        routes: ['PATCH /api/projects/:project/issues/:issue', 'PATCH /api/projects/:project/issues'],
        session: {level: 'limited', note: 'Not an issue another session is on, nor a proposal’s status, assignee or release before it’s approved'},
        chat: {level: 'limited', note: 'What it says and where it sits; its status and assignee only on your Allow, and not a proposal’s before it’s approved'},
        untrusted: refused,
    },
    {
        id: 'issues.delete', area: 'Roadmap', action: 'Remove issues, chunks, releases, docs or a project',
        why: 'Taking away what the owner made is their call.',
        routes: ['DELETE /api/projects/:project/issues/:issue', 'DELETE /api/projects/:project/chunks/:chunk', 'DELETE /api/projects/:project/docs/:doc', 'DELETE /api/projects/:project'],
        session: {level: 'limited', note: 'Not what the owner made'},
        chat: refused,
        untrusted: refused,
    },
    {
        id: 'proposals.decide', area: 'Roadmap', action: 'Approve, reject or ask for changes to a proposal',
        why: 'A proposal asks the owner; deciding it is their answer.',
        routes: ['POST /api/projects/:project/issues/:issue/decide'],
        session: {level: 'owner'},
        chat: refused,
        untrusted: refused,
    },
    {
        id: 'comments.write', area: 'Roadmap', action: 'Comment, and ask the owner a question',
        why: 'Comments are how a session tells the owner what it did, and asks.',
        routes: ['POST /api/projects/:project/issues/:issue/comments'],
        session: {level: 'limited', note: 'Not editing or deleting the owner’s comments'},
        chat: {level: 'free'},
        untrusted: {level: 'limited', note: 'Only on its own external proposals'},
    },
    {
        id: 'docs.write', area: 'Roadmap', action: 'Write and change docs, chunks and releases',
        why: 'Docs are material, kept current by the sessions that read them.',
        routes: ['PUT /api/projects/:project/docs/:doc', 'POST /api/projects/:project/chunks', 'POST /api/projects/:project/releases'],
        session: {level: 'free'},
        chat: refused,
        untrusted: refused,
    },
    {
        id: 'presets.write', area: 'What sessions are told', action: 'Write presets',
        why: 'A preset’s text is an order every later session gets in the owner’s voice: one session writing it would write the orders for the rest.',
        routes: ['POST /api/presets', 'PATCH /api/presets/:preset', 'POST /api/projects/:project/presets'],
        session: {level: 'owner'},
        chat: refused,
        untrusted: refused,
    },
    {
        id: 'prompts.write', area: 'What sessions are told', action: 'Change the focus prompts and standing instructions',
        why: 'The same: what sessions are told must do is the owner’s to write.',
        routes: ['PATCH /api/projects/:project', 'PATCH /api/settings'],
        session: {level: 'owner', note: 'A project’s other fields are free'},
        chat: refused,
        untrusted: refused,
    },
    {
        id: 'settings.write', area: 'This orrery', action: 'Change App settings and the statuses',
        why: 'They change how orrery runs for every project and session.',
        routes: ['PATCH /api/settings', 'POST /api/statuses', 'PATCH /api/statuses/:status'],
        session: {level: 'owner'},
        chat: {level: 'asks', note: 'One setting at a time, saved on your Allow'},
        untrusted: refused,
    },
    {
        id: 'signals.focus', area: 'Sessions', action: 'Ask sessions to focus on an issue or a chunk',
        why: 'Only the owner points sessions at work, so a session can’t set others going.',
        routes: ['POST /api/projects/:project/issues/:issue/focus', 'POST /api/projects/:project/chunks/:chunk/focus'],
        session: {level: 'owner', note: 'An agent’s focus is kept, and no session hears it'},
        chat: refused,
        untrusted: refused,
    },
    {
        id: 'sessions.message', area: 'Sessions', action: 'Message a session, or every session',
        why: 'A message reaches a session as the owner’s words.',
        routes: ['POST /api/projects/:project/sessions/:session/message', 'POST /api/sessions/message'],
        session: {level: 'owner'},
        chat: {level: 'asks', note: 'Sent as yours on your Send'},
        untrusted: refused,
    },
    {
        id: 'sessions.start', area: 'Sessions', action: 'Start, stop, watch or give more time to a session',
        why: 'Starting work, or ending it, is the owner’s.',
        routes: ['POST /api/projects/:project/launches', 'POST /api/projects/:project/launches/:launch/stop', 'POST /api/projects/:project/launches/:launch/extend', 'POST /api/projects/:project/launches/:launch/watch'],
        session: {level: 'owner'},
        chat: refused,
        untrusted: refused,
    },
    {
        id: 'sessions.allow', area: 'Sessions', action: 'Allow what a session asks permission for',
        why: 'A permission prompt is there for a person to answer, not another session.',
        routes: ['POST /api/projects/:project/launches/:launch/allow'],
        session: {level: 'owner'},
        chat: refused,
        untrusted: refused,
    },
    {
        id: 'schedules.issue', area: 'Schedules', action: 'Make a schedule that makes issues',
        why: 'An issue is material, so a schedule making them is too.',
        routes: ['POST /api/projects/:project/schedules'],
        session: {level: 'limited', note: 'It runs, but its asks reach no session'},
        chat: {level: 'asks', note: 'Saved as yours on your Allow'},
        untrusted: refused,
    },
    {
        id: 'schedules.message', area: 'Schedules', action: 'Make a schedule that messages sessions',
        why: 'Its message would reach sessions as the owner’s words.',
        routes: ['POST /api/projects/:project/schedules'],
        session: {level: 'owned', note: 'Saved, but each run is skipped until you read it and press Make it mine'},
        chat: {level: 'asks', note: 'Saved as yours on your Allow'},
        untrusted: refused,
    },
    {
        id: 'schedules.session', area: 'Schedules', action: 'Make a schedule that starts sessions',
        why: 'It starts work as the owner.',
        routes: ['POST /api/projects/:project/schedules'],
        session: {level: 'owner'},
        chat: {level: 'asks', note: 'Saved as yours on your Allow'},
        untrusted: refused,
    },
    {
        id: 'schedules.adopt', area: 'Schedules', action: 'Make an agent’s schedule the owner’s (Make it mine)',
        why: 'From then on its words reach sessions as the owner’s, so the owner reads them first: changing it, a pause or a rename, doesn’t make it theirs.',
        routes: ['POST /api/projects/:project/schedules/:schedule/adopt'],
        session: {level: 'owner'},
        chat: {level: 'owner'},
        untrusted: refused,
    },
    {
        id: 'schedules.owners', area: 'Schedules', action: 'Change, run or delete one of the owner’s schedules',
        why: 'What the owner set running stays as they set it.',
        routes: ['PATCH /api/projects/:project/schedules/:schedule', 'POST /api/projects/:project/schedules/:schedule/run', 'DELETE /api/projects/:project/schedules/:schedule'],
        session: {level: 'owner', note: 'A schedule an agent made stays free to change'},
        chat: {level: 'asks', note: 'A change or a pause, saved on your Allow; deleting stays on Schedules'},
        untrusted: refused,
    },
    {
        id: 'secrets.write', area: 'Secrets', action: 'Set, change or delete a secret',
        why: 'A secret’s value and where it may go are the owner’s to decide.',
        routes: ['PUT /api/secrets/:name', 'PATCH /api/secrets/:name', 'DELETE /api/secrets/:name'],
        session: {level: 'owner'},
        chat: refused,
        untrusted: refused,
    },
    {
        id: 'secrets.egress', area: 'Secrets', action: 'Call an outside service with a secret (egress)',
        why: 'orrery fills the secret in, so a session uses a key without ever seeing it.',
        routes: ['POST /api/egress'],
        session: {level: 'limited', note: 'Only to the hosts and projects the secret allows'},
        chat: refused,
        untrusted: refused,
    },
    {
        id: 'database.write', area: 'This orrery', action: 'Back up, restore or move the database',
        why: 'It decides where all of orrery’s data is.',
        routes: ['POST /api/backups', 'PUT /api/backups', 'POST /api/backups/restore', 'POST /api/database/move'],
        session: {level: 'owner', note: 'And only from this machine'},
        chat: refused,
        untrusted: refused,
    },
    {
        id: 'notices.clear', area: 'This orrery', action: 'Clear the bell, or forget a session',
        why: 'What waits on the owner goes when they say.',
        routes: ['POST /api/notices/clear', 'POST /api/projects/:project/sessions/:session/forget'],
        session: {level: 'owner'},
        chat: refused,
        untrusted: refused,
    },
]
