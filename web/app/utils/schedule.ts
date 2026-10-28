import {Cron} from 'croner'
import type {OnFilter} from '#shared/happenings'
import {COMMON_EVENTS} from '#shared/happenings'
import type {Schedule} from '#shared/roadmap'

// When a schedule runs, as the dialog's presets and in words. The presets are crons of a known shape:
// every day, weekdays, some days of the week, a day of the month (each at a time), or every N minutes or hours. Or it
// runs on an event (ORR-341), said by its label.

export type Repeat =
    | {kind: 'daily' | 'weekdays', time: string}
    | {kind: 'weekly', time: string, days: number[]}
    | {kind: 'monthly', time: string, day: number}
    | {kind: 'minutes', every: number}
    | {kind: 'hours', every: number, minute: number}
    | {kind: 'once', at: string}
    | {kind: 'cron', cron: string}

export const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const pad = (n: number) => String(n).padStart(2, '0')
const hm = (time: string) => time.split(':').map(Number) as [number, number]

/** The cron a preset stands for (none for `once`). */
export function toCron(repeat: Repeat): string | null {
    if (repeat.kind === 'once') return null
    if (repeat.kind === 'cron') return repeat.cron.trim()
    if (repeat.kind === 'minutes') return `*/${repeat.every} * * * *`
    if (repeat.kind === 'hours') return `${repeat.minute} */${repeat.every} * * *`
    const [h, m] = hm(repeat.time)
    if (repeat.kind === 'weekly') return `${m} ${h} * * ${[...repeat.days].sort().join(',') || '1'}`
    if (repeat.kind === 'monthly') return `${m} ${h} ${repeat.day} * *`
    return repeat.kind === 'weekdays' ? `${m} ${h} * * 1-5` : `${m} ${h} * * *`
}

/** The preset a schedule's time is, or `cron` when it's none of them. */
export function toRepeat(schedule: Pick<Schedule, 'cron' | 'at'>): Repeat {
    if (schedule.at) return {kind: 'once', at: schedule.at}
    const cron = schedule.cron ?? ''
    const [m, h, dom, mon, dow] = cron.split(/\s+/)
    const num = (s?: string) => (s && /^\d+$/.test(s) ? Number(s) : null)
    const minute = num(m), hour = num(h)
    if (m?.startsWith('*/') && num(m.slice(2)) && h === '*' && dom === '*' && mon === '*' && dow === '*') return {kind: 'minutes', every: Number(m.slice(2))}
    if (minute !== null && h?.startsWith('*/') && dom === '*' && mon === '*' && dow === '*' && num(h.slice(2))) return {kind: 'hours', every: Number(h.slice(2)), minute}
    if (minute === null || hour === null || mon !== '*') return {kind: 'cron', cron}
    const time = `${pad(hour)}:${pad(minute)}`
    if (dom === '*' && dow === '*') return {kind: 'daily', time}
    if (dom === '*' && dow === '1-5') return {kind: 'weekdays', time}
    if (dom === '*' && dow && /^[0-6](,[0-6])*$/.test(dow)) return {kind: 'weekly', time, days: dow.split(',').map(Number)}
    if (num(dom) !== null && dow === '*') return {kind: 'monthly', time, day: Number(dom)}
    return {kind: 'cron', cron}
}

const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`

/** When it runs, in words: "Weekdays at 09:00", "Mon, Thu at 09:00", "Every 3 hours", "When an issue moves to in-review". */
export function describe(schedule: Pick<Schedule, 'cron' | 'at' | 'timezone'> & Partial<Pick<Schedule, 'on' | 'on_filter'>>): string {
    if (schedule.on) return describeEvent(schedule.on, schedule.on_filter)
    const repeat = toRepeat(schedule)
    const zone = schedule.timezone !== localZone() ? ` (${schedule.timezone})` : ''
    switch (repeat.kind) {
        case 'once': return `Once, ${when(repeat.at, schedule.timezone)}`
        case 'daily': return `Every day at ${repeat.time}${zone}`
        case 'weekdays': return `Weekdays at ${repeat.time}${zone}`
        case 'weekly': return `${repeat.days.map(d => DAYS[d]).join(', ')} at ${repeat.time}${zone}`
        case 'monthly': return `Monthly on the ${ordinal(repeat.day)} at ${repeat.time}${zone}`
        case 'minutes': return `Every ${repeat.every} minutes`
        case 'hours': return `Every ${repeat.every === 1 ? 'hour' : `${repeat.every} hours`}${repeat.minute ? ` at :${pad(repeat.minute)}` : ''}`
        default: return `Cron ${repeat.cron}${zone}`
    }
}

/** Its next few times, for the dialog to show before saving; none when the cron doesn't parse. */
export function nextTimes(cron: string | null, at: string | null, timezone: string, count = 3): Date[] {
    try {
        if (at) return new Date(at) > new Date() ? [new Date(at)] : []
        if (!cron || cron.split(/\s+/).length !== 5) return []
        // Read as the server reads it (`sloppyRanges`, see nextRun in server/utils/schedules.ts).
        return new Cron(cron, {timezone, paused: true, sloppyRanges: true}).nextRuns(count)
    } catch {
        return []
    }
}

export const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone

/** A time as "Mon 26 Oct, 09:00", in a zone (this browser's by default). */
export function when(iso: string | Date, timezone = localZone()): string {
    return new Intl.DateTimeFormat('en-GB', {timeZone: timezone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'}).format(new Date(iso)).replace(',', '')
}

/** How long until a time: "in 5m", "in 3h", "in 2d". */
export function until(iso: string): string {
    const seconds = (new Date(iso).getTime() - Date.now()) / 1000
    if (seconds < 60) return 'any moment'
    if (seconds < 3600) return `in ${Math.round(seconds / 60)}m`
    if (seconds < 86_400) return `in ${Math.round(seconds / 3600)}h`
    return `in ${Math.round(seconds / 86_400)}d`
}

/** An event schedule's trigger in words: the common one's label (its "to" said), else the pattern. */
export function describeEvent(on: string, filter: OnFilter = {}): string {
    const common = COMMON_EVENTS.find(e => e.type === on)
    const label = common ? common.label : `On ${on}`
    const to = filter.to ? (on === 'issue.status' ? ` ${filter.to}` : ` → ${filter.to}`) : ''
    const from = filter.from ? ` from ${filter.from}` : ''
    const by = filter.by ? `, by ${filter.by === 'owner' ? 'you' : 'a session'}` : ''
    const level = filter.level ? ` (${filter.level})` : ''
    return `${on === 'issue.status' && to ? 'An issue moves to' : label}${to}${from}${level}${by}`
}
