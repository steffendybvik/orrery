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
 * @property {(start: {dir: string, server: string, launch: object, mode: string}) => string[]} command what starts a
 *   launch's session in its folder, with the channel `server`, run as separate words, never through a shell
 * @property {(pane: Pane, at: {dir: string}) => Promise<{stop?: string, stuck?: string}>} getPast gets a new session past
 *   its startup prompts: `stop` when it must be stopped, and why; `stuck` when it may be waiting on one
 * @property {(pane: Pane) => boolean} allow answers yes once to the permission prompt it shows; false when it shows none
 * @property {(pane: Pane) => boolean} deny answers no once the same way
 * @property {(pane: Pane) => Promise<void>} clear gives it a fresh context between pieces of work
 * @property {(report: object) => {tokens: number, window: number} | undefined} context how much context it carries, from
 *   what it reports (Claude Code's hook input): the tokens in use and its model's window; nothing when it can't tell, so
 *   it gets no meter rather than a wrong one
 * @property {(model: string | undefined, tokens: number) => number} window its model's window, for a report that gave
 *   tokens alone (a hook from before the adapter said the window)
 */

const AGENTS = {claude}

/** The adapter for an agent by name; Claude Code's when none is named. */
export function agentFor(name = 'claude') {
    const agent = AGENTS[name]
    if (!agent) throw new Error(`no agent ${name}: the launcher starts ${Object.keys(AGENTS).join(', ')}`)
    return agent
}
