// The database: one SQLite file (`NUXT_DATABASE`, `.data/orrery.db` by default). Node's own
// `node:sqlite` is synchronous, so writes from several sessions never interleave.
import {mkdirSync} from 'node:fs'
import {restoreBackup} from './backup'
import {renumberSync} from './renumber'
import type {Db} from './database'
import {SqliteDb} from './database'
import {PostgresDb, isPostgres} from './postgres'
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
    for (const {id} of db.prepare('SELECT id FROM projects').all() as {id: string}[]) renumberSync(db, id)
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
`, `
    -- Which environment a project is in (personal, work, …): the page can show one at a time.
    ALTER TABLE projects ADD COLUMN environment TEXT NOT NULL DEFAULT 'personal';
`, `
    -- Environments are servers after all, each with its own database (NUXT_PUBLIC_ENVIRONMENT names it).
    ALTER TABLE projects DROP COLUMN environment;
`, `
    -- A focus on a chunk can be narrowed to its issues of one status ('doing', 'now', …): "work through
    -- the Now issues in chunk 3". Unchecked, so it carries over to statuses a project makes its own.
    ALTER TABLE signals ADD COLUMN status TEXT;
`, `
    -- Statuses: one list for the whole Orrery, each with a kind that says what it means. An issue's
    -- status and plan become one status: todo without a plan → Backlog, with one → Todo, doing → In progress.
    -- Schedules start their issues in a status too, and a chunk's focus names one.
    CREATE TABLE statuses (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('backlog', 'todo', 'started', 'done', 'canceled')),
        color TEXT NOT NULL,
        position REAL NOT NULL
    );
    INSERT INTO statuses (id, name, kind, color, position) VALUES
        ('backlog', 'Backlog', 'backlog', 'slate', 0),
        ('todo', 'Todo', 'todo', 'blue', 1),
        ('in-progress', 'In progress', 'started', 'amber', 2),
        ('in-review', 'In review', 'started', 'violet', 3),
        ('done', 'Done', 'done', 'green', 4),
        ('canceled', 'Canceled', 'canceled', 'slate', 5);
    CREATE TABLE issues_new (
        project TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'backlog' REFERENCES statuses(id),
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
        schedule INTEGER,
        proposal TEXT CHECK (proposal IN ('pending', 'approved', 'changes', 'rejected')),
        decided_by TEXT,
        decided_at TEXT,
        decision_note TEXT,
        PRIMARY KEY (project, id),
        FOREIGN KEY (project, parent) REFERENCES issues_new(project, id) ON DELETE CASCADE,
        FOREIGN KEY (project, chunk) REFERENCES chunks(project, id)
    );
    INSERT INTO issues_new (project, id, title, status, priority, assignee, labels, notes, parent, chunk, position, created_by, owned,
                            created_at, updated_at, schedule, proposal, decided_by, decided_at, decision_note)
        SELECT project, id, title,
               CASE status WHEN 'done' THEN 'done' WHEN 'doing' THEN 'in-progress' ELSE CASE WHEN plan IS NULL THEN 'backlog' ELSE 'todo' END END,
               priority, assignee, labels, notes, parent, chunk, position, created_by, owned,
               created_at, updated_at, schedule, proposal, decided_by, decided_at, decision_note
        FROM issues;
    DROP TABLE issues;
    ALTER TABLE issues_new RENAME TO issues;
    CREATE INDEX issues_parent ON issues(project, parent);
    CREATE TABLE schedules_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        notes TEXT,
        cron TEXT,
        at TEXT,
        timezone TEXT NOT NULL,
        place TEXT NOT NULL DEFAULT 'todo' REFERENCES statuses(id),
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
        kind TEXT NOT NULL DEFAULT 'issue' CHECK (kind IN ('issue', 'message')),
        CHECK ((cron IS NULL) != (at IS NULL))
    );
    INSERT INTO schedules_new (id, project, title, notes, cron, at, timezone, place, chunk, priority, labels, ask, skip_open, enabled,
                               next_run, created_by, owned, created_at, updated_at, kind)
        SELECT id, project, title, notes, cron, at, timezone,
               CASE place WHEN 'backlog' THEN 'backlog' WHEN 'doing' THEN 'in-progress' ELSE 'todo' END,
               chunk, priority, labels, ask, skip_open, enabled, next_run, created_by, owned, created_at, updated_at, kind
        FROM schedules;
    DROP TABLE schedules;
    ALTER TABLE schedules_new RENAME TO schedules;
    CREATE INDEX schedules_due ON schedules(enabled, next_run);
    UPDATE signals SET status = CASE status WHEN 'doing' THEN 'in-progress' WHEN 'proposed' THEN NULL ELSE 'todo' END
        WHERE status IS NOT NULL AND status != 'backlog';
`, `
    -- An issue's activity: who changed which field, from what to what, and when ('created' when it was made,
    -- 'project' when it moved in from another). Notes keep no values, only that they changed.
    CREATE TABLE issue_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project TEXT NOT NULL,
        issue TEXT NOT NULL,
        field TEXT NOT NULL,
        before TEXT,
        after TEXT,
        created_by TEXT NOT NULL,
        owned INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        FOREIGN KEY (project, issue) REFERENCES issues(project, id) ON DELETE CASCADE
    );
    CREATE INDEX issue_events_issue ON issue_events(project, issue);
`, `
    -- What a session hears when asked to focus. A project can have its own templates (none uses the Orrery's,
    -- kept in settings), its own standing instructions (a JSON list of {id, text, on}) and the Orrery's it
    -- switches off (a JSON list of their ids). A focus keeps the instructions picked for it (a JSON list of texts).
    ALTER TABLE projects ADD COLUMN focus_prompt TEXT;
    ALTER TABLE projects ADD COLUMN chunk_prompt TEXT;
    ALTER TABLE projects ADD COLUMN instructions TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE projects ADD COLUMN muted TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE signals ADD COLUMN instructions TEXT NOT NULL DEFAULT '[]';
`, `
    -- Which Claude session last worked each issue (wrote to it, or was asked to focus on it), so the
    -- owner's comment on it goes to that session alone instead of every session on the project.
    CREATE TABLE issue_sessions (
        project TEXT NOT NULL,
        issue TEXT NOT NULL,
        session TEXT NOT NULL,
        at TEXT NOT NULL,
        PRIMARY KEY (project, issue),
        FOREIGN KEY (project, issue) REFERENCES issues(project, id) ON DELETE CASCADE ON UPDATE CASCADE
    );
`, `
    -- A proposal's choices (a JSON list): questions the owner answers by picking one option, or any, with the
    -- agent's recommendation ticked. The owner's picks when they approve (a JSON object, choice → options), or
    -- the option they asked to explore further when they ask for changes (a JSON {choice, option}).
    ALTER TABLE issues ADD COLUMN choices TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE issues ADD COLUMN picks TEXT;
    ALTER TABLE issues ADD COLUMN explore TEXT;
`, `
    -- Secrets agents use without seeing them: the value encrypted with ORRERY_SECRET_KEY (the hosts and
    -- projects it may go to sealed in with it), its last 4 characters to tell it by, the hosts (a JSON list)
    -- and the projects (a JSON list, or null for any). Each use is kept, without the value.
    CREATE TABLE secrets (
        name TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        last4 TEXT NOT NULL,
        hosts TEXT NOT NULL DEFAULT '[]',
        projects TEXT,
        created_by TEXT NOT NULL,
        owned INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE TABLE secret_uses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        secret TEXT NOT NULL,
        method TEXT NOT NULL,
        host TEXT NOT NULL,
        path TEXT NOT NULL,
        project TEXT,
        issue TEXT,
        status INTEGER,
        error TEXT,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL
    );
    CREATE INDEX secret_uses_secret ON secret_uses(secret, id);
`, `
    -- Whether Orrery may start sessions for the project itself, without a terminal: a JSON {limit, minutes}
    -- (at most \`limit\` running at once, each stopped after \`minutes\`), none while the owner hasn't let it.
    ALTER TABLE projects ADD COLUMN starts TEXT;
`, `
    -- Images put in comments (and any Markdown): the bytes, kept in the database so its backups and
    -- orrery:copy take them along. The id is random, and the Markdown points at /api/uploads/<id>.
    CREATE TABLE uploads (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        name TEXT,
        size INTEGER NOT NULL,
        data BLOB NOT NULL,
        created_by TEXT NOT NULL,
        owned INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
    );
`]

let db: DatabaseSync | null = null

function useDb(): DatabaseSync {
    if (db) return db
    const config = useRuntimeConfig()
    const path = resolve(String(config.database))
    restoreBackup(path, String(config.backupDir ?? ''))
    db = openDb(path)
    return db
}

/** The open database as the store awaits it: Postgres when the setting is a `postgres://` URL, else the
 * SQLite file. */
export function useDatabase(): Db {
    const setting = String(useRuntimeConfig().database)
    if (isPostgres(setting)) return database ??= new PostgresDb(setting)
    const raw = useDb()
    if (!(database instanceof SqliteDb) || database.raw !== raw) database = new SqliteDb(raw)
    return database
}

let database: SqliteDb | PostgresDb | null = null

/** Lets go of the database, e.g. as `nuxt dev` swaps in a reloaded server; the next use opens it again. */
export async function closeDb() {
    db?.close()
    db = null
    if (database instanceof PostgresDb) await database.close()
    database = null
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
