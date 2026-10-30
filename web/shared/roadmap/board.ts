// An issue board: statuses and their kinds, issues, proposals, chunks, releases, docs, comments and what they
// changed, and the helpers that name and link them.
import type {Instruction} from '../prompt'
import type {ChatScheduleRequest} from './chats'
import type {Starts} from './settings'

/** What a status means, whatever it's called: orrery's counts, progress and pages reason about kinds,
 * never names. In board order. */
export const KINDS = ['backlog', 'todo', 'started', 'done', 'canceled'] as const
export type Kind = (typeof KINDS)[number]
/** The kinds an issue is closed in: out of the open counts. Canceled is also out of progress. */
export const CLOSED: readonly Kind[] = ['done', 'canceled']

/** An issue's status, one list for the whole orrery: its id (`in-review`) is what an issue stores, its
 * name and colour are what the board shows, and its kind is what it means. */
export interface IssueStatus {
    id: string
    name: string
    kind: Kind
    /** A tint's name (`teal`) or a `#rrggbb`. */
    color: string
    position: number
}

/** The statuses a new orrery starts with. */
export const DEFAULT_STATUSES: Omit<IssueStatus, 'position'>[] = [
    {id: 'backlog', name: 'Backlog', kind: 'backlog', color: 'slate'},
    {id: 'todo', name: 'Todo', kind: 'todo', color: 'blue'},
    {id: 'in-progress', name: 'In progress', kind: 'started', color: 'amber'},
    {id: 'in-review', name: 'In review', kind: 'started', color: 'violet'},
    {id: 'done', name: 'Done', kind: 'done', color: 'green'},
    {id: 'canceled', name: 'Canceled', kind: 'canceled', color: 'slate'},
]

/** Where an issue sits on the board: a status's id, or `proposed` while it's a proposal (not work yet). */
export type Column = string
/** What a column means: a status's kind, or `proposed`. */
export type Place = Kind | 'proposed'

/** Where a proposal stands: waiting on the owner (`pending`), or as they decided. */
export type Proposal = 'pending' | 'approved' | 'changes' | 'rejected'
/** What the owner can decide on a proposal. */
export const DECISIONS = ['approved', 'changes', 'rejected'] as const
export type Decision = (typeof DECISIONS)[number]

/** One option of a choice: `A`, `B`, … or a word, with a title and (Markdown) more about it. */
interface ChoiceOption {
    key: string
    title: string
    body?: string
}

/** A question on a proposal, answered by picking one option or any of them. The agent ticks what it
 * recommends. A choice `from` an option goes further down that option (asked for when the owner explored
 * it), and counts only if that option is picked. */
export interface Choice {
    key: string
    question: string
    pick: 'one' | 'any'
    options: ChoiceOption[]
    recommended: string[]
    from?: {choice: string, option: string}
}

/** The owner's picks: for each choice, the options they ticked. */
export type Picks = Record<string, string[]>

/** The choices that count for these picks: those at the top, and those going further down a picked option. */
export function liveChoices(choices: Choice[], picks: Picks): Choice[] {
    const live: Choice[] = []
    for (const choice of choices) {
        const from = choice.from
        if (!from || (live.some(c => c.key === from.choice) && (picks[from.choice] ?? []).includes(from.option))) live.push(choice)
    }
    return live
}

/** P0 is urgent. */
export const PRIORITIES = ['P0', 'P1', 'P2', 'P3'] as const
export type Priority = (typeof PRIORITIES)[number]

/** Most urgent first, those with no priority last: a sort's compare. */
export const byPriority = (a: {priority?: Priority}, b: {priority?: Priority}) => (a.priority ?? 'P9').localeCompare(b.priority ?? 'P9')

/** How many leaf issues sit in each column (a status id, or `proposed`). */
export type Counts = Record<Column, number>
/** The same leaves by what their column means. Proposed ones aren't work yet: they're left out of `total`. */
export type Kinds = Record<Place, number>

export interface Issue {
    id: string
    title: string
    priority?: Priority
    /** Who's on it: a person, or `claude`. */
    assignee?: string
    labels: string[]
    /** Its tasks on the team's tracker: ids (`ENG-1567`), linked through the orrery's `tracker`, or full URLs. */
    external: string[]
    /** The GitHub issues it came from (ORR-635), each `owner/name#523`: shown as `#523` on the project's own repo. */
    github_issues: string[]
    /** A status's id, as written; a parent's own status is ignored, its issues decide its column. */
    status: string
    notes?: string
    /** Set when it's a proposal (with its sub-issues): not work until the owner commits it. */
    proposal?: Proposal
    /** Who last decided on the proposal, when, and what they said. */
    decided_by?: string
    decided_at?: string
    decision_note?: string
    /** A proposal's choices: what the owner decides, the agent's recommendation ticked. */
    choices: Choice[]
    /** The owner's picks when they approved it, choice → options. */
    picks?: Picks
    /** The option the owner asked to explore further when they asked for changes. */
    explore?: {choice: string, option: string}
    column: Column
    /** What its column means. */
    kind: Place
    /** Its sub-issues' columns; an issue without any counts as one. */
    counts: Counts
    kinds: Kinds
    comments: number
    /** An agent's question on it the owner hasn't answered yet (no comment of theirs after it): what it waits for. */
    waiting?: Asks
    /** Ids it had before (e.g. `MOT-5`), which still find it. */
    aliases: string[]
    /** The schedule that made it, if one did. */
    schedule?: number
    /** The version it ships in (a release's), if it's set for one. */
    release?: string
    created_by: string
    /** The name of the session that made it, as it was then (ORR-466). */
    session_name?: string
    /** The person who has taken it up (ORR-655), on an orrery with more than one person. */
    claimed_by?: string
    /** Made by the owner: no one else can delete it. */
    protected: boolean
    /** The issues it builds on (ORR-601), as `linkRef`s: work on it waits until each is done. Only with some. */
    depends_on?: string[]
    /** Those of them not done yet (a canceled one too, until the owner decides): while there are any it's blocked, and nothing hands it out. Only with some. */
    blocked_by?: string[]
    /** The issues that depend on it, read the other way. Only with some. */
    blocks?: string[]
    created_at: string
    updated_at: string
    tasks: Issue[]
}

/** Whether an issue waits on another that isn't done yet (ORR-601): nothing hands it out until it's free. */
export const isBlocked = (issue: {blocked_by?: string[]}) => !!issue.blocked_by?.length

/** How an issue names another it's linked to (ORR-601): its id in the same project, `project/ID` in another. */
export const linkRef = (here: string, project: string, id: string) => project === here ? id : `${project}/${id}`

/** The project and id a `linkRef` names, read from `here`. */
export function parseLinkRef(here: string, ref: string): {project: string, id: string} {
    const slash = ref.indexOf('/')
    return slash < 0 ? {project: here, id: ref.trim()} : {project: ref.slice(0, slash).trim(), id: ref.slice(slash + 1).trim()}
}

/** A group of issues: a milestone. The one with an empty id holds the issues in none. */
export interface Chunk {
    id: string
    title: string
    summary?: string
    /** How much it matters, P0 being urgent. */
    priority?: Priority
    column: Column
    kind: Place
    counts: Counts
    kinds: Kinds
    /** Names it had before (e.g. `joints`), which still find it. */
    aliases: string[]
    created_by: string
    protected: boolean
    tasks: Issue[]
}

export interface Board {
    chunks: Chunk[]
    counts: Counts
    kinds: Kinds
}

/** A version the project ships (`1.0.0-rc.2`) and how far the issues going out in it are. */
export interface Release {
    version: string
    /** The branch its work gathers on before it ships, e.g. `v1.0.0-rc.2`. */
    branch?: string
    /** What it's about, in Markdown. */
    notes?: string
    /** The day its features froze (`YYYY-MM-DD`): from then on it takes fixes, tests and docs, by preference. */
    frozen_on?: string
    /** The day it shipped (`YYYY-MM-DD`); none while it's being prepared. */
    shipped_on?: string
    /** The newest doc revision when it shipped, across the orrery: a doc as of this release is its newest revision at or
     * below this. None while it's being prepared, and on one shipped before revisions were kept. */
    doc_mark?: number
    /** Its issues: those set for it, each with its sub-issues (in every project drawing on it, on its source). */
    issues: number
    kinds: Kinds
    created_by: string
    protected: boolean
    created_at: string
    updated_at: string
}

/** A project's own issues in a release: all of it, or its part when several projects share the release. */
interface ReleasePart {
    project: string
    issues: number
    kinds: Kinds
}

/** A release on the Releases page across projects (ORR-671), without its notes, with each project's part. */
export interface TrackedRelease extends Omit<Release, 'notes'> {
    projects: ReleasePart[]
}

/** The releases made on one project, in the order they're arranged in, with the projects they cover: itself first,
 * then those taking their releases from it. `GET /api/releases` lists one of these for each project with its own. */
export interface ProjectReleases {
    project: string
    projects: string[]
    releases: TrackedRelease[]
}

/** How a project's card on the Releases page has them: those being prepared as arranged, then its latest shipped one,
 * with the older ones to fold away, latest first. */
export function releasesToTrack<T extends Pick<Release, 'shipped_on'>>(releases: T[]): {preparing: T[], latest?: T, older: T[]} {
    const shipped = releases.filter(r => r.shipped_on).sort((a, b) => (b.shipped_on ?? '').localeCompare(a.shipped_on ?? ''))
    return {preparing: releases.filter(r => !r.shipped_on), latest: shipped[0], older: shipped.slice(1)}
}

/** Whether the release is in feature freeze: frozen, and not shipped yet. */
export const isFrozen = (release: Pick<Release, 'frozen_on' | 'shipped_on'> | undefined) => !!release?.frozen_on && !release.shipped_on

/** What a session hears about an issue set for a release in feature freeze: a preference, never a refusal. */
export function freezeNote(release: Pick<Release, 'version' | 'frozen_on' | 'shipped_on'> | undefined): string | null {
    if (!release || !isFrozen(release)) return null
    return `${release.version} is in feature freeze (since ${release.frozen_on}): it takes fixes, tests and docs. Put a new feature on the next release instead, so this one can go out.`
}

/** A doc without its text, as a project lists it. */
export interface DocSummary {
    id: string
    title: string
    /** Its first paragraph as plain text, cut to about 160 characters: enough to tell whether to open it. */
    summary: string
    /** With a search (`?q=`): the text around its first hit, empty when only the title has it. */
    match?: string
    /** The group it's listed under (Decisions, How it works); none lists it first, on its own. */
    section?: string
    created_by: string
    protected: boolean
    created_at: string
    updated_at: string
}

/** A page of Markdown about the project: an overview, a decision, how to run it. */
export interface Doc extends DocSummary {
    project: string
    body: string
    /** Its id to paste anywhere: `doc-ideas-x7k2m9qd`, which finds nothing on any other board. */
    full_id?: string
}

/** One saved version of a doc, as a doc's history lists them (ORR-675). Ids run across the orrery. */
export interface DocRevisionSummary {
    id: number
    title: string
    /** The doc being removed here: this holds its last text. */
    deleted: boolean
    created_by: string
    /** The name of the session that wrote it, as it was then. */
    session_name?: string
    created_at: string
}

export interface DocRevision extends DocRevisionSummary {
    project: string
    doc: string
    body: string
}

/** A doc that's gone and can come back, from its last revision. */
export interface DeletedDoc {
    id: string
    title: string
    summary: string
    /** The revision that says it was removed. */
    revision: number
    deleted_by: string
    deleted_at: string
}

/** One app: its details, its board and its docs. */
export interface Project {
    id: string
    name: string
    /** The prefix of the issue ids the server hands out, e.g. `GRE` for `GRE-12`. */
    key: string
    /** Its random id, in the full form of the ids on it: `GRE-12-x7k2m9qd`. It goes with the board when it moves. */
    uid: string
    description?: string
    /** Its icon in the sidebar: a Heroicon's name, e.g. `shopping-cart`. */
    icon?: string
    /** Its icon's colour: a tint's name (`teal`) or a `#rrggbb`; none follows the text. */
    icon_color?: string
    /** What its sessions hear when asked to focus on an issue or a chunk, when not the orrery's (`Settings`). */
    focus_prompt?: string
    chunk_prompt?: string
    /** Its own standing instructions, and the ids of the orrery's it switches off. */
    instructions: Instruction[]
    muted: string[]
    /** Whether orrery may start sessions for it itself, when the owner's signal finds nobody listening, and
     * within what: the orrery's setting (`Settings.starts`), the same for every project; none while the owner hasn't let it. */
    starts?: Starts
    /** Where its code is (`https://github.com/you/shop`), to link a release's branch and PRs, and read an issue's open PRs off GitHub. */
    repo?: string
    /** Whether it has releases: `none` (not everything ships), its `own`, or `shared`, another project's. */
    release_mode: ReleaseMode
    /** The project whose releases it ships in, when it's `shared` (a monorepo's apps going out together); its
     * `releases` are then that project's, counting its own issues. */
    releases_from?: string
    created_by: string
    protected: boolean
    created_at: string
    updated_at: string
    board: Board
    docs: DocSummary[]
    /** Its docs' sections, A–Z: each one a doc is filed under, and the ones made empty (`POST …/doc-sections`). */
    doc_sections: string[]
    /** In the order they're arranged in, a new one on top. */
    releases: Release[]
}

/** What an agent's comment waits on the owner for. */
export const ASKS = ['decision', 'feedback'] as const
export type Asks = (typeof ASKS)[number]

/** An image kept for Markdown to show (`POST /api/uploads`). */
export interface Upload {
    id: string
    type: string
    size: number
    /** Where it's served: /api/uploads/<id>. */
    url: string
    /** `![name](url)`, to put in a comment. */
    markdown: string
}

export interface Comment {
    id: number
    issue: string
    body: string
    /** It waits on the owner for this, until they comment on the issue after it (`answered`). */
    asks?: Asks
    answered?: boolean
    /** A working session asking on its issue to make or change a schedule (ORR-458): shown with Allow and Deny, and saved
     * as the owner's only once they allow it. */
    schedule?: ChatScheduleRequest
    created_by: string
    /** The name of the session that wrote it, as it was then (ORR-466); none for the owner's, older ones and API writes. */
    session_name?: string
    protected: boolean
    created_at: string
    updated_at: string
}

/** What an issue's activity records: a field that changed, `created` when it was made, `project` when it
 * moved in from another project. */
/** Whether a project has releases: none, its own, or another project's (`releases_from`). */
export const RELEASE_MODES = ['none', 'own', 'shared'] as const
export type ReleaseMode = typeof RELEASE_MODES[number]

export type ActivityField = 'created' | 'title' | 'status' | 'priority' | 'assignee' | 'labels' | 'external' | 'github_issues' | 'notes' | 'chunk' | 'parent' | 'proposal' | 'project' | 'release' | 'depends'

/** One change to an issue: who set `field` from `before` to `after`, and when. Values are as stored (a
 * status's id, a chunk's id, labels as a JSON list); none means unset. Notes keep no values. */
export interface IssueEvent {
    id: number
    issue: string
    field: ActivityField
    before?: string
    after?: string
    created_by: string
    /** The name of the session that made the change (ORR-466), as on a comment. */
    session_name?: string
    protected: boolean
    created_at: string
}

export const emptyKinds = (): Kinds => ({proposed: 0, backlog: 0, todo: 0, started: 0, done: 0, canceled: 0})

/** The committed issues: every kind but proposed and canceled (what progress is out of). */
export const total = (kinds: Kinds) => kinds.backlog + kinds.todo + kinds.started + kinds.done

/** The open issues: committed and not closed. */
export const open = (kinds: Kinds) => kinds.backlog + kinds.todo + kinds.started

/** Where a team task opens: a full URL as it is, an id through the tracker's pattern; none without one. */
export function taskUrl(tracker: string | null, task: string): string | undefined {
    if (/^https?:\/\//.test(task)) return task
    return tracker ? tracker.replace('{id}', encodeURIComponent(task)) : undefined
}

/** The repo's `owner/name` on GitHub, from its web address; null for anywhere else. */
export function githubRepo(repo: string | null | undefined): string | null {
    const match = repo?.trim().match(/^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i)
    return match ? `${match[1]}/${match[2]}` : null
}

/** A GitHub issue an issue came from (ORR-635), as it's kept: `owner/name#523`. Sent as that, as its link, or as
 * `523` or `#523` on `repo` (the project's, `owner/name`); null for anything else, or a bare number with no repo. */
export function githubIssueOf(sent: string | number, repo: string | null): string | null {
    const text = String(sent).trim()
    const link = text.match(/^https?:\/\/(?:www\.)?github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)\/?$/i)
    const full = text.match(/^([\w.-]+\/[\w.-]+)#(\d+)$/)
    const own = text.match(/^#?(\d+)$/)
    const [on, number] = link ? [link[1], link[2]] : full ? [full[1], full[2]] : own && repo ? [repo, own[1]] : []
    return on && Number(number) > 0 ? `${on}#${Number(number)}` : null
}

/** How a GitHub issue shows: `#523` on the project's repo, `owner/name#523` on another. */
export function githubIssueLabel(issue: string, repo: string | null): string {
    const at = issue.lastIndexOf('#')
    return repo && issue.slice(0, at).toLowerCase() === repo.toLowerCase() ? issue.slice(at) : issue
}

/** Where a GitHub issue (`owner/name#523`) opens. */
export function githubIssueUrl(issue: string): string {
    const at = issue.lastIndexOf('#')
    return `https://github.com/${issue.slice(0, at)}/issues/${issue.slice(at + 1)}`
}

/** A tracker link as `tracker` keeps it (ORR-404): one with `{id}` as it is; a link into a known tracker's workspace
 * (a team, project, view or a task of it, as an owner pastes one) as that workspace's task link; null for any other
 * link without `{id}`, which would open the same page for every task. */
export function trackerLinkOf(sent: string): string | null {
    const link = sent.trim()
    if (link.includes('{id}')) return link
    let url: URL
    try {
        url = new URL(link)
    } catch {
        return null
    }
    const workspace = url.pathname.split('/').filter(Boolean)[0]
    // linear.app/<workspace>/…: its tasks are at /<workspace>/issue/<id>.
    if (url.hostname === 'linear.app' && workspace) return `https://linear.app/${workspace}/issue/{id}`
    return null
}

/** An issue's reference, saying whose board it's on, for commit bodies and PR descriptions: `orrery-ada: DOC-132`. */
/** What each kind's full id starts with (ORR-674); an issue has the project's key already. */
const FULL_PREFIX = {issue: '', doc: 'doc-', chunk: 'chk-', preset: 'pst-', schedule: 'sch-'}
export type IdKind = keyof typeof FULL_PREFIX

/** The form of an id to paste anywhere: `ORR-660-x7k2m9qd`. `uid` is the board's random id, or the server's for what
 * belongs to the server, so on any other board or server it finds nothing. */
export const fullId = (kind: IdKind, id: string | number, uid: string) => `${FULL_PREFIX[kind]}${id}-${uid}`

/** The id inside a full one with this `uid`; null for anything else, a full id from another board included. */
export function shortId(kind: IdKind, id: string, uid: string): string | null {
    const [prefix, tail] = [FULL_PREFIX[kind], `-${uid}`]
    return uid && id.startsWith(prefix) && id.endsWith(tail) && id.length > prefix.length + tail.length
        ? id.slice(prefix.length, -tail.length) : null
}

/** Whether a doc's id reads as a full one, from any board: `doc-ideas-x7k2m9qd`. */
export const looksFullDoc = (id: string) => /^doc-.+-[a-z2-7]{8}$/.test(id)

export const issueRef = (handle: string, id: string) => `orrery-${handle.toLowerCase()}: ${id}`

/** A name as an id: lowercase letters, digits and dashes, at most 40 (a project's, a doc's). */
export function slugify(text: string): string {
    return text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '')
}

/** Three capitals from the name, e.g. `GRE` for Greenhouse. */
export function keyFor(name: string): string {
    const letters = name.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^[0-9]+/, '')
    return letters.slice(0, 3) || 'ISS'
}
