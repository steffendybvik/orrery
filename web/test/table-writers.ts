// Every table the Rust API writes, and whether it's the only writer once the router sends its domain there (ORR-1010).
// Both servers write one database while the domains move (ORR-923). A table the API writes alone is safe. Where the
// Nuxt server still writes it too, that's said here, with what writes it and the issue that ends it, so sharing a table
// is a choice someone reviewed, not drift. one-writer.test.ts reads the tables off the API's SQL and holds them to this.
//
// Not counted, as neither writes the other's open database: the migrations (the Node app runs them, and the Rust copy is
// held to it by rust-migrations.test.ts), and a database move (utils/copy.ts), which writes a new file.

export type Writer = {alone: string} | {nuxt: string, issue?: `ORR-${number}`}

const PROJECT: Writer = {nuxt: 'reading and importing a project (store/projects.ts, store/imports.ts, utils/renumber.ts)', issue: 'ORR-1006'}
const UPLOAD = 'a board file uploaded from another server (utils/board-upload.ts)'
const SCHEDULES: Writer = {nuxt: 'schedule writes and runs (utils/schedules.ts)', issue: 'ORR-950'}
const BELL: Writer = {alone: 'the bell (store/owner.ts clearNotices, readNotices), all routed as "the bell"'}

/** The tables written from a table name the code picks (`format!("… {} …", thread.table())`), by file under api/src. */
export const DYNAMIC: Record<string, string[]> = {
    'board/threads.rs': ['milestone_comments', 'epic_comments'],
}

export const WRITERS: Record<string, Writer> = {
    changes: {nuxt: 'a change row for every write it still makes (store/base.ts), so the browser hears it'},
    chats: {nuxt: "the chat's sessions, which are the local app's (utils/chats.ts)", issue: 'ORR-1044'},
    comments: {nuxt: `naming the owner (store/owner.ts nameOwner, ORR-928), and ${PROJECT.nuxt}`, issue: 'ORR-1006'},
    doc_revisions: PROJECT,
    doc_sections: PROJECT,
    docs: PROJECT,
    epic_comments: {alone: 'comments on an epic, routed as "milestone and epic comments"; an uploaded board leaves them out'},
    epics: {alone: 'made, changed and deleted through /api/epics, and touched by a comment on one, both routed'},
    events: {nuxt: "a line (utils/event-log.ts keep) and pruning only with no API in front, or while it can't be reached (marked details.local), so its own outage is kept; it sends them to PUT /api/events/log/lines otherwise", issue: 'ORR-1093'},
    feature_use: {nuxt: 'the minute flush of what it counted (utils/usage.ts flushUse) only with no API in front; it sends them to PUT /api/usage otherwise', issue: 'ORR-1093'},
    identities: {nuxt: 'a sign-in through the provider (store/keys.ts identity), which logging in keeps', issue: 'ORR-928'},
    invites: {nuxt: 'an invite used at a provider sign-in (store/keys.ts identity)', issue: 'ORR-928'},
    issue_aliases: PROJECT,
    issue_events: {nuxt: `the status and assignee changes it still makes (store/base.ts), and ${UPLOAD}`, issue: 'ORR-747'},
    issue_links: PROJECT,
    issue_pulls: {nuxt: 'the GitHub poll (utils/pulls.ts remember) only with no API in front; it sends them to PUT /api/pulls/{owner}/{name}/{number} otherwise', issue: 'ORR-1093'},
    issue_sessions: {nuxt: 'which session works an issue: a session writing to one, its focus, its claim (store/claims.ts workedBy), as the sessions are the local app\'s; the API notes only the session that made a new issue (ORR-1059)'},
    issues: {nuxt: `schedule runs making issues (ORR-950), naming the owner (ORR-928), and ${PROJECT.nuxt}`, issue: 'ORR-1006'},
    keys: {nuxt: "a key's last use, as logging in checks it (store/keys.ts keyHolder), which stays here", issue: 'ORR-928'},
    logins: {nuxt: 'logging in and out, and their last use (store/keys.ts), which stay here', issue: 'ORR-928'},
    milestone_aliases: PROJECT,
    milestone_comments: {nuxt: UPLOAD, issue: 'ORR-747'},
    milestones: PROJECT,
    notice_clears: BELL,
    notice_reads: BELL,
    people: {nuxt: 'naming the owner (store/owner.ts nameOwner)', issue: 'ORR-928'},
    presets: {nuxt: `${UPLOAD}, and ${PROJECT.nuxt}`, issue: 'ORR-1006'},
    project_members: {nuxt: `naming the owner and the members (ORR-928), and ${UPLOAD}`, issue: 'ORR-928'},
    projects: PROJECT,
    proposal_clears: BELL,
    pull_repos: {nuxt: 'the GitHub poll (utils/pull-poll.ts keepPolled) only with no API in front; it sends its writes to /api/pulls otherwise', issue: 'ORR-1093'},
    pull_states: {nuxt: 'the GitHub poll (utils/pull-poll.ts keepPolled) only with no API in front; it sends its writes to /api/pulls otherwise', issue: 'ORR-1093'},
    releases: {nuxt: `${UPLOAD}, and ${PROJECT.nuxt}`, issue: 'ORR-1006'},
    schedule_requests: {alone: "a session's ask for a schedule and the owner's Allow and Deny, both routed (ORR-1100)"},
    schedule_runs: SCHEDULES,
    schedules: SCHEDULES,
    schedules_across: SCHEDULES,
    secret_uses: {nuxt: 'egress and orrery\'s own requests (utils/secrets.ts keepUse) only with no API in front; it sends them to POST /api/secrets/{name}/uses otherwise', issue: 'ORR-1093'},
    secrets: {nuxt: 'setting, narrowing and deleting one (utils/secrets.ts keepSealed) only with no API in front; it sends the sealed row to /api/secrets/{name}/sealed otherwise', issue: 'ORR-1093'},
    settings: {nuxt: "the machine's settings, the sealed ones and auth staying on (store/keys.ts, store/signals.ts)"},
    signals: {nuxt: "a signal, a receipt, a retarget and the prune (store/signals.ts writeSignal) only with no API in front; it picks the target and sends them to POST …/signals otherwise", issue: 'ORR-1093'},
    statuses: {nuxt: UPLOAD, issue: 'ORR-747'},
    uploads: {nuxt: `compressing the images kept before ORR-446 once, and clearing the ones nothing shows after 90 days (store/signals.ts), and ${UPLOAD}`, issue: 'ORR-747'},
}
