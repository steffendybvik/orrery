// The Rust API against the Nuxt server, an operation a line (ORR-1037): every `METHOD /api/path` either has that the
// router doesn't send on to the API, with the issue that moves it or why it stays. What the router sends on isn't
// listed: DOMAINS (server/utils/api-router.ts) says which domain each is, the contract (api/openapi.yaml) gives its
// replies, and api-parity.test.ts drives each one. rust-api-coverage.test.ts holds this to the routes the two servers
// have, so a route with no line, or a line with no route, fails; it also writes the table out for the
// `rust-api-parity` doc (ROUTE_TABLE=<file>).

/** Why an operation isn't sent on: a gap with the issue that closes it, what stays with the local app, or what only
 * the Rust API has, for the local app to keep its records with. */
export type Line = {issue: `ORR-${number}`, gap: string} | {stays: string} | {rustOnly: string}

// Uploading re-encodes images with sharp, which Rust lacks: how it moves is decided with the Nuxt server's retirement.
const ORR_1036: Line = {issue: 'ORR-1036', gap: 'uploading, which re-encodes images with sharp'}
const ORR_928: Line = {issue: 'ORR-928', gap: 'the owner, permissions and members, with auth'}
const ORR_950: Line = {issue: 'ORR-950', gap: 'schedule writes and runs, and the schedule requests that write them'}
const ORR_1006: Line = {issue: 'ORR-1006', gap: 'reading, deleting and importing a project'}
const ORR_1038: Line = {issue: 'ORR-1038', gap: 'the front door: served ahead, routed once how the request came in reaches the API'}

const FOCUS: Line = {stays: "a focus signals the sessions, which are the machine's (ORR-1004, ORR-927)"}
const CHAT: Line = {stays: "the chat's sessions are the local app's; the API keeps their rows, through PUT /api/chats/{chat}"}
const LOGIN: Line = {stays: 'logging in and out is checked here (auth.ts); the API hears what that found'}
const SEALED: Line = {stays: "sealed with the machine's key (decision-rust-api-secrets-settings)"}
const GIT: Line = {stays: "reads the local git repo or asks GitHub, which is the local app's to do (ORR-952, ORR-927)"}
const ARTIFACT: Line = {stays: "drawn with the page's own sanitising and its locked-down headers"}
const SESSIONS: Line = {stays: "the sessions, the launcher and their signals are the machine's"}
const MACHINE: Line = {stays: "the machine's: its files, the event log, its own use, and what it says about itself"}

const STORAGE: Line = {rustOnly: 'how the local app keeps its record of a chat or a GitHub poll (written ahead)'}
const OUTBOX: Line = {rustOnly: "the outbox, which the local app follows to hear what the API's writes set off (ORR-929)"}
const HEALTH: Line = {rustOnly: 'whether the API is up, for the local app that starts it'}

/** Every operation the router keeps, or only the Rust API has, by path and then method. */
export const NOT_ROUTED: Readonly<Record<string, Line>> = {
    'POST /api/auth/link': ORR_1038,
    'POST /api/auth/login': LOGIN,
    'POST /api/auth/logout': LOGIN,
    'GET /api/auth/oidc/callback': LOGIN,
    'GET /api/auth/oidc/start': LOGIN,
    'GET /api/auth/status': ORR_1038,
    'GET /api/backups': MACHINE,
    'POST /api/backups': MACHINE,
    'PUT /api/backups': MACHINE,
    'POST /api/backups/restore': MACHINE,
    'GET /api/changes': OUTBOX,
    'GET /api/chats': CHAT,
    'POST /api/chats': CHAT,
    'DELETE /api/chats/{chat}': CHAT,
    'GET /api/chats/{chat}': CHAT,
    'PATCH /api/chats/{chat}': CHAT,
    'PUT /api/chats/{chat}': STORAGE,
    'POST /api/chats/{chat}/clear': CHAT,
    'POST /api/chats/{chat}/end': CHAT,
    'POST /api/chats/{chat}/messages': CHAT,
    'POST /api/chats/{chat}/replies': CHAT,
    'POST /api/chats/{chat}/requests': CHAT,
    'POST /api/chats/{chat}/requests/{message}': CHAT,
    'GET /api/connects': MACHINE,
    'POST /api/connects': MACHINE,
    'GET /api/connects/stream': MACHINE,
    'GET /api/connects/{connect}': MACHINE,
    'POST /api/connects/{connect}/report': MACHINE,
    'POST /api/connects/{connect}/write': MACHINE,
    'POST /api/database/check': MACHINE,
    'POST /api/database/move': MACHINE,
    'POST /api/egress': SEALED,
    'POST /api/epics/{epic}/focus': FOCUS,
    'GET /api/events': MACHINE,
    'GET /api/events/log': MACHINE,
    'POST /api/events/log': MACHINE,
    'POST /api/events/log/{event}/resolve': MACHINE,
    'GET /api/guide': MACHINE,
    'GET /api/guide/using': MACHINE,
    'GET /api/machine': MACHINE,
    'GET /api/mcp': MACHINE,
    'GET /api/owner': ORR_928,
    'PUT /api/owner': ORR_928,
    'GET /api/permissions': ORR_928,
    'GET /api/phone': MACHINE,
    'POST /api/phone/link': ORR_1038,
    'POST /api/projects/upload': ORR_1006,
    'DELETE /api/projects/{project}': ORR_1006,
    'GET /api/projects/{project}': ORR_1006,
    'GET /api/projects/{project}/context': SESSIONS,
    'GET /api/projects/{project}/docs/{doc}/artifact': ARTIFACT,
    'POST /api/projects/{project}/import': ORR_1006,
    'GET /api/projects/{project}/issues/{issue}/branches': GIT,
    'POST /api/projects/{project}/issues/{issue}/focus': FOCUS,
    'GET /api/projects/{project}/issues/{issue}/pulls': GIT,
    'POST /api/projects/{project}/issues/{issue}/schedule-requests': ORR_950,
    'POST /api/projects/{project}/issues/{issue}/schedule-requests/{comment}': ORR_950,
    'GET /api/projects/{project}/launches': SESSIONS,
    'POST /api/projects/{project}/launches': SESSIONS,
    'POST /api/projects/{project}/launches/running': SESSIONS,
    'GET /api/projects/{project}/launches/stream': SESSIONS,
    'POST /api/projects/{project}/launches/{launch}/allow': SESSIONS,
    'POST /api/projects/{project}/launches/{launch}/claim': SESSIONS,
    'POST /api/projects/{project}/launches/{launch}/deny': SESSIONS,
    'POST /api/projects/{project}/launches/{launch}/ended': SESSIONS,
    'POST /api/projects/{project}/launches/{launch}/extend': SESSIONS,
    'GET /api/projects/{project}/launches/{launch}/screen': SESSIONS,
    'POST /api/projects/{project}/launches/{launch}/screen': SESSIONS,
    'POST /api/projects/{project}/launches/{launch}/stop': SESSIONS,
    'POST /api/projects/{project}/launches/{launch}/watch': SESSIONS,
    'GET /api/projects/{project}/listeners': SESSIONS,
    'GET /api/projects/{project}/members': ORR_928,
    'POST /api/projects/{project}/members': ORR_928,
    'DELETE /api/projects/{project}/members/{person}': ORR_928,
    'POST /api/projects/{project}/milestones/{milestone}/focus': FOCUS,
    'POST /api/projects/{project}/schedules': ORR_950,
    'POST /api/projects/{project}/schedules/enabled': ORR_950,
    'DELETE /api/projects/{project}/schedules/{schedule}': ORR_950,
    'PATCH /api/projects/{project}/schedules/{schedule}': ORR_950,
    'POST /api/projects/{project}/schedules/{schedule}/adopt': ORR_950,
    'POST /api/projects/{project}/schedules/{schedule}/run': ORR_950,
    'GET /api/projects/{project}/sessions': SESSIONS,
    'GET /api/projects/{project}/sessions/work': SESSIONS,
    'POST /api/projects/{project}/sessions/{session}/forget': SESSIONS,
    'POST /api/projects/{project}/sessions/{session}/message': SESSIONS,
    'GET /api/projects/{project}/sessions/{session}/next': SESSIONS,
    'POST /api/projects/{project}/sessions/{session}/stop': SESSIONS,
    'GET /api/projects/{project}/signals': SESSIONS,
    'GET /api/projects/{project}/signals/stream': SESSIONS,
    'POST /api/projects/{project}/signals/{signal}/delivered': SESSIONS,
    'GET /api/pulls': GIT,
    'DELETE /api/pulls/branches': GIT,
    'GET /api/pulls/branches': GIT,
    'POST /api/pulls/forget': STORAGE,
    'POST /api/pulls/poll': GIT,
    'PUT /api/pulls/{owner}/{name}': STORAGE,
    'PUT /api/pulls/{owner}/{name}/error': STORAGE,
    'PUT /api/pulls/{owner}/{name}/history': STORAGE,
    'PUT /api/pulls/{owner}/{name}/{number}': STORAGE,
    'POST /api/schedules': ORR_950,
    'DELETE /api/schedules/across/{across}': ORR_950,
    'PATCH /api/schedules/across/{across}': ORR_950,
    'DELETE /api/secrets/{name}': SEALED,
    'PATCH /api/secrets/{name}': SEALED,
    'PUT /api/secrets/{name}': SEALED,
    'GET /api/sessions': SESSIONS,
    'POST /api/sessions': SESSIONS,
    'POST /api/sessions/message': SESSIONS,
    'GET /api/sessions/work': SESSIONS,
    'POST /api/sessions/{session}/calls': SESSIONS,
    'GET /api/signals/stream': SESSIONS,
    'POST /api/uploads': ORR_1036,
    'DELETE /api/usage': MACHINE,
    'GET /api/usage': MACHINE,
    'POST /api/usage': MACHINE,
    'GET /api/version': MACHINE,
    'GET /health': HEALTH,
}
