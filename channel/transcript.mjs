// What the hook reads off a Claude Code session's transcript: the model it runs on (ORR-871).
import {closeSync, fstatSync, openSync, readSync} from 'node:fs'

/** The model the session runs on (ORR-871): what `SessionStart` says, when it says, else after a turn (`Stop`) the
 * latest reply's in its transcript, so a `/model` switch shows too. Only the transcript's end is read, so a long one
 * stays quick. Nothing when it can't tell. */
export function modelOf(hook) {
    const given = typeof hook.model === 'string' ? hook.model : hook.model?.id
    if (typeof given === 'string' && given) return given
    if (hook.hook_event_name !== 'Stop' || typeof hook.transcript_path !== 'string') return undefined
    return lastModel(hook.transcript_path)
}

const TAIL = 256 * 1024

/** The model of the latest assistant reply in a transcript (one JSON entry a line), or nothing. */
export function lastModel(path) {
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
                const model = entry?.type === 'assistant' ? entry.message?.model : undefined
                // A reply Claude Code makes up itself (an error, an interruption) is `<synthetic>`, no model's.
                if (typeof model === 'string' && model && !model.startsWith('<')) return model
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
