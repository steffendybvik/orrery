// Checks a request's JSON body against the fields a route takes. Unknown fields are refused, as in
// the roadmap file, so a typo comes back as a 400 that names it instead of being dropped.
import {randomBytes} from 'node:crypto'
import {createError} from 'h3'
import type {Instruction} from '#shared/prompt'

export interface Field {
    /** `strings` is a list of strings, such as labels; `lines` a list of `{id?, text, on?}`, such as standing
     * instructions (a new one gets an id, and is on unless it says not). */
    type: 'string' | 'number' | 'boolean' | 'strings' | 'lines'
    required?: boolean
    /** Null clears the field (a plan, a parent). */
    nullable?: boolean
    values?: readonly string[]
    pattern?: RegExp
    /** Says what `pattern` wants. */
    hint?: string
}

export type Input = Record<string, string | number | boolean | string[] | Instruction[] | null | undefined>

/** `partial` is an update: nothing is required. */
export function checkInput(body: unknown, spec: Record<string, Field>, partial = false): Input {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw badRequest('The body should be a JSON object')
    const problems: string[] = []
    const input: Input = {}
    for (const key of Object.keys(body)) {
        if (!(key in spec)) problems.push(`unknown field "${key}"; this takes ${Object.keys(spec).join(', ')}`)
    }
    for (const [key, field] of Object.entries(spec)) {
        const value = (body as Record<string, unknown>)[key]
        if (value === undefined) {
            if (field.required && !partial) problems.push(`missing "${key}"`)
            continue
        }
        if (value === null) {
            if (field.nullable) input[key] = null
            else problems.push(`"${key}" can't be null`)
            continue
        }
        if (field.type === 'lines') {
            const lines = Array.isArray(value) ? value.map(line => {
                if (typeof line !== 'object' || line === null || typeof line.text !== 'string' || !line.text.trim()) return null
                if ((line.id !== undefined && typeof line.id !== 'string') || (line.on !== undefined && typeof line.on !== 'boolean')) return null
                return {id: line.id || randomBytes(4).toString('hex'), text: line.text.trim(), on: line.on ?? true}
            }) : [null]
            if (lines.every(line => line)) input[key] = lines as Instruction[]
            else problems.push(`"${key}" should be a list of {text, on?, id?}, not ${JSON.stringify(value)}`)
            continue
        }
        if (field.type === 'strings') {
            if (Array.isArray(value) && value.every(v => typeof v === 'string' && v.trim())) input[key] = [...new Set(value.map(v => v.trim()))]
            else problems.push(`"${key}" should be a list of strings, not ${JSON.stringify(value)}`)
            continue
        }
        if (typeof value !== field.type) {
            problems.push(`"${key}" should be ${field.type === 'string' ? 'a string' : `a ${field.type}`}, not ${JSON.stringify(value)}`)
            continue
        }
        if (typeof value === 'string') {
            if (field.values && !field.values.includes(value)) {
                problems.push(`"${key}" is "${value}", not one of ${field.values.join(', ')}${field.nullable ? ' (or null)' : ''}`)
                continue
            }
            if (field.pattern && !field.pattern.test(value)) {
                problems.push(`"${key}" is "${value}"; ${field.hint ?? `it should match ${field.pattern}`}`)
                continue
            }
            if (field.required && !value.trim()) {
                problems.push(`"${key}" can't be empty`)
                continue
            }
        }
        input[key] = value as string | number | boolean
    }
    if (problems.length) throw badRequest(problems.length === 1 ? problems[0]! : `${problems.length} problems in the body`, problems)
    return input
}

export function badRequest(message: string, problems: string[] = [message]) {
    return createError({statusCode: 400, statusMessage: 'Bad Request', message, data: {problems}})
}

export function notFound(message: string) {
    return createError({statusCode: 404, statusMessage: 'Not Found', message})
}

export function forbidden(message: string) {
    return createError({statusCode: 403, statusMessage: 'Forbidden', message})
}

export function conflict(message: string) {
    return createError({statusCode: 409, statusMessage: 'Conflict', message})
}
