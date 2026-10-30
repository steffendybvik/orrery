import {describe, expect, it} from 'vitest'
import type {Repeat} from '../app/utils/schedule'
import {describe as words, ranSaid, toCron, toRepeat} from '../app/utils/schedule'

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

describe('what a run confirms (ORR-688)', () => {
    const at = '2026-10-30T15:00:00.000Z'

    it('goes by what the run returned', () => {
        expect(ranSaid({at, outcome: 'made', issue: 'VIN-4'})).toBe('Issue created: VIN-4')
        expect(ranSaid({at, outcome: 'sent', note: 'started a session (orrery-vineyard-abc)'})).toBe('Session started')
        expect(ranSaid({at, outcome: 'sent', note: 'started a locked-down session for it (orrery-vineyard-abc)'})).toBe('Session started')
        expect(ranSaid({at, outcome: 'sent', note: 'sent to 2 listening'})).toBe('Message sent to 2 listening')
        expect(ranSaid({at, outcome: 'sent', note: 'nobody listening; the next session to connect gets it'})).toBe('Message sent: nobody listening; the next session to connect gets it')
    })

    it('says why a run was skipped, and leaves a failure to the menu', () => {
        expect(ranSaid({at, outcome: 'skipped', note: "VIN-3 from the last run isn't done yet"})).toBe("Skipped: VIN-3 from the last run isn't done yet")
        expect(ranSaid({at, outcome: 'failed', note: 'no launcher'})).toBeNull()
    })
})
