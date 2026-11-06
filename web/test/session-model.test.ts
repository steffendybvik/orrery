import {mkdtempSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'
import {contextOf, effortOf, lastModel, modelOf} from '../../channel/transcript.mjs'
import {contextWindow, modelLabel} from '../shared/roadmap'

// Each session's model on the Sessions page (ORR-871): the hook reads it off the session's transcript, the latest
// reply's, and the page names it as people say it.
const dir = mkdtempSync(join(tmpdir(), 'orrery-model-'))
const transcript = (name: string, lines: unknown[]) => {
    const path = join(dir, name)
    writeFileSync(path, lines.map(l => typeof l === 'string' ? l : JSON.stringify(l)).join('\n') + '\n')
    return path
}
const reply = (model: string) => ({type: 'assistant', message: {role: 'assistant', model, content: []}})

describe("a session's model, from its transcript", () => {
    it('is the latest reply\'s, so a /model switch shows after the next turn', () => {
        const path = transcript('switched.jsonl', [{type: 'user', message: {content: 'hi'}}, reply('claude-opus-5-5'), {type: 'user'}, reply('claude-sonnet-5-5')])
        expect(lastModel(path)).toBe('claude-sonnet-5-5')
    })

    it('passes over a reply Claude Code made up itself, and a line cut in half', () => {
        const path = transcript('synthetic.jsonl', ['{"type":"assistant","message":{"model":"claude-', reply('claude-haiku-5-5'), reply('<synthetic>'), {type: 'user', model: 'not a reply'}])
        expect(lastModel(path)).toBe('claude-haiku-5-5')
    })

    it('says nothing with no transcript, or none with a reply yet', () => {
        expect(lastModel(join(dir, 'missing.jsonl'))).toBeUndefined()
        expect(lastModel(transcript('fresh.jsonl', [{type: 'user', message: {content: 'hi'}}]))).toBeUndefined()
    })

    it('takes what SessionStart says first, and reads the transcript on Stop and tool events', () => {
        const path = transcript('stop.jsonl', [reply('claude-opus-5-5')])
        expect(modelOf({hook_event_name: 'SessionStart', model: 'claude-fable-5-1'})).toBe('claude-fable-5-1')
        expect(modelOf({hook_event_name: 'SessionStart', model: {id: 'claude-fable-5-1'}})).toBe('claude-fable-5-1')
        expect(modelOf({hook_event_name: 'PreToolUse', transcript_path: path})).toBe('claude-opus-5-5')
        expect(modelOf({hook_event_name: 'UserPromptSubmit', transcript_path: path})).toBeUndefined()
        expect(modelOf({hook_event_name: 'Stop', transcript_path: path})).toBe('claude-opus-5-5')
    })
})

describe("a session's effort level, from its hook (ORR-894)", () => {
    it('takes a level as a word or as effort.level, and nothing else', () => {
        expect(effortOf({hook_event_name: 'PreToolUse', effort: 'high'})).toBe('high')
        expect(effortOf({hook_event_name: 'PreToolUse', effort: {level: 'xhigh'}})).toBe('xhigh')
        expect(effortOf({hook_event_name: 'PreToolUse', effort: 'extreme'})).toBeUndefined()
        expect(effortOf({hook_event_name: 'Stop'})).toBeUndefined()
    })
})

describe("a session's context, from its transcript (ORR-968)", () => {
    const used = (usage: object) => ({type: 'assistant', message: {role: 'assistant', model: 'claude-opus-5-5', usage, content: []}})

    it('is the whole input of the latest reply: input, cache read and cache written', () => {
        const path = transcript('usage.jsonl', [used({input_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 3}), {type: 'user'},
            used({input_tokens: 10, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 2_000, output_tokens: 500})])
        expect(contextOf({hook_event_name: 'Stop', transcript_path: path})).toBe(42_010)
        expect(contextOf({hook_event_name: 'PreToolUse', transcript_path: path})).toBe(42_010)
    })

    it('says nothing on other events, or for a reply with no usage', () => {
        const path = transcript('no-usage.jsonl', [reply('claude-opus-5-5')])
        expect(contextOf({hook_event_name: 'Stop', transcript_path: path})).toBeUndefined()
        expect(contextOf({hook_event_name: 'UserPromptSubmit', transcript_path: path})).toBeUndefined()
        expect(contextOf({hook_event_name: 'Stop'})).toBeUndefined()
    })
})

describe("a model's name, as people say it", () => {
    it.each([
        ['claude-opus-5-5', 'Opus 5.5'],
        ['claude-sonnet-5', 'Sonnet 5'],
        ['claude-haiku-5-5-20260101', 'Haiku 5.5'],
        ['claude-fable-5-1', 'Fable 5.1'],
        ['claude-opus-5-5[1m]', 'Opus 5.5 · 1M'],
        ['anthropic.claude-sonnet-5-5-v1:0', 'Sonnet 5.5'],
        ['some-other-model', 'some-other-model'],
    ])('%s is %s', (id, label) => expect(modelLabel(id)).toBe(label))
})

describe("a model's context window, as Claude Code's table of models has it (ORR-993)", () => {
    it.each([
        ['claude-opus-5-5', 1_000_000],
        ['claude-sonnet-5-5', 1_000_000],
        ['claude-haiku-5-5-20260101', 1_000_000],
        ['claude-fable-5-1', 1_000_000],
        ['us.anthropic.claude-opus-5-5', 1_000_000],
        ['claude-opus-4-7', 1_000_000],
        ['claude-opus-4-6', 200_000],
        ['claude-opus-4-20250514', 200_000],
        ['claude-sonnet-4-6', 200_000],
        ['claude-sonnet-4-6[1m]', 1_000_000],
        ['claude-haiku-4-5-20251001', 200_000],
        ['claude-3-5-sonnet-20241022', 200_000],
        ['some-other-model', 1_000_000],
        [undefined, 1_000_000],
    ])('%s is %i', (model, window) => expect(contextWindow(model, 10_000)).toBe(window))

    it('is 1M once more than 200k is in use, whatever the model', () => {
        expect(contextWindow('claude-sonnet-4-6', 200_000)).toBe(200_000)
        expect(contextWindow('claude-sonnet-4-6', 200_001)).toBe(1_000_000)
    })
})
