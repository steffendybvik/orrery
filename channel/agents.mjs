// The agents the launcher can start (ORR-1074). An adapter is how an agent plugs into it: the launcher keeps what isn't
// particular to one (the service, claiming launches, tmux sessions and taking them back, stop times, the projects it
// serves) and asks the adapter for the rest. Claude Code's is the only one so far (claude-agent.mjs). An agent the
// launcher doesn't start meets orrery only through its REST API and MCP tools.
import {claude} from './claude-agent.mjs'

/**
 * A session's tmux pane, as the launcher hands it to an adapter.
 * @typedef {object} Pane
 * @property {() => string} read what the pane shows, as text
 * @property {(text: string) => void} type types text, literally
 * @property {(key: string) => void} press presses a key (tmux's names: Enter, Escape)
 */

/**
 * @typedef {object} Agent
 * @property {string} name
 * @property {() => string | null} problem why it can't be started on this machine (not installed), or null
 * @property {string} claims what its sessions can be started as, sent with each claim, so orrery offers a launch only to
 *   a launcher whose agent does what it asks
 * @property {(start: {dir: string, server: string, launch: object, mode: string, told?: string}) => string[]} command what
 *   starts a launch's session in its folder, with the channel `server`, run as separate words, never through a shell;
 *   `told` is what orrery tells it as it starts (the repo it's in), for the session to keep past a fresh context
 * @property {(pane: Pane, at: {dir: string}) => Promise<{stop?: string, stuck?: string}>} getPast gets a new session past
 *   its startup prompts: `stop` when it must be stopped, and why; `stuck` when it may be waiting on one
 * @property {(pane: Pane) => boolean} allow answers yes once to the permission prompt it shows; false when it shows none
 * @property {(pane: Pane) => boolean} deny answers no once the same way
 * @property {(pane: Pane) => Promise<void>} clear gives it a fresh context between pieces of work
 * @property {(report: object) => {tokens: number, window: number} | undefined} context how much context it carries, from
 *   what it reports (Claude Code's hook input): the tokens in use and its model's window; nothing when it can't tell, so
 *   it gets no meter rather than a wrong one
 * @property {(at: {url: string, orrery: {id: string, environment?: string}, commands: object, home?: string, mcp?: boolean}) => {server: string}} setUp
 *   puts orrery into the agent's own user-level config for every folder (the install line, ORR-1067), with its `/mcp`
 *   beside the channel when it serves that (`mcp`, ORR-1102), and trusts the default folder `home`; safe to run again
 * @property {(at: {homeOf: (id: string) => string}) => string[]} undo takes out what `setUp` put in, for every orrery
 * @property {(model: string | undefined, tokens: number) => number} window its model's window, for a report that gave
 *   tokens alone (a hook from before the adapter said the window)
 * @property {{events: string[], background: string[]}} hooks the agent's hook events orrery's hook is registered for, and
 *   those of them that run in the background, so they never hold it up
 * @property {(hook: object) => Report} report what its hook's input says, as orrery's session report: the hook posts that
 *   to `/api/sessions`, so the hook itself knows nothing of the agent
 */

/**
 * What a session's hook tells orrery (`POST /api/sessions`, docs/API.md), as an adapter reads it off its agent's hook.
 * @typedef {object} Report
 * @property {string} [id] the agent's id for the session
 * @property {string} [cwd] the folder it runs in
 * @property {string} event what happened: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `Stop`,
 *   `StopFailure` or `SessionEnd`, or a state (`working`, `idle`, `waiting`) for anything else
 * @property {string} [source] on `SessionStart`, what started it: `startup`, `resume`, `clear` (a fresh context in the same
 *   window) or `compact` (its context compacted)
 * @property {string} [reason] on `SessionEnd`, why: `clear` keeps the window, which starts again under a new id
 * @property {string} [message] what it waits for, when `waiting`
 * @property {string} [error] on `StopFailure`, why the turn was cut off, with `error_text`, what the agent said of it
 * @property {string} [error_text]
 * @property {string} [command] on `PreToolUse`, the shell command it's about to run, to see which issues it writes to
 * @property {{name: string, detail?: string}} [tool] the tool it's about to use or asks permission for
 * @property {string} [model] the model it runs on
 * @property {string} [effort] the effort it runs at
 * @property {number} [context] the tokens its context holds, with `window`, its model's
 * @property {number} [window]
 */

const AGENTS = {claude}

/** The adapter for an agent by name; Claude Code's when none is named. */
export function agentFor(name = 'claude') {
    const agent = AGENTS[name]
    if (!agent) throw new Error(`no agent ${name}: the launcher starts ${Object.keys(AGENTS).join(', ')}`)
    return agent
}
