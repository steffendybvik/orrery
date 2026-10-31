// When orrery backs its database up (plugins/backup.ts wires it): after a change, a few seconds on, put off by more
// changes; or, when the owner chose every 15 minutes, hour or day in App settings (ORR-445), once that long has gone
// since the last backup, and only when something changed. A new orrery (no projects, no owner) doesn't back up to a
// folder (ORR-448, ORR-741): there's nothing in it to keep, its first page asks whether to restore what's there, and a
// copy of the empty one would either take that one's place or be offered as if it were a backup. What it reaches outside
// (the target, the database, the log) comes in as hooks, so its timing can be tested on its own.
import type {EventEntry} from './event-log'
import type {BackupEvery, BackupTarget} from './backup'
import {backupDelay, targetLabel} from './backup'

export interface BackupHooks {
    /** Where backups go now, or none while they're off: read each time, so a choice in App settings is followed. */
    target: () => BackupTarget | null
    /** Whether the database is a new orrery's: no projects, no owner. */
    fresh: () => Promise<boolean>
    /** Backs the database up to the target. */
    backUp: (target: BackupTarget) => Promise<void>
    /** How often the owner chose. */
    every: () => BackupEvery
    /** How long a change settles before it's backed up: a few seconds, or a minute when a whole copy is made. */
    settle: () => number
    note: (entry: EventEntry) => void
}

export class BackupScheduler {
    /** When the last backup was made (or the server started). */
    private last = Date.now()
    private timer: ReturnType<typeof setTimeout> | undefined
    /** The first change not backed up yet. */
    private since: number | undefined

    constructor(private readonly hooks: BackupHooks) {}

    /** Backs up now, if backups are on and it may; a failure is logged, never thrown. */
    async save(): Promise<void> {
        const target = this.hooks.target()
        if (!target) return
        if (target.kind === 'folder' && await this.hooks.fresh().catch(() => false)) return
        this.last = Date.now()
        // A Postgres one by `user@host:port/name`, never its password.
        const where = targetLabel(target)
        await this.hooks.backUp(target)
            .then(() => this.hooks.note({level: 'info', kind: 'backup.made', message: `Backed up to ${where}`}), error => {
                console.error(`[orrery] backing up to ${where}:`, (error as Error).message)
                this.hooks.note({level: 'error', kind: 'backup.failed', message: `Backing up to ${where}: ${(error as Error).message}`, details: {stack: (error as Error).stack}})
            })
    }

    /** Something changed: a backup is due after it, as `backupDelay` says. */
    soon(): void {
        const now = Date.now()
        this.since ??= now
        const every = this.hooks.every()
        // After each change, more changes put it off; on an interval, the backup already waiting takes them along.
        if (every !== 'change' && this.timer) return
        clearTimeout(this.timer)
        this.timer = setTimeout(() => {
            this.timer = undefined
            this.since = undefined
            void this.save()
        }, backupDelay(every, this.hooks.settle(), now, this.since, this.last))
    }

    /** The server is closing: what's waiting is backed up now. */
    async close(): Promise<void> {
        clearTimeout(this.timer)
        this.timer = undefined
        await this.save()
    }
}
