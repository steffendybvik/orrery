import {describe, expect, it} from 'vitest'
import type {Repeat} from '../app/utils/schedule'
import {describe as words, toCron, toRepeat} from '../app/utils/schedule'

describe('schedule presets', () => {
    const presets: Repeat[] = [
        {kind: 'daily', time: '09:00'},
        {kind: 'weekdays', time: '07:30'},
        {kind: 'weekly', time: '10:30', days: [1, 3]},
        {kind: 'monthly', time: '08:00', day: 1},
        {kind: 'minutes', every: 15},
        {kind: 'hours', every: 2, minute: 0},
    ]

    it('come back as themselves from their cron', () => {
        for (const preset of presets) expect(toRepeat({cron: toCron(preset)!})).toEqual(preset)
    })

    it('read as words, and other crons as cron', () => {
        const say = (cron: string) => words({cron, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone})
        expect(say('*/15 * * * *')).toBe('Every 15 minutes')
        expect(say('0 */2 * * *')).toBe('Every 2 hours')
        expect(say('30 10 * * 1,3')).toBe('Mon, Wed at 10:30')
        expect(say('0 9 1 * *')).toBe('Monthly on the 1st at 09:00')
        expect(say('0 9 * 1 *')).toBe('Cron 0 9 * 1 *')
    })
})
