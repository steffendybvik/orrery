// What the hook reads off a Claude Code session's transcript: the model it runs on (ORR-871).
import {closeSync, fstatSync, openSync, readSync} from 'node:fs'

/** The model the session runs on (ORR-871): what `SessionStart` says, when it says, else after a turn (`Stop`) and on
 * tool events the latest reply's in its transcript, so a `/model` switch shows too, and a session that started before
 * its hook did still gets its window right (ORR-993). Only the transcript's end is read, so a long one
 * stays quick. Nothing when it can't tell. */
export function modelOf(hook) {
    const given = typeof hook.model === 'string' ? hook.model : hook.model?.id
    if (typeof given === 'string' && given) return given
    if (!CONTEXT_EVENTS.includes(hook.hook_event_name) || typeof hook.transcript_path !== 'string') return undefined
    return lastModel(hook.transcript_path)
}

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

/** The effort level the session runs at (ORR-894), as its hook says on tool events (`effort`, or `effort.level`), so an
 * `/effort` switch shows too. Nothing when it doesn't say. */
export function effortOf(hook) {
    const given = typeof hook.effort === 'string' ? hook.effort : hook.effort?.level
    return EFFORTS.includes(given) ? given : undefined
}

const TAIL = 256 * 1024

/** How much context the session carries (ORR-968): the tokens the latest reply was given, which every turn pays for
 * again, read off its transcript after a turn (`Stop`) and on tool events, so it updates as a turn goes. Nothing when
 * it can't tell. */
export function contextOf(hook) {
    if (!CONTEXT_EVENTS.includes(hook.hook_event_name) || typeof hook.transcript_path !== 'string') return undefined
    return lastReply(hook.transcript_path)?.tokens
}

const CONTEXT_EVENTS = ['Stop', 'PreToolUse']

/** The model of the latest assistant reply in a transcript (one JSON entry a line), or nothing. */
export function lastModel(path) {
    return lastReply(path)?.model
}

/** The latest assistant reply in a transcript: its model, and the tokens it was given (input, cache read and cache
 * written: the whole context), when its usage says. Nothing when there's none. */
function lastReply(path) {
    let fd
    try {
        fd = openSync(path, 'r')
        const size = fstatSync(fd).size
        const length = Math.min(size, TAIL)
        const buffer = Buffer.alloc(length)
        readSync(fd, buffer, 0, length, size - length)
        const lines = buffer.toString('utf8').split('\n')
        for (let i = lines.length - 1; i >= 0; i--) {
            if (!lines[i].includes('"model"')) continue
            try {
                const entry = JSON.parse(lines[i])
                const message = entry?.type === 'assistant' ? entry.message : undefined
                const model = message?.model
                // A reply Claude Code makes up itself (an error, an interruption) is `<synthetic>`, no model's.
                if (typeof model === 'string' && model && !model.startsWith('<')) return {model, tokens: tokensOf(message.usage)}
            } catch {
                // The first line read can start mid-entry.
            }
        }
    } catch {
        // No transcript yet, or it can't be read: say nothing.
    } finally {
        if (fd !== undefined) closeSync(fd)
    }
    return undefined
}

/** A model's context window in tokens (ORR-968, ORR-993), as Claude Code's own table of models has it: 1M for a `[1m]`
 * id and for the models whose window is 1M as they are (every Claude 5 model, and Opus 4.7 on), whose ids don't say so;
 * 200k for the older ones. A model it can't tell (none said yet, or an id it can't read) is on Claude Code's default,
 * which is 1M. More than 200k in use is 1M whatever the model. */
export function contextWindow(model, tokens) {
    if (tokens > 200_000 || /\[1m\]/i.test(model ?? '')) return 1_000_000
    // Claude 3's ids put the version first (`claude-3-5-sonnet`): all 200k.
    if (/claude-\d/i.test(model ?? '')) return 200_000
    const match = /claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?!\d)/i.exec(model ?? '')
    if (!match) return 1_000_000
    const [, family, major, minor] = match
    const version = Number(major) + Number(minor ?? 0) / 100
    if (version >= 5) return 1_000_000
    return family.toLowerCase() === 'opus' && version >= 4.07 ? 1_000_000 : 200_000
}

function tokensOf(usage) {
    if (!usage || typeof usage !== 'object') return undefined
    const parts = [usage.input_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens]
    if (!parts.some(n => Number.isFinite(n))) return undefined
    return parts.reduce((sum, n) => sum + (Number.isFinite(n) && n > 0 ? n : 0), 0)
}
