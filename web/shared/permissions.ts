// What a session may do in orrery, said once (ORR-459): the Sessions page's Permissions tab shows it, `GET
// /api/permissions` gives it to agents so they ask rather than try and be refused, and the server enforces it (ORR-512):
// the owner-only routes ask `authorize()` for their row, and the chat's and an untrusted session's guards are built from
// their columns (`guard()`). test/permissions.test.ts holds the rest of each row (the store's checks) to the code, so the
// table can't drift from it. A change to a rule changes its row here too.

/** How far a kind of session gets with something: `free` does it; `limited` does it within the row's note; `asks`
 * asks the owner, and it's done only on their Allow or Send; `owned` is saved but runs only once the owner makes it
 * theirs; `owner` is the owner's alone (a 403, or for a signal, no session hears it); `refused` is turned away. */
export type PermissionLevel = 'free' | 'limited' | 'asks' | 'owned' | 'owner' | 'refused'

export interface PermissionCell {
    level: PermissionLevel
    /** What the limit is, or what happens instead. */
    note?: string
    /** The row's routes this kind may call, when it's only some of them (the chat edits one issue, never many at once). */
    routes?: string[]
    /** A limit held where the request comes in (server/utils/guard.ts `LIMITS`), by name. */
    check?: 'externalProposal' | 'boardHolder'
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
    /** A member and their agents, on an orrery with more than one person (ORR-654): anything but `free` or `limited` is
     * the owner's and their agents' alone, and either still needs them on the board the route names. */
    member: PermissionCell
    /** Those of its routes a session that names nobody may still call, on an orrery with more than one person: it can
     * read, comment and say what it's doing, and nothing else. */
    unnamed?: string[]
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
const ownerAlone: PermissionCell = {level: 'owner'}
const onTheirBoards: PermissionCell = {level: 'free'}

export const PERMISSIONS: Permission[] = [
    {
        id: 'issues.create', area: 'Roadmap', action: 'Make issues',
        why: 'Issues are material: what a session reads and weighs, not orders it must follow.',
        routes: ['POST /api/projects/:project/issues'],
        session: {level: 'free'},
        chat: {level: 'limited', note: 'Unstarted and unassigned'},
        untrusted: {level: 'limited', note: 'Only as a proposal labelled external'},
        member: onTheirBoards,
    },
    {
        id: 'issues.edit', area: 'Roadmap', action: 'Change an issue: its status, assignee, priority, chunk, release',
        why: 'Only one session works an issue at a time, and a proposal is work only once the owner approves it.',
        routes: ['PATCH /api/projects/:project/issues/:issue', 'PATCH /api/projects/:project/issues'],
        session: {level: 'limited', note: 'Not an issue another session is on, nor a proposal’s status, assignee or release before it’s approved'},
        chat: {level: 'limited', note: 'What it says and where it sits; its status and assignee only on your Allow, and not a proposal’s before it’s approved', routes: ['PATCH /api/projects/:project/issues/:issue']},
        untrusted: refused,
        member: {level: 'limited', note: 'On their boards, within what a session may'},
    },
    {
        id: 'issues.delete', area: 'Roadmap', action: 'Remove issues, chunks, releases or docs',
        why: 'Taking away what the owner made is their call.',
        routes: ['DELETE /api/projects/:project/issues/:issue', 'DELETE /api/projects/:project/chunks/:chunk', 'DELETE /api/projects/:project/docs/:doc', 'DELETE /api/projects/:project/issues', 'DELETE /api/projects/:project/releases/:release'],
        session: {level: 'limited', note: 'Not what the owner made'},
        chat: refused,
        untrusted: refused,
        member: {level: 'limited', note: 'On their boards, not what the owner made'},
    },
    {
        id: 'proposals.decide', area: 'Roadmap', action: 'Approve, reject or ask for changes to a proposal',
        why: 'A proposal asks the owner; deciding it is their answer.',
        routes: ['POST /api/projects/:project/issues/:issue/decide', 'POST /api/projects/:project/issues/decide'],
        session: {level: 'owner'},
        chat: refused,
        untrusted: refused,
        member: ownerAlone,
    },
    {
        id: 'comments.write', area: 'Roadmap', action: 'Comment, and ask the owner a question',
        why: 'Comments are how a session tells the owner what it did, and asks.',
        routes: ['POST /api/projects/:project/issues/:issue/comments', 'PATCH /api/projects/:project/issues/:issue/comments/:comment', 'DELETE /api/projects/:project/issues/:issue/comments/:comment'],
        session: {level: 'limited', note: 'Not editing or deleting the owner’s comments'},
        chat: {level: 'free', routes: ['POST /api/projects/:project/issues/:issue/comments']},
        untrusted: {level: 'limited', note: 'Only on its own external proposals', routes: ['POST /api/projects/:project/issues/:issue/comments'], check: 'externalProposal'},
        member: onTheirBoards,
        unnamed: ['POST /api/projects/:project/issues/:issue/comments'],
    },
    {
        id: 'docs.write', area: 'Roadmap', action: 'Write and change docs and releases',
        why: 'Docs are material, kept current by the sessions that read them.',
        routes: ['PUT /api/projects/:project/docs/:doc', 'POST /api/projects/:project/docs', 'PATCH /api/projects/:project/docs/:doc', 'POST /api/projects/:project/docs/:doc/revisions/:revision/restore', 'POST /api/projects/:project/doc-sections', 'PATCH /api/projects/:project/doc-sections/:section', 'DELETE /api/projects/:project/doc-sections/:section', 'POST /api/projects/:project/releases', 'PATCH /api/projects/:project/releases/:release'],
        session: {level: 'free'},
        chat: {level: 'asks', note: 'A doc made or changed as yours on your Allow, refused if it changed after it asked; never a section renamed or deleted, nor a doc removed'},
        untrusted: refused,
        member: onTheirBoards,
    },
    {
        id: 'chunks.write', area: 'Roadmap', action: 'Make and change chunks',
        why: 'A chunk groups issues: material, like the issues in it.',
        routes: ['POST /api/projects/:project/chunks', 'PATCH /api/projects/:project/chunks/:chunk'],
        session: {level: 'free'},
        chat: {level: 'asks', note: 'Saved as yours on your Allow'},
        untrusted: refused,
        member: onTheirBoards,
    },
    {
        id: 'presets.write', area: 'What sessions are told', action: 'Write presets',
        why: 'A preset’s text is an order every later session gets in the owner’s voice: one session writing it would write the orders for the rest.',
        routes: ['POST /api/presets', 'PATCH /api/presets/:preset', 'POST /api/projects/:project/presets', 'DELETE /api/presets/:preset', 'POST /api/presets/:preset/reset', 'POST /api/presets/defaults'],
        session: {level: 'owner'},
        chat: refused,
        untrusted: refused,
        member: ownerAlone,
    },
    {
        id: 'prompts.write', area: 'What sessions are told', action: 'Change the focus prompts and standing instructions',
        why: 'The same: what sessions are told must do is the owner’s to write.',
        routes: ['PATCH /api/projects/:project', 'PATCH /api/settings'],
        session: {level: 'owner', note: 'A project’s other fields are free'},
        chat: refused,
        untrusted: refused,
        member: {level: 'limited', note: 'A board’s other fields, on their boards', routes: ['PATCH /api/projects/:project']},
    },
    {
        id: 'settings.write', area: 'This orrery', action: 'Change App settings and the statuses',
        why: 'They change how orrery runs for every project and session.',
        routes: ['PATCH /api/settings', 'POST /api/statuses', 'PATCH /api/statuses/:status', 'DELETE /api/statuses/:status'],
        session: {level: 'owner'},
        chat: {level: 'asks', note: 'One setting at a time, saved on your Allow'},
        untrusted: refused,
        member: ownerAlone,
    },
    {
        id: 'signals.focus', area: 'Sessions', action: 'Ask sessions to focus on an issue or a chunk',
        why: 'Only the owner points sessions at work, so a session can’t set others going.',
        routes: ['POST /api/projects/:project/issues/:issue/focus', 'POST /api/projects/:project/chunks/:chunk/focus'],
        session: {level: 'owner', note: 'An agent’s focus is kept, and no session hears it'},
        chat: refused,
        untrusted: refused,
        member: {level: 'limited', note: 'On their boards, as a session’s focus: no session hears it'},
    },
    {
        id: 'sessions.message', area: 'Sessions', action: 'Message a session, or every session',
        why: 'A message reaches a session as the owner’s words.',
        routes: ['POST /api/projects/:project/sessions/:session/message', 'POST /api/sessions/message'],
        session: {level: 'owner'},
        chat: {level: 'asks', note: 'Sent as yours on your Send'},
        untrusted: refused,
        member: ownerAlone,
    },
    {
        id: 'sessions.start', area: 'Sessions', action: 'Start, stop or give more time to a session',
        why: 'Starting work, or ending it, is the owner’s.',
        routes: ['POST /api/projects/:project/launches', 'POST /api/projects/:project/launches/:launch/stop', 'POST /api/projects/:project/launches/:launch/extend', 'POST /api/projects/:project/sessions/:session/stop'],
        session: {level: 'owner'},
        chat: {level: 'asks', note: 'Done as yours on your Allow'},
        untrusted: refused,
        member: ownerAlone,
    },
    {
        id: 'sessions.watch', area: 'Sessions', action: 'Watch a session in a terminal',
        why: 'It opens a window on your machine.',
        routes: ['POST /api/projects/:project/launches/:launch/watch'],
        session: {level: 'owner'},
        chat: refused,
        untrusted: refused,
        member: ownerAlone,
    },
    {
        id: 'sessions.allow', area: 'Sessions', action: 'Allow what a session asks permission for',
        why: 'A permission prompt is there for a person to answer, not another session.',
        routes: ['POST /api/projects/:project/launches/:launch/allow'],
        session: {level: 'owner'},
        chat: refused,
        untrusted: refused,
        member: ownerAlone,
    },
    {
        id: 'chats.reply', area: 'Sessions', action: 'Answer in a chat, and ask the owner there',
        why: 'A chat is between the owner and its own session.',
        routes: ['POST /api/chats/:chat/replies', 'POST /api/chats/:chat/requests'],
        session: refused,
        chat: {level: 'limited', note: 'Only in its own chat'},
        untrusted: refused,
        member: ownerAlone,
    },
    {
        id: 'chats.use', area: 'Sessions', action: 'Chat with an agent: start, write in, clear or end a chat, and answer what it asks',
        why: 'The chat is the owner talking to an agent, and its requests wait on their answer.',
        routes: ['POST /api/chats', 'POST /api/chats/:chat/messages', 'PATCH /api/chats/:chat', 'POST /api/chats/:chat/clear', 'POST /api/chats/:chat/end', 'POST /api/chats/:chat/requests/:message'],
        session: {level: 'owner'},
        chat: {level: 'refused', note: 'It answers in its chat and asks there, never answering for you'},
        untrusted: refused,
        member: ownerAlone,
    },
    {
        id: 'schedules.issue', area: 'Schedules', action: 'Make a schedule that makes issues',
        why: 'An issue is material, so a schedule making them is too.',
        routes: ['POST /api/projects/:project/schedules'],
        session: {level: 'limited', note: 'It runs, but its asks reach no session'},
        chat: {level: 'asks', note: 'Saved as yours on your Allow'},
        untrusted: refused,
        member: {level: 'limited', note: 'On their boards, and its asks reach no session'},
    },
    {
        id: 'schedules.message', area: 'Schedules', action: 'Make a schedule that messages sessions',
        why: 'Its message would reach sessions as the owner’s words.',
        routes: ['POST /api/projects/:project/schedules'],
        session: {level: 'owned', note: 'Saved, but each run is skipped until you read it and press Make it mine'},
        chat: {level: 'asks', note: 'Saved as yours on your Allow'},
        untrusted: refused,
        member: ownerAlone,
    },
    {
        id: 'schedules.session', area: 'Schedules', action: 'Make a schedule that starts sessions',
        why: 'It starts work as the owner.',
        routes: ['POST /api/projects/:project/schedules'],
        session: {level: 'owner', note: 'It asks you on its issue instead'},
        chat: {level: 'asks', note: 'Saved as yours on your Allow'},
        untrusted: refused,
        member: ownerAlone,
    },
    {
        id: 'schedules.action', area: 'Schedules', action: 'Make a schedule that moves issues',
        why: 'It moves issues as the owner, with no session.',
        routes: ['POST /api/projects/:project/schedules'],
        session: {level: 'owner', note: 'It asks you on its issue instead'},
        chat: {level: 'asks', note: 'Saved as yours on your Allow'},
        untrusted: refused,
        member: ownerAlone,
    },
    {
        id: 'schedules.across', area: 'Schedules', action: 'Make, change or delete a schedule across projects',
        why: 'It runs as the owner on every project it names, and on ones added later.',
        routes: ['POST /api/schedules', 'PATCH /api/schedules/across/:across', 'DELETE /api/schedules/across/:across'],
        session: {level: 'owner'},
        chat: {level: 'owner'},
        untrusted: refused,
        member: ownerAlone,
    },
    {
        id: 'schedules.adopt', area: 'Schedules', action: 'Make an agent’s schedule the owner’s (Make it mine)',
        why: 'From then on its words reach sessions as the owner’s, so the owner reads them first: changing it, a pause or a rename, doesn’t make it theirs.',
        routes: ['POST /api/projects/:project/schedules/:schedule/adopt'],
        session: {level: 'owner'},
        chat: {level: 'owner'},
        untrusted: refused,
        member: ownerAlone,
    },
    {
        id: 'schedules.owners', area: 'Schedules', action: 'Change, run or delete one of the owner’s schedules',
        why: 'What the owner set running stays as they set it.',
        routes: ['PATCH /api/projects/:project/schedules/:schedule', 'POST /api/projects/:project/schedules/:schedule/run', 'DELETE /api/projects/:project/schedules/:schedule'],
        session: {level: 'owner', note: 'A schedule an agent made stays free to change'},
        chat: {level: 'asks', note: 'A change or a pause, saved on your Allow; deleting stays on Schedules'},
        untrusted: refused,
        member: {level: 'limited', note: 'One an agent made, on their boards'},
    },
    {
        id: 'schedules.ask', area: 'Schedules', action: 'Ask the owner, on the issue it’s working, to make or change a schedule',
        why: 'What a schedule says reaches sessions as the owner’s words, so the owner reads it before it runs (ORR-458).',
        routes: ['POST /api/projects/:project/issues/:issue/schedule-requests'],
        session: {level: 'free', note: 'A comment with Allow and Deny, waiting on your decision; saved as yours on your Allow'},
        chat: {level: 'refused', note: 'It asks in its chat instead'},
        untrusted: refused,
        member: onTheirBoards,
    },
    {
        id: 'schedules.answer', area: 'Schedules', action: 'Allow or deny a session’s request for a schedule',
        why: 'Allowing saves the schedule as the owner’s, so only they can.',
        routes: ['POST /api/projects/:project/issues/:issue/schedule-requests/:comment'],
        session: {level: 'owner'},
        chat: {level: 'owner'},
        untrusted: refused,
        member: ownerAlone,
    },
    {
        id: 'people.write', area: 'This orrery', action: 'Add, rename or remove a person',
        why: 'Who works on this orrery is the owner’s to decide.',
        routes: ['POST /api/people', 'PATCH /api/people/:person', 'DELETE /api/people/:person'],
        session: {level: 'owner'},
        chat: refused,
        untrusted: refused,
        member: ownerAlone,
    },
    {
        id: 'keys.write', area: 'This orrery', action: 'Make or revoke a key, or invite a person to log in',
        why: 'A key can’t make or widen a key, so an agent can never become its person. A person handles their own, and the owner issues them to others.',
        routes: ['POST /api/keys', 'DELETE /api/keys/:key', 'POST /api/invites'],
        session: {level: 'owner', note: 'a person, logged in: never a session, whatever key it has'},
        chat: refused,
        untrusted: refused,
    },
    {
        id: 'secrets.write', area: 'Secrets', action: 'Set, change or delete a secret',
        why: 'A secret’s value and where it may go are the owner’s to decide.',
        routes: ['PUT /api/secrets/:name', 'PATCH /api/secrets/:name', 'DELETE /api/secrets/:name'],
        session: {level: 'owner'},
        chat: refused,
        untrusted: refused,
        member: ownerAlone,
    },
    {
        id: 'secrets.egress', area: 'Secrets', action: 'Call an outside service with a secret (egress)',
        why: 'orrery fills the secret in, so a session uses a key without ever seeing it.',
        routes: ['POST /api/egress'],
        session: {level: 'limited', note: 'Only to the hosts and projects the secret allows'},
        chat: refused,
        untrusted: refused,
        member: ownerAlone,
    },
    {
        id: 'database.write', area: 'This orrery', action: 'Back up, restore or move the database',
        why: 'It decides where all of orrery’s data is.',
        routes: ['POST /api/backups', 'PUT /api/backups', 'POST /api/backups/restore', 'POST /api/database/move', 'POST /api/database/check'],
        session: {level: 'owner', note: 'And only from this machine'},
        chat: refused,
        untrusted: refused,
        member: ownerAlone,
    },
    {
        id: 'pulls.poll', area: 'This orrery', action: 'Poll GitHub for pull requests now',
        why: 'Each poll spends GitHub’s requests, which are few without a token.',
        routes: ['POST /api/pulls/poll'],
        session: {level: 'owner'},
        chat: refused,
        untrusted: refused,
        member: ownerAlone,
    },
    {
        id: 'notices.clear', area: 'This orrery', action: 'Clear the bell, or forget a session',
        why: 'What waits on the owner goes when they say.',
        routes: ['POST /api/notices/clear', 'POST /api/projects/:project/sessions/:session/forget'],
        session: {level: 'owner'},
        chat: refused,
        untrusted: refused,
        member: ownerAlone,
    },
    {
        id: 'owner.name', area: 'This orrery', action: 'Give or change the owner’s name',
        why: 'The first to open orrery names its owner; after that, it’s theirs.',
        routes: ['PUT /api/owner'],
        session: {level: 'limited', note: 'Only before the owner has a name'},
        chat: refused,
        untrusted: refused,
        member: ownerAlone,
    },
    {
        id: 'projects.create', area: 'Roadmap', action: 'Make a project',
        why: 'A new board belongs to whoever made it, and nobody else is on it until they say.',
        routes: ['POST /api/projects'],
        session: {level: 'free'},
        chat: refused,
        untrusted: refused,
        member: onTheirBoards,
    },
    {
        id: 'projects.delete', area: 'Roadmap', action: 'Delete a project',
        why: 'It takes everything on the board with it.',
        routes: ['DELETE /api/projects/:project'],
        session: {level: 'limited', note: 'Not one holding what the owner made'},
        chat: refused,
        untrusted: refused,
        member: {level: 'limited', note: 'The board’s holder, and their agents', check: 'boardHolder'},
    },
    {
        id: 'members.write', area: 'Roadmap', action: 'Add or remove a board’s members',
        why: 'Holding a board means saying who’s on it, and agents can’t let themselves in.',
        routes: ['POST /api/projects/:project/members', 'DELETE /api/projects/:project/members/:person'],
        session: {level: 'owner'},
        chat: refused,
        untrusted: refused,
        member: {level: 'limited', note: 'The board’s holder, never their agents', check: 'boardHolder'},
    },
    {
        id: 'issues.import', area: 'Roadmap', action: 'Import issues into a project',
        why: 'What comes in is material, as an issue a session makes is.',
        routes: ['POST /api/projects/:project/import'],
        session: {level: 'free'},
        chat: refused,
        untrusted: refused,
        member: onTheirBoards,
    },
    {
        id: 'uploads.write', area: 'Roadmap', action: 'Upload an image',
        why: 'An image is only shown where something links to it.',
        routes: ['POST /api/uploads'],
        session: {level: 'free'},
        chat: refused,
        untrusted: refused,
        member: onTheirBoards,
    },
    {
        id: 'sessions.report', area: 'Sessions', action: 'Say what a session is doing, from its hook, channel or launcher',
        why: 'It’s a session reporting on itself, which changes nothing on the roadmap.',
        routes: ['POST /api/sessions', 'POST /api/sessions/:session/calls', 'POST /api/projects/:project/signals/:signal/delivered', 'POST /api/projects/:project/launches/running', 'POST /api/projects/:project/launches/:launch/claim', 'POST /api/projects/:project/launches/:launch/ended', 'POST /api/projects/:project/launches/:launch/screen'],
        session: {level: 'free'},
        chat: refused,
        untrusted: refused,
        member: onTheirBoards,
        unnamed: ['POST /api/sessions', 'POST /api/sessions/:session/calls', 'POST /api/projects/:project/signals/:signal/delivered', 'POST /api/projects/:project/launches/running', 'POST /api/projects/:project/launches/:launch/claim', 'POST /api/projects/:project/launches/:launch/ended', 'POST /api/projects/:project/launches/:launch/screen'],
    },
    {
        id: 'events.report', area: 'This orrery', action: 'Report an error to the event log',
        why: 'Anyone’s page or session can say something went wrong; it’s kept as a report.',
        routes: ['POST /api/events/log'],
        session: {level: 'free'},
        chat: refused,
        untrusted: refused,
        member: onTheirBoards,
        unnamed: ['POST /api/events/log'],
    },
    {
        id: 'events.resolve', area: 'This orrery', action: 'Mark an event dealt with',
        why: 'The log covers every board, so it stays with the owner and their agents.',
        routes: ['POST /api/events/log/:event/resolve'],
        session: {level: 'free', note: 'It keeps their name, and the bell still shows it until the owner looks'},
        chat: refused,
        untrusted: refused,
        member: ownerAlone,
    },
]
