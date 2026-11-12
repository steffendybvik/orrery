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
const ORR_950: Line = {issue: 'ORR-950', gap: 'running a schedule now'}
const ORR_1006: Line = {issue: 'ORR-1006', gap: 'uploading a project'}
const ORR_1038: Line = {issue: 'ORR-1038', gap: 'the front door: served ahead, routed once how the request came in reaches the API'}

const FOCUS: Line = {stays: "a focus signals the sessions, which are the machine's (ORR-1004, ORR-927)"}
const CHAT: Line = {stays: "the chat's sessions are the local app's; the API keeps their rows, through PUT /api/chats/{chat}"}
const LOGIN: Line = {stays: 'logging in and out is checked here (auth.ts); the API hears what that found'}
const SEALED: Line = {stays: "sealed with the machine's key (decision-rust-api-secrets-settings)"}
const SEALED_ROWS: Line = {rustOnly: 'how the local app keeps a secret it sealed, and its uses: it sends them here itself (`writeToApi`, ORR-1096)'}
const GIT: Line = {stays: "reads the local git repo or asks GitHub, which is the local app's to do (ORR-952, ORR-927)"}
const ARTIFACT: Line = {stays: "drawn with the page's own sanitising and its locked-down headers"}
const SESSIONS: Line = {stays: "the sessions, the launcher and their signals are the machine's"}
const MACHINE: Line = {stays: "the machine's: its files, the event log, its own use, and what it says about itself"}

const SNAPSHOT: Line = {rustOnly: 'the copy a backup takes of the database: the local app asks for it itself, then checks and keeps it (`snapshotsBy`, ORR-1097)'}
const DATABASE: Line = {rustOnly: "what the local app's backups and App settings → Database ask of the database itself: whether it's a new orrery's, a Postgres one's size, and the name it runs under (ORR-1140)"}
const SESSION_WORK: Line = {rustOnly: "which session is on which issue, as the local app's session bookkeeping asks it (clearing, picking, the Todo hand-out): it reads them itself (`sessionWork`, ORR-1141)"}
const STORAGE: Line = {rustOnly: 'how the local app keeps its record of a chat and its messages, a GitHub poll, the feature counts it gathered or a line of the event log: it sends them here itself (`writeToApi`)'}
const CHAT_ASK: Line = {rustOnly: "the chat asking to change a setting, a schedule, a release or a doc, offering an issue or moving some, for the Rust /mcp's `update_settings`, `create_schedule`, `update_schedule`, `create_release`, `update_release`, `create_doc`, `update_doc`, `offer_issue` and `move_issues` (ORR-1100): the chat's other asks stay at POST /api/chats/{chat}/requests until they move too"}
const SIGNAL: Line = {rustOnly: "a session's signal, written: the local app picks the session it goes to and tells it, then sends the row here itself (`writeSignal`, ORR-1090)"}
const SAID: Line = {rustOnly: "orrery's own word on an issue (a pull request's news, a schedule's note): the local app sends it here itself (`writeToApi`, ORR-1094)"}
const OUTBOX: Line = {rustOnly: "the outbox, which the local app follows to hear what the API's writes set off (ORR-929)"}
const HEALTH: Line = {rustOnly: 'whether the API is up, for the local app that starts it'}
const MCP: Line = {rustOnly: "orrery's MCP tools over streamable HTTP (ORR-1098): JSON-RPC, so not in the REST contract; the channel serves them until ORR-1102"}

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
    'POST /api/chats/{chat}/lines': STORAGE,
    'PUT /api/chats/{chat}/lines/{message}': STORAGE,
    'POST /api/chats/{chat}/messages': CHAT,
    'POST /api/chats/{chat}/replies': CHAT,
    'POST /api/chats/{chat}/requests': CHAT,
    'POST /api/chats/{chat}/requests/{message}': CHAT,
    'POST /api/chats/{chat}/setting-requests': CHAT_ASK,
    'POST /api/chats/{chat}/schedule-requests': CHAT_ASK,
    'POST /api/chats/{chat}/release-requests': CHAT_ASK,
    'POST /api/chats/{chat}/doc-requests': CHAT_ASK,
    'POST /api/chats/{chat}/issue-requests': CHAT_ASK,
    'POST /api/chats/{chat}/move-requests': CHAT_ASK,
    'GET /api/connects': MACHINE,
    'POST /api/connects': MACHINE,
    'GET /api/connects/stream': MACHINE,
    'GET /api/connects/{connect}': MACHINE,
    'POST /api/connects/{connect}/report': MACHINE,
    'POST /api/connects/{connect}/write': MACHINE,
    'GET /api/database': DATABASE,
    'POST /api/database/check': MACHINE,
    'PUT /api/database/environment': DATABASE,
    'POST /api/database/move': MACHINE,
    'POST /api/database/snapshot': SNAPSHOT,
    'POST /api/egress': SEALED,
    'POST /api/epics/{epic}/focus': FOCUS,
    'GET /api/events': MACHINE,
    'POST /api/events/log': {stays: "a page's error report: each sender is counted in memory here, and the line made of it sent on (PUT /api/events/log/lines, ORR-1088)"},
    'PUT /api/events/log/lines': STORAGE,
    'POST /api/events/log/prune': STORAGE,
    'GET /api/guide': MACHINE,
    'GET /api/guide/using': MACHINE,
    'GET /api/launches/stream': SESSIONS,
    'GET /api/machine': MACHINE,
    'GET /api/mcp': MACHINE,
    'GET /api/phone': MACHINE,
    'POST /api/phone/link': ORR_1038,
    'POST /api/presets/seed': {rustOnly: 'the presets orrery ships, seeded by the local app itself each time the API it started begins listening (ORR-1136)'},
    'POST /api/projects/upload': ORR_1006,
    'GET /api/projects/{project}/context': SESSIONS,
    'GET /api/projects/{project}/docs/{doc}/artifact': ARTIFACT,
    'GET /api/projects/{project}/issue-sessions': SESSION_WORK,
    'GET /api/projects/{project}/issues/{issue}/branches': GIT,
    'GET /api/projects/{project}/issues/{issue}/dependents': SESSION_WORK,
    'POST /api/projects/{project}/issues/{issue}/focus': FOCUS,
    'GET /api/projects/{project}/issues/{issue}/pulls': GIT,
    'GET /api/projects/{project}/issues/{issue}/workers': SESSION_WORK,
    'POST /api/projects/{project}/issues/{issue}/worked-by': SESSION_WORK,
    'POST /api/projects/{project}/issues/{issue}/said': SAID,
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
    'POST /api/projects/{project}/milestones/{milestone}/focus': FOCUS,
    'POST /api/projects/{project}/schedules/{schedule}/run': ORR_950,
    'GET /api/projects/{project}/sessions': SESSIONS,
    'GET /api/projects/{project}/sessions/work': SESSIONS,
    'POST /api/projects/{project}/sessions/{session}/forget': SESSIONS,
    'POST /api/projects/{project}/sessions/{session}/message': SESSIONS,
    'GET /api/projects/{project}/sessions/{session}/next': SESSIONS,
    'POST /api/projects/{project}/sessions/{session}/stop': SESSIONS,
    'GET /api/projects/{project}/signals/stream': SESSIONS,
    'POST /api/projects/{project}/signals': SIGNAL,
    'POST /api/projects/{project}/signals/retarget': SIGNAL,
    'POST /api/projects/{project}/signals/{signal}/delivered': SESSIONS,
    'POST /api/projects/{project}/signals/{signal}/receipts': SIGNAL,
    'GET /api/pulls': GIT,
    'DELETE /api/pulls/branches': GIT,
    'GET /api/pulls/branches': GIT,
    'POST /api/pulls/forget': STORAGE,
    'POST /api/pulls/poll': GIT,
    'PUT /api/pulls/{owner}/{name}': STORAGE,
    'PUT /api/pulls/{owner}/{name}/error': STORAGE,
    'PUT /api/pulls/{owner}/{name}/history': STORAGE,
    'PUT /api/pulls/{owner}/{name}/{number}': STORAGE,
    'DELETE /api/secrets/{name}': SEALED,
    'PATCH /api/secrets/{name}': SEALED,
    'PUT /api/secrets/{name}': SEALED,
    'DELETE /api/secrets/{name}/sealed': SEALED_ROWS,
    'PUT /api/secrets/{name}/sealed': SEALED_ROWS,
    'POST /api/secrets/{name}/uses': SEALED_ROWS,
    'GET /api/sessions': SESSIONS,
    'POST /api/sessions': SESSIONS,
    'POST /api/sessions/message': SESSIONS,
    'GET /api/sessions/work': SESSIONS,
    'POST /api/sessions/{session}/calls': SESSIONS,
    'POST /api/signals/prune': SIGNAL,
    'GET /api/signals/stream': SESSIONS,
    'POST /api/usage': {stays: 'a use is counted in memory here, and sent on once a minute (PUT /api/usage, ORR-1089)'},
    'PUT /api/usage': STORAGE,
    'GET /api/version': MACHINE,
    'GET /health': HEALTH,
    'DELETE /mcp': MCP,
    'GET /mcp': MCP,
    'POST /mcp': MCP,
}
