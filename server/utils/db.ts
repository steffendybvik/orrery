// The database: one SQLite file (`NUXT_DATABASE`, `.data/orrery.db` by default). Node's own
// `node:sqlite` is synchronous, so writes from several sessions never interleave.
import {mkdirSync} from 'node:fs'
import {restoreBackup} from './backup'
import {renumber} from './renumber'
import {dirname, resolve} from 'node:path'
import {DatabaseSync} from 'node:sqlite'

// Each step brings the schema up one version (`PRAGMA user_version`); add steps, never edit them.
// A step is SQL, or a function for what SQL can't say.
const MIGRATIONS: (string | ((db: DatabaseSync) => void))[] = [`
    CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        key TEXT NOT NULL,
        description TEXT,
        next_number INTEGER NOT NULL DEFAULT 1,
        -- Who made it (the Orrery-Actor header), and whether that was the owner: no one else can delete those.
        created_by TEXT NOT NULL,
        owned INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE TABLE chunks (
        project TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT,
        position REAL NOT NULL,
        -- Who made it (the Orrery-Actor header), and whether that was the owner: no one else can delete those.
        created_by TEXT NOT NULL,
        owned INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project, id)
    );
    -- A sub-issue has a parent and no chunk: it is in its top-level issue's chunk.
    CREATE TABLE issues (
        project TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'doing', 'done')),
        plan TEXT CHECK (plan IN ('now', 'next', 'later')),
        priority TEXT CHECK (priority IN ('P1', 'P2', 'P3')),
        assignee TEXT,
        -- A JSON list of strings
        labels TEXT NOT NULL DEFAULT '[]',
        notes TEXT,
        parent TEXT,
        chunk TEXT,
        position REAL NOT NULL,
        -- Who made it (the Orrery-Actor header), and whether that was the owner: no one else can delete those.
        created_by TEXT NOT NULL,
        owned INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project, id),
        FOREIGN KEY (project, parent) REFERENCES issues(project, id) ON DELETE CASCADE,
        FOREIGN KEY (project, chunk) REFERENCES chunks(project, id)
    );
    CREATE INDEX issues_parent ON issues(project, parent);
    CREATE TABLE comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project TEXT NOT NULL,
        issue TEXT NOT NULL,
        body TEXT NOT NULL,
        -- Who made it (the Orrery-Actor header), and whether that was the owner: no one else can delete those.
        created_by TEXT NOT NULL,
        owned INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (project, issue) REFERENCES issues(project, id) ON DELETE CASCADE
    );
    CREATE INDEX comments_issue ON comments(project, issue);
`, `
    -- P0 (urgent), and docs. SQLite can't change a CHECK, so issues is built again.
    CREATE TABLE issues_new (
        project TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'doing', 'done')),
        plan TEXT CHECK (plan IN ('now', 'next', 'later')),
        priority TEXT CHECK (priority IN ('P0', 'P1', 'P2', 'P3')),
        assignee TEXT,
        labels TEXT NOT NULL DEFAULT '[]',
        notes TEXT,
        parent TEXT,
        chunk TEXT,
        position REAL NOT NULL,
        created_by TEXT NOT NULL,
        owned INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project, id),
        FOREIGN KEY (project, parent) REFERENCES issues_new(project, id) ON DELETE CASCADE,
        FOREIGN KEY (project, chunk) REFERENCES chunks(project, id)
    );
    INSERT INTO issues_new SELECT * FROM issues;
    DROP TABLE issues;
    ALTER TABLE issues_new RENAME TO issues;
    CREATE INDEX issues_parent ON issues(project, parent);
    CREATE TABLE docs (
        project TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        title TEXT NOT NULL,
        -- Markdown
        body TEXT NOT NULL DEFAULT '',
        position REAL NOT NULL,
        created_by TEXT NOT NULL,
        owned INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project, id)
    );
`, `
    -- Ids are the project's from here on: chunks 1, 2, …, issues KEY-1, KEY-2, … The ids things had
    -- before stay as aliases.
    CREATE TABLE issue_aliases (
        project TEXT NOT NULL,
        alias TEXT NOT NULL,
        issue TEXT NOT NULL,
        PRIMARY KEY (project, alias)
    );
    CREATE TABLE chunk_aliases (
        project TEXT NOT NULL,
        alias TEXT NOT NULL,
        chunk TEXT NOT NULL,
        PRIMARY KEY (project, alias)
    );
    ALTER TABLE projects ADD COLUMN next_chunk INTEGER NOT NULL DEFAULT 1;
`, db => {
    for (const {id} of db.prepare('SELECT id FROM projects').all() as {id: string}[]) renumber(db, id)
}, `
    -- Signals to the Claude sessions working on a project, e.g. "focus on MSH-42", in the order sent.
    CREATE TABLE signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        issue TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('focus')),
        note TEXT,
        created_by TEXT NOT NULL,
        owned INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
    );
    CREATE INDEX signals_project ON signals(project, id);
`, `
    -- A signal can be for one session, and records the sessions it reached (a JSON list of names).
    ALTER TABLE signals ADD COLUMN target TEXT;
    ALTER TABLE signals ADD COLUMN delivered_to TEXT NOT NULL DEFAULT '[]';
`, `
    -- Signals can also carry the owner's comment to the session on the issue (kind 'comment', note = its text).
    CREATE TABLE signals_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        issue TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('focus', 'comment')),
        note TEXT,
        created_by TEXT NOT NULL,
        owned INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        target TEXT,
        delivered_to TEXT NOT NULL DEFAULT '[]'
    );
    INSERT INTO signals_new SELECT * FROM signals;
    DROP TABLE signals;
    ALTER TABLE signals_new RENAME TO signals;
    CREATE INDEX signals_project ON signals(project, id);
`, `
    -- A chunk has a priority, and a focus signal can be about a chunk (work through its issues) instead of an issue.
    ALTER TABLE chunks ADD COLUMN priority TEXT CHECK (priority IN ('P0', 'P1', 'P2', 'P3'));
    CREATE TABLE signals_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        issue TEXT,
        chunk TEXT,
        kind TEXT NOT NULL CHECK (kind IN ('focus', 'comment')),
        note TEXT,
        created_by TEXT NOT NULL,
        owned INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        target TEXT,
        delivered_to TEXT NOT NULL DEFAULT '[]',
        CHECK ((issue IS NULL) != (chunk IS NULL))
    );
    INSERT INTO signals_new (id, project, issue, kind, note, created_by, owned, created_at, target, delivered_to)
        SELECT id, project, issue, kind, note, created_by, owned, created_at, target, delivered_to FROM signals;
    DROP TABLE signals;
    ALTER TABLE signals_new RENAME TO signals;
    CREATE INDEX signals_project ON signals(project, id);
`, `
    -- An agent's comment the owner cleared from the bell: it stays on its issue, out of the notices.
    ALTER TABLE comments ADD COLUMN cleared INTEGER NOT NULL DEFAULT 0;
`, `
    -- A project's schedules: at a time (cron in a timezone, or once \`at\`) each makes an issue, placed as
    -- \`place\` (a board column) says, and can ask the project's sessions to pick it up. Runs are kept.
    CREATE TABLE schedules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        notes TEXT,
        cron TEXT,
        at TEXT,
        timezone TEXT NOT NULL,
        place TEXT NOT NULL DEFAULT 'now' CHECK (place IN ('backlog', 'later', 'next', 'now', 'doing')),
        chunk TEXT,
        priority TEXT CHECK (priority IN ('P0', 'P1', 'P2', 'P3')),
        labels TEXT NOT NULL DEFAULT '[]',
        ask INTEGER NOT NULL DEFAULT 0,
        skip_open INTEGER NOT NULL DEFAULT 1,
        enabled INTEGER NOT NULL DEFAULT 1,
        next_run TEXT,
        created_by TEXT NOT NULL,
        owned INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK ((cron IS NULL) != (at IS NULL))
    );
    CREATE INDEX schedules_due ON schedules(enabled, next_run);
    CREATE TABLE schedule_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        schedule INTEGER NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
        at TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('made', 'skipped', 'failed')),
        issue TEXT,
        note TEXT
    );
    CREATE INDEX schedule_runs_schedule ON schedule_runs(schedule, id);
    -- The schedule that made an issue, if one did.
    ALTER TABLE issues ADD COLUMN schedule INTEGER;
`, `
    -- An agent's comment that waits on the owner: a decision to make, or feedback to give.
    ALTER TABLE comments ADD COLUMN asks TEXT CHECK (asks IN ('decision', 'feedback'));
`, `
    -- A schedule can send a message to the project's sessions instead of making an issue. A message
    -- signal is about neither an issue nor a chunk, and names the schedule that sent it; its run is 'sent'.
    ALTER TABLE schedules ADD COLUMN kind TEXT NOT NULL DEFAULT 'issue' CHECK (kind IN ('issue', 'message'));
    CREATE TABLE signals_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        issue TEXT,
        chunk TEXT,
        schedule INTEGER,
        kind TEXT NOT NULL CHECK (kind IN ('focus', 'comment', 'message')),
        note TEXT,
        created_by TEXT NOT NULL,
        owned INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        target TEXT,
        delivered_to TEXT NOT NULL DEFAULT '[]',
        CHECK (kind = 'message' OR (issue IS NULL) != (chunk IS NULL))
    );
    INSERT INTO signals_new (id, project, issue, chunk, kind, note, created_by, owned, created_at, target, delivered_to)
        SELECT id, project, issue, chunk, kind, note, created_by, owned, created_at, target, delivered_to FROM signals;
    DROP TABLE signals;
    ALTER TABLE signals_new RENAME TO signals;
    CREATE INDEX signals_project ON signals(project, id);
    CREATE TABLE schedule_runs_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        schedule INTEGER NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
        at TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('made', 'sent', 'skipped', 'failed')),
        issue TEXT,
        note TEXT
    );
    INSERT INTO schedule_runs_new SELECT * FROM schedule_runs;
    DROP TABLE schedule_runs;
    ALTER TABLE schedule_runs_new RENAME TO schedule_runs;
    CREATE INDEX schedule_runs_schedule ON schedule_runs(schedule, id);
`, `
    -- The Orrery's own settings (not a project's), e.g. the background tint, as keys and JSON values.
    CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
`, `
    -- A project's icon in the sidebar: a Heroicon's name, e.g. shopping-cart.
    ALTER TABLE projects ADD COLUMN icon TEXT;
`, `
    -- An issue can be a proposal, out of the committed work until the owner commits it; the owner's
    -- last decision on it is kept: who, when, and what they said.
    ALTER TABLE issues ADD COLUMN proposal TEXT CHECK (proposal IN ('pending', 'approved', 'changes', 'rejected'));
    ALTER TABLE issues ADD COLUMN decided_by TEXT;
    ALTER TABLE issues ADD COLUMN decided_at TEXT;
    ALTER TABLE issues ADD COLUMN decision_note TEXT;
`, `
    -- The colour of a project's icon: a tint's name or a #rrggbb; none follows the text.
    ALTER TABLE projects ADD COLUMN icon_color TEXT;
`]

let db: DatabaseSync | null = null

export function useDb(): DatabaseSync {
    if (db) return db
    const config = useRuntimeConfig()
    const path = resolve(String(config.database))
    restoreBackup(path, String(config.backupDir ?? ''))
    db = openDb(path)
    return db
}

/** Lets go of the file, e.g. as `nuxt dev` swaps in a reloaded server; the next `useDb` opens it again. */
export function closeDb() {
    db?.close()
    db = null
}

/** Opens the file and brings its schema up to date (or only `upTo` steps, for tests). */
export function openDb(path: string, upTo = MIGRATIONS.length): DatabaseSync {
    if (path !== ':memory:') mkdirSync(dirname(path), {recursive: true})
    const opened = new DatabaseSync(path)
    // The wait first: in `nuxt dev` the server it replaces may still have the file (backing it up as it goes).
    opened.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL')
    const {user_version: version} = opened.prepare('PRAGMA user_version').get() as {user_version: number}
    // Foreign keys are off while tables are rebuilt (SQLite can't turn them off inside a transaction).
    opened.exec('PRAGMA foreign_keys = OFF')
    MIGRATIONS.slice(version, upTo).forEach((step, i) => {
        transaction(opened, () => {
            if (typeof step === 'string') opened.exec(step)
            else step(opened)
            opened.exec(`PRAGMA user_version = ${version + i + 1}`)
        })
    })
    if (opened.prepare('PRAGMA foreign_key_check').all().length) throw new Error(`${path}: a migration left rows pointing at nothing`)
    opened.exec('PRAGMA foreign_keys = ON')
    return opened
}

/** Runs `work` in one transaction: all of it lands, or none of it. */
export function transaction<T>(database: DatabaseSync, work: () => T): T {
    database.exec('BEGIN IMMEDIATE')
    try {
        const result = work()
        database.exec('COMMIT')
        return result
    } catch (error) {
        database.exec('ROLLBACK')
        throw error
    }
}
