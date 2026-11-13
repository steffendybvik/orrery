// The Claude Code adapter (ORR-1074): everything the launcher does that is particular to Claude Code, so another agent's
// adapter can sit beside it (agents.mjs says what an adapter is). It never runs tmux itself: the launcher hands it the
// session's pane, which it reads and types into.
import {execFileSync} from 'node:child_process'
import {setUpUser, undoUser} from './claude-user-setup.mjs'
import {besideArgs, chatOnly, lockedDown, modelArgs, resumeArgs} from './locked-down.mjs'
import {ASYNC_EVENTS, HOOK_EVENTS} from './claude-hooks.mjs'
import {onYes} from './permission-prompt.mjs'
import {contextOf, contextWindow, effortOf, modelOf} from './transcript.mjs'

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

/** @type {import('./agents.mjs').Agent} */
export const claude = {
    name: 'claude',

    problem() {
        try {
            execFileSync('claude', ['--version'], {stdio: 'ignore'})
            return null
        } catch {
            return 'claude isn\'t on your PATH: install Claude Code, then run this again from the same shell'
        }
    },

    // It locks an untrusted launch down with no Bash, starts a chat as `chatOnly` says, starts a session on the model and
    // effort asked for, and takes a chat's Claude session up again (ORR-884): orrery gives each only to a launcher that does.
    claims: 'untrusted=no-bash&chat=yes&model=yes&resume=yes&global=yes',

    // What it's told as it starts (`told`, the repo it's in: ORR-1070) goes in its system prompt, so a `/clear` keeps it.
    // A session can have orrery's `/mcp` beside its channel (ORR-1102): `beside`, from mcp-beside.mjs.
    mcpBeside: true,

    command({dir, server, launch, mode, told, beside}) {
        return ['claude', '--dangerously-load-development-channels', `server:${server}`,
            ...launch.untrusted ? lockedDown(dir, server, beside) : launch.chat ? chatOnly(dir, server, beside) : ['--permission-mode', mode, ...besideArgs(beside)],
            ...modelArgs(launch), ...resumeArgs(launch), ...told ? ['--append-system-prompt', told] : []]
    },

    // Claude Code's startup prompts: the channel flag's warning it accepts; a folder not yet trusted it won't answer for
    // the owner, so the session is stopped and the owner told.
    async getPast(pane, {dir}) {
        for (let tries = 0; tries < 60; tries++) {
            await wait(500)
            const screen = pane.read()
            if (/trust (the files in )?this folder/i.test(screen)) return {stop: `the folder isn't trusted yet: run claude in ${dir} once by hand and accept it`}
            if (screen.includes('Loading development channels') && screen.includes('I am using this for local development')) {
                pane.press('Enter')
                return {}
            }
        }
        return {stuck: "didn't see the channel's warning"}
    },

    // Only while the pane still shows a permission prompt with the cursor on a plain "Yes" (ORR-489, ORR-750), so a late
    // Allow or Deny can't answer another prompt.
    allow(pane) {
        if (!onYes(pane.read())) return false
        pane.press('Enter')
        return true
    },

    deny(pane) {
        if (!onYes(pane.read())) return false
        pane.press('Escape')
        return true
    },

    // Context, from its hook: the tokens the latest reply in its transcript was given (input, cache read and cache
    // written), against the window Claude Code's table of models gives its model.
    context(hook) {
        const tokens = contextOf(hook)
        return tokens === undefined ? undefined : {tokens, window: contextWindow(modelOf(hook), tokens)}
    },

    window: contextWindow,

    // The hook events orrery's hook is registered for, and those of them that run in the background (claude-hooks.mjs).
    hooks: {events: HOOK_EVENTS, background: ASYNC_EVENTS},

    // Its hook's input, as orrery's session report. Claude Code's events are the report's own names, but for a
    // Notification, which it says in words: one asking for a permission is the session waiting, any other one it idle.
    report(hook) {
        const name = hook.hook_event_name
        const context = claude.context(hook)
        return {
            id: hook.session_id,
            cwd: hook.cwd,
            event: name === 'Notification' ? (/permission|approv|allow/i.test(hook.message ?? '') ? 'waiting' : 'idle') : name ?? 'idle',
            // What it waits for, which the Sessions page shows.
            message: hook.message,
            // `clear` on SessionEnd keeps the window; SessionStart's `source` says if the context was cleared or compacted.
            reason: hook.reason,
            source: hook.source,
            // StopFailure's: why the turn was cut off (`rate_limit`, `overloaded`, `server_error`…).
            error: hook.error,
            // And what Claude Code told it, which says when a usage limit resets.
            error_text: name === 'StopFailure' && typeof hook.last_assistant_message === 'string' ? hook.last_assistant_message.slice(0, 300) : undefined,
            // Which issues it's about to write to: an owner's comment on one goes to this session.
            command: name === 'PreToolUse' && hook.tool_name === 'Bash' ? String(hook.tool_input?.command ?? '').slice(0, 4000) : undefined,
            // The tool it's about to use, or asks permission for, in a line: what the owner's prompt says it wants.
            tool: hook.tool_name ? {name: String(hook.tool_name).slice(0, 200), detail: toolDetail(hook.tool_name, hook.tool_input)} : undefined,
            // The model it runs on (ORR-871), and the effort level, when its hook says (ORR-894).
            model: modelOf(hook),
            effort: effortOf(hook),
            // And how much context it carries, after a turn and on tool events (ORR-968), against its model's window.
            context: context?.tokens,
            window: context?.window,
        }
    },

    // `/clear`, typed: its channel stays, and its hooks hand the new context what's left to do.
    async clear(pane) {
        pane.type('/clear')
        await wait(300)
        pane.press('Enter')
    },

    // The install line's part (ORR-1067): orrery in Claude Code's user config, for every folder, and the default folder
    // trusted; `--uninstall` takes it out again.
    setUp({url, orrery, commands, home, mcp}) {
        return setUpUser({url, orrery, commands, home, mcp, run: claudeRun})
    },

    undo({homeOf}) {
        return undoUser({run: claudeRun, homeOf})
    },
}

const claudeRun = args => execFileSync('claude', args, {stdio: ['ignore', 'ignore', 'pipe']})

/** What a tool would do, short: the command, the file, the address or the search. Never a file's contents or
 * anything else from its input: an MCP tool's arguments can hold anything, so it goes by its name alone. */
function toolDetail(name, input) {
    const field = {
        Bash: 'command', Edit: 'file_path', MultiEdit: 'file_path', Write: 'file_path', Read: 'file_path',
        NotebookEdit: 'notebook_path', WebFetch: 'url', WebSearch: 'query', Glob: 'pattern', Grep: 'pattern',
    }[name]
    const value = field ? input?.[field] : undefined
    return typeof value === 'string' && value ? value.slice(0, 300) : undefined
}
