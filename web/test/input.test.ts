import {describe, expect, it} from 'vitest'
import type {Field} from '../server/utils/input'
import {checkInput} from '../server/utils/input'

const SPEC: Record<string, Field> = {
    title: {type: 'string', required: true},
    plan: {type: 'string', nullable: true, values: ['now', 'next']},
    icon: {type: 'string', pattern: /^[a-z]+$/, hint: "use a Heroicon's name"},
    position: {type: 'number'},
    done: {type: 'boolean'},
    labels: {type: 'strings', nullable: true},
    instructions: {type: 'lines'},
}

/** The problems a body is refused with. */
function problems(body: unknown, partial = false): string[] {
    try {
        checkInput(body, SPEC, partial)
    } catch (error) {
        const {statusCode, data} = error as {statusCode: number, data: {problems: string[]}}
        expect(statusCode).toBe(400)
        return data.problems
    }
    throw new Error('it was not refused')
}

describe('a request body', () => {
    it("refuses an object's own built-in names as fields", () => {
        expect(problems({title: 'Pantry', constructor: 1, toString: 'x'})).toEqual([
            'unknown field "constructor"; this takes title, plan, icon, position, done, labels, instructions',
            'unknown field "toString"; this takes title, plan, icon, position, done, labels, instructions',
        ])
    })

    it('keeps the fields it takes, as sent', () => {
        expect(checkInput({title: 'Pantry', position: 2, done: false, plan: 'now'}, SPEC)).toEqual({title: 'Pantry', position: 2, done: false, plan: 'now'})
    })

    it('is an object', () => {
        for (const body of [null, 'Pantry', ['Pantry']]) expect(problems(body)).toHaveLength(1)
    })

    it('names an unknown field, so a typo is a 400 and not dropped', () => {
        expect(problems({title: 'Pantry', tittle: 'x'}).join()).toContain('tittle')
    })

    it('needs what is required, unless it is an update', () => {
        expect(problems({})).toEqual(['missing "title"'])
        expect(checkInput({}, SPEC, true)).toEqual({})
        expect(problems({title: '  '})).toEqual([`"title" can't be empty`])
    })

    it('clears a nullable field with null, and refuses null elsewhere', () => {
        expect(checkInput({title: 'A', plan: null}, SPEC)).toEqual({title: 'A', plan: null})
        expect(problems({title: 'A', position: null})).toEqual([`"position" can't be null`])
    })

    it('says what type a field should be', () => {
        expect(problems({title: 'A', position: '2'})).toEqual(['"position" should be a number, not "2"'])
        expect(problems({title: 3})).toEqual(['"title" should be a string, not 3'])
    })

    it('keeps a string to its values and its pattern, with the hint', () => {
        expect(problems({title: 'A', plan: 'later'})).toEqual(['"plan" is "later", not one of now, next (or null)'])
        expect(problems({title: 'A', icon: 'Cart!'})).toEqual([`"icon" is "Cart!"; use a Heroicon's name`])
    })

    it('trims a list of strings and drops repeats', () => {
        expect(checkInput({title: 'A', labels: [' ui ', 'ui', 'api']}, SPEC).labels).toEqual(['ui', 'api'])
        expect(problems({title: 'A', labels: ['ui', '']})).toHaveLength(1)
        expect(problems({title: 'A', labels: 'ui'})).toHaveLength(1)
    })

    it('gives a new line an id and turns it on, keeping what it says', () => {
        const [made, kept] = checkInput({title: 'A', instructions: [{text: ' commit often '}, {id: 'x1', text: 'test', on: false}]}, SPEC).instructions as {id: string, text: string, on: boolean}[]
        expect(made).toMatchObject({text: 'commit often', on: true})
        expect(made!.id).toMatch(/^[0-9a-f]{8}$/)
        expect(kept).toEqual({id: 'x1', text: 'test', on: false})
        for (const instructions of ['commit', [{text: ''}], [{text: 'a', on: 'yes'}], [{text: 'a', id: 3}], [null]])
            expect(problems({title: 'A', instructions})).toHaveLength(1)
    })

    it('counts the problems when there are several, listing each', () => {
        try {
            checkInput({position: 'x', done: 1}, SPEC)
        } catch (error) {
            const {message, data} = error as {message: string, data: {problems: string[]}}
            expect(message).toBe('3 problems in the body')
            expect(data.problems).toHaveLength(3)
            return
        }
        throw new Error('it was not refused')
    })
})
