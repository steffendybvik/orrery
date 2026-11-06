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
export function lastReply(path) {
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

function tokensOf(usage) {
    if (!usage || typeof usage !== 'object') return undefined
    const parts = [usage.input_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens]
    if (!parts.some(n => Number.isFinite(n))) return undefined
    return parts.reduce((sum, n) => sum + (Number.isFinite(n) && n > 0 ? n : 0), 0)
}
