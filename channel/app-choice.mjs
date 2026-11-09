// Which orrery a `claude` opened by hand reports to, when its folder is linked to none (ORR-1080). With several orrerys
// set up on the machine (personal and work, say), each has a user-level server and hook of its own, and every one runs
// in every session. A session that never calls an orrery tool is left alone. On its first call in such a folder the
// tool doesn't run: it says to choose an app, Claude asks the user, and `choose_app` writes the choice to a small file
// named by the Claude session's id. Every orrery's server and hook reads that file, so from then on the session's calls
// and its reports go to the chosen orrery only, and the others refuse, saying which one it chose.
import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs'
import {homedir} from 'node:os'
import {dirname, join} from 'node:path'
import {claudeFiles, userServers} from './claude-user-setup.mjs'

const SESSION_ID = /^[A-Za-z0-9_-]{1,100}$/

/** Where the choice for Claude session `session` is kept, beside the launcher's list and the keys. */
export const choiceFile = (session, env = process.env) =>
    join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'orrery', 'apps', `${session}.json`)

/** The orrery session `session` chose: `{id, url, environment?, project?}`, or none. */
export function readChoice(session, env = process.env) {
    if (!SESSION_ID.test(session ?? '')) return undefined
    try {
        const choice = JSON.parse(readFileSync(choiceFile(session, env), 'utf8'))
        return typeof choice?.id === 'string' ? choice : undefined
    } catch {
        return undefined
    }
}

/** Records the orrery (and project, if any) session `session` chose, in one go by a rename. */
export function writeChoice(session, {id, url, environment, project}, env = process.env) {
    if (!SESSION_ID.test(session ?? '')) throw new Error("This session's Claude id isn't known, so its choice can't be kept: start it again with an up-to-date Claude Code")
    const path = choiceFile(session, env)
    mkdirSync(dirname(path), {recursive: true})
    const next = `${path}.${process.pid}.part`
    writeFileSync(next, `${JSON.stringify({id, url, ...environment ? {environment} : {}, ...project ? {project} : {}, at: new Date().toISOString()})}\n`, {mode: 0o600})
    renameSync(next, path)
}

/** The orrerys set up on this machine for every folder (the install line's user-level servers): `{name, id, url}`. */
export function appsHere(files = claudeFiles()) {
    let state = {}
    try {
        if (existsSync(files.state)) state = JSON.parse(readFileSync(files.state, 'utf8'))
    } catch {
        return []
    }
    return userServers(state).map(({name, id}) => ({name, id, url: state.mcpServers[name]?.env?.ORRERY_URL}))
        .filter(app => app.id && app.url)
}

/** Whether a session has to choose its orrery, and what it chose (ORR-1080). Only the user-level server or hook
 * (ORRERY_SCOPE=user) in a session orrery didn't start, in a folder the launcher's list links to no project (`linked`),
 * with more than one orrery set up here (`apps`), asks. Returns `{state}`: `free` (nothing to choose: carry on as
 * before), `unchosen` (ask first), `mine` (this orrery was chosen; `project` if one was) or `other` (another was:
 * refuse, naming it). */
export function choiceFor({env = process.env, session = env.CLAUDE_CODE_SESSION_ID, linked, apps = appsHere()}) {
    if (env.ORRERY_SCOPE !== 'user' || env.ORRERY_STARTED || linked) return {state: 'free'}
    // The hook can name two ids for one session (its input's, which a `/clear` renews, and the one Claude Code started
    // its servers with), so either finds the choice.
    const choice = [session].flat().map(id => readChoice(id, env)).find(Boolean)
    if (choice) return choice.id === env.ORRERY_ID ? {state: 'mine', project: choice.project} : {state: 'other', choice}
    if (apps.length < 2) return {state: 'free'}
    return {state: 'unchosen', apps}
}

/** What a tool answers before an app is chosen: the orrerys to pick from, and how. */
export const askToChoose = apps => [
    "This folder isn't linked to an orrery, and this machine has several, so this session has to choose one before its first orrery call.",
    `Ask the user which (${apps.map(app => `${app.name} at ${app.url}`).join('; ')}) and whether this folder is for one of its projects, then call choose_app with their answer.`,
].join(' ')

/** What another orrery's tools answer once the session chose one. */
export const choseOther = ({environment, url, id}) =>
    `This session chose ${environment ? `${environment} (${url})` : url ?? id} as its orrery, so this one won't be read or written from it. Use that orrery's tools instead.`

/** The app `name` (a server's name, its environment, its id or its address) among `apps`, or none. */
export function appNamed(apps, name) {
    const wanted = String(name ?? '').trim().toLowerCase()
    if (!wanted) return undefined
    return apps.find(app => [app.name, app.name.replace(/^orrery-/, ''), app.id, app.url?.replace(/\/+$/, '')]
        .some(said => said?.toLowerCase() === wanted.replace(/\/+$/, '')))
}
