// SQLite's schema, as numbered steps (`PRAGMA user_version`): db.ts runs those a file hasn't had yet as it opens it.
// Postgres's steps, after its baseline, are beside it in postgres.ts; a new step goes in both, and
// test/schema-parity.test.ts holds the two to the same schema.
import type {DatabaseSync} from 'node:sqlite'
import {renumberSync} from '../renumber'
import {ownerPerson} from '../owner-person'

// Each step brings the schema up one version (`PRAGMA user_version`); add steps, never edit them.
// A step is SQL, or a function for what SQL can't say.
export const MIGRATIONS: (string | ((db: DatabaseSync) => void))[] = [`
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
    -- The orrery's own settings (not a project's), e.g. the background tint, as keys and JSON values.
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
    -- Statuses: one list for the whole orrery, each with a kind that says what it means. An issue's
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
    -- What a session hears when asked to focus. A project can have its own templates (none uses the orrery's,
    -- kept in settings), its own standing instructions (a JSON list of {id, text, on}) and the orrery's it
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
    -- Whether orrery may start sessions for the project itself, without a terminal: a JSON {limit, minutes}
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
`, `
    -- Releases: the versions a project ships (\`1.0.0-rc.2\`), each with the branch its work gathers on, notes,
    -- and the day it shipped (none while it's being prepared). An issue says which one it ships in
    -- (\`ships_in\`; \`release\` is a word SQL keeps), and a project where its code is, to link branches and PRs.
    CREATE TABLE releases (
        project TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        version TEXT NOT NULL,
        branch TEXT,
        notes TEXT,
        shipped_on TEXT,
        created_by TEXT NOT NULL,
        owned INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project, version)
    );
    ALTER TABLE issues ADD COLUMN ships_in TEXT;
    ALTER TABLE projects ADD COLUMN repo TEXT;
`, `
    -- A project can take its releases from another (a monorepo's apps going out in one shared release): its
    -- issues are set for that project's releases, and it has none of its own.
    ALTER TABLE projects ADD COLUMN releases_from TEXT;
`, `
    -- The API's fields are snake_case, as the columns are: the orrery's own prompt settings follow.
    UPDATE settings SET key = 'focus_prompt' WHERE key = 'focusPrompt';
    UPDATE settings SET key = 'chunk_prompt' WHERE key = 'chunkPrompt';
`, `
    -- An issue's tasks on the team's tracker: a JSON list of ids or URLs.
    ALTER TABLE issues ADD COLUMN external TEXT NOT NULL DEFAULT '[]';
`, `
    -- Not every project ships: one has no releases, its own, or another's (\`releases_from\`). Those with
    -- releases, or others drawing on them, keep their own; the rest have none until they're turned on.
    ALTER TABLE projects ADD COLUMN release_mode TEXT NOT NULL DEFAULT 'none';
    UPDATE projects SET release_mode = 'shared' WHERE releases_from IS NOT NULL;
    UPDATE projects SET release_mode = 'own' WHERE releases_from IS NULL
        AND (id IN (SELECT project FROM releases) OR id IN (SELECT releases_from FROM projects WHERE releases_from IS NOT NULL));
`, `
    -- Approving a proposal commits it now; those approved before wait no longer: they go on the roadmap, in Todo
    -- if they were still in the backlog, else where their work already took them (started, done).
    UPDATE issues SET proposal = NULL, status = CASE WHEN status IN (SELECT id FROM statuses WHERE kind = 'backlog')
        THEN COALESCE((SELECT id FROM statuses WHERE kind = 'todo' ORDER BY position, id LIMIT 1), status) ELSE status END
        WHERE proposal = 'approved';
`, `
    -- Releases are arranged by hand, from 0 at the top: they start in the order they had, those being
    -- prepared first, then the shipped ones, latest first.
    ALTER TABLE releases ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
    UPDATE releases SET position = (SELECT n FROM (
        SELECT project, version, row_number() OVER (PARTITION BY project ORDER BY shipped_on IS NOT NULL, shipped_on DESC, created_at DESC, version DESC) - 1 AS n
        FROM releases) o WHERE o.project = releases.project AND o.version = releases.version);
`, `
    -- A chunk's focus (or the whole project's, chunk 'all') can be narrowed to a release's issues.
    ALTER TABLE signals ADD COLUMN release TEXT;
`, `
    -- Presets: saved pieces of context the owner gives a session as they start it, each a name and its text;
    -- the orrery's (no project), for any project's sessions, or a project's own.
    CREATE TABLE presets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project TEXT REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        text TEXT NOT NULL,
        created_by TEXT NOT NULL,
        owned INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
`, `
    -- Letting orrery start sessions is the owner's one setting, not each project's: the first project that had it
    -- passes its limits on, and the projects' own are let go.
    INSERT INTO settings (key, value) SELECT 'starts', starts FROM projects WHERE starts IS NOT NULL ORDER BY created_at, id LIMIT 1
        ON CONFLICT (key) DO NOTHING;
    UPDATE projects SET starts = NULL;
`, `
    -- The day a release's features froze: from then on it takes fixes, tests and docs, by preference.
    ALTER TABLE releases ADD COLUMN frozen_on TEXT;
`, `
    -- A preset's badge: a Heroicon and a colour (a tint's name or #rrggbb); without an icon, its initials.
    ALTER TABLE presets ADD COLUMN icon TEXT;
    ALTER TABLE presets ADD COLUMN color TEXT;
`, `
    -- A message schedule that skips a run when nothing in its project changed since the last one it sent.
    ALTER TABLE schedules ADD COLUMN only_if_changed INTEGER NOT NULL DEFAULT 0;
`, `
    -- A message schedule that brings in what others wrote (GitHub issues): its run gets a locked-down session of its own.
    ALTER TABLE schedules ADD COLUMN untrusted INTEGER NOT NULL DEFAULT 0;
`, `
    -- The event log: what orrery did and what went wrong (server/utils/event-log.ts). A repeat of one that isn't
    -- resolved counts on its row. Not tied to a project row, so what happened in one outlives it.
    CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        level TEXT NOT NULL,
        kind TEXT NOT NULL,
        project TEXT,
        message TEXT NOT NULL,
        details TEXT,
        count INTEGER NOT NULL DEFAULT 1,
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        resolved_at TEXT
    );
    CREATE INDEX events_last_seen ON events (last_seen);
`, `
    -- A message the owner sent from a preset: the preset's name, as it was then, to label it by.
    ALTER TABLE signals ADD COLUMN preset TEXT;
`, `
    -- A schedule that runs when something happens (ORR-341) rather than on a clock: the event's type as a pattern
    -- (\`issue.status\`, \`release.*\`), and what the event must also say (JSON). A run keeps what it was about.
    -- Rebuilt for its check: exactly one of cron, at and on_event.
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
        only_if_changed INTEGER NOT NULL DEFAULT 0,
        untrusted INTEGER NOT NULL DEFAULT 0,
        on_event TEXT,
        on_filter TEXT,
        CHECK ((cron IS NOT NULL) + (at IS NOT NULL) + (on_event IS NOT NULL) = 1)
    );
    INSERT INTO schedules_new (id, project, title, notes, cron, at, timezone, place, chunk, priority, labels, ask, skip_open, enabled, next_run,
        created_by, owned, created_at, updated_at, kind, only_if_changed, untrusted)
        SELECT id, project, title, notes, cron, at, timezone, place, chunk, priority, labels, ask, skip_open, enabled, next_run,
        created_by, owned, created_at, updated_at, kind, only_if_changed, untrusted FROM schedules;
    DROP TABLE schedules;
    ALTER TABLE schedules_new RENAME TO schedules;
    CREATE INDEX schedules_due ON schedules(enabled, next_run);
    ALTER TABLE schedule_runs ADD COLUMN subject TEXT;
`, `
    -- A schedule that starts a session (ORR-342), and the presets (ids, JSON) a schedule's message or session is
    -- given (ORR-332). Rebuilt for its kind's check.
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
        kind TEXT NOT NULL DEFAULT 'issue' CHECK (kind IN ('issue', 'message', 'session')),
        only_if_changed INTEGER NOT NULL DEFAULT 0,
        untrusted INTEGER NOT NULL DEFAULT 0,
        on_event TEXT,
        on_filter TEXT,
        presets TEXT NOT NULL DEFAULT '[]',
        CHECK ((cron IS NOT NULL) + (at IS NOT NULL) + (on_event IS NOT NULL) = 1)
    );
    INSERT INTO schedules_new (id, project, title, notes, cron, at, timezone, place, chunk, priority, labels, ask, skip_open, enabled, next_run,
        created_by, owned, created_at, updated_at, kind, only_if_changed, untrusted, on_event, on_filter)
        SELECT id, project, title, notes, cron, at, timezone, place, chunk, priority, labels, ask, skip_open, enabled, next_run,
        created_by, owned, created_at, updated_at, kind, only_if_changed, untrusted, on_event, on_filter FROM schedules;
    DROP TABLE schedules;
    ALTER TABLE schedules_new RENAME TO schedules;
    CREATE INDEX schedules_due ON schedules(enabled, next_run);
`, `
    -- The presets orrery ships (ORR-343, shared/presets.ts): one keeps its key, and each key seeded is noted, so a
    -- default the owner removed isn't seeded again.
    ALTER TABLE presets ADD COLUMN default_key TEXT;
    CREATE TABLE preset_defaults (
        key TEXT PRIMARY KEY,
        seeded_at TEXT NOT NULL
    );
`, `
    -- What an event in the log is about (ORR-378): the issue, release, chunk or doc a change to the roadmap was to.
    ALTER TABLE events ADD COLUMN subject TEXT;
`, `
    -- A message the owner's chat sent for them (ORR-397): \`chat\`, so it's shown as relayed.
    ALTER TABLE signals ADD COLUMN via TEXT;
`, `
    -- Who resolved an event in the log when it wasn't the owner (ORR-420): the bell still shows it until they look.
    ALTER TABLE events ADD COLUMN resolved_by TEXT;
`, `
    -- An agent's proposal the owner cleared from the bell (ORR-430), as it was put up then: put up again, it's back.
    CREATE TABLE proposal_clears (
        project TEXT NOT NULL,
        issue TEXT NOT NULL,
        put_up TEXT NOT NULL,
        cleared_at TEXT NOT NULL,
        PRIMARY KEY (project, issue, put_up),
        FOREIGN KEY (project, issue) REFERENCES issues(project, id) ON DELETE CASCADE ON UPDATE CASCADE
    );
`, `
    -- Agents' comments in the order the bell and Notifications list them (ORR-441), so a page of them is read off it.
    CREATE INDEX comments_notices ON comments(owned, cleared, created_at, id);
`, `
    -- The name of the session that wrote it (ORR-466), as it was then: the page shows it instead of Agent, and sessions
    -- are forgotten after a while, so it's kept with the write.
    ALTER TABLE comments ADD COLUMN session_name TEXT;
    ALTER TABLE issue_events ADD COLUMN session_name TEXT;
    ALTER TABLE issues ADD COLUMN session_name TEXT;
`, `
    -- What each pull request on the projects' GitHub repos was when last polled (ORR-506): its issue ids (\`names\`),
    -- where it stood, and the changes already told (\`told\`, their keys), so a change goes out once. And when each repo
    -- was polled, with a token or not, and why it couldn't be when it couldn't.
    CREATE TABLE pull_states (
        repo TEXT NOT NULL,
        number INTEGER NOT NULL,
        names TEXT NOT NULL DEFAULT '[]',
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        branch TEXT NOT NULL,
        base TEXT NOT NULL,
        author TEXT NOT NULL,
        draft INTEGER NOT NULL DEFAULT 0,
        head_sha TEXT,
        state TEXT NOT NULL,
        review TEXT,
        review_id TEXT,
        checks TEXT,
        merged INTEGER NOT NULL DEFAULT 0,
        closed INTEGER NOT NULL DEFAULT 0,
        merge_sha TEXT,
        closed_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        seen_at TEXT NOT NULL,
        told TEXT NOT NULL DEFAULT '[]',
        PRIMARY KEY (repo, number)
    );
    CREATE TABLE pull_repos (
        repo TEXT PRIMARY KEY,
        polled_at TEXT NOT NULL,
        token INTEGER NOT NULL DEFAULT 0,
        error TEXT
    );
`, `
    ALTER TABLE docs ADD COLUMN section TEXT;
`, `
    -- When the session on an issue took it, for the issue page's banner: kept while the same session works it
    -- again, unlike \`at\`, which moves on every write (ORR-536).
    ALTER TABLE issue_sessions ADD COLUMN since TEXT;
    UPDATE issue_sessions SET since = at;
`, `
    -- Sections made on their own, so one can be empty before any doc is filed under it (ORR-560). A doc names its
    -- section itself (\`docs.section\`); the list shows these and every name a doc uses.
    CREATE TABLE doc_sections (
        project TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (project, name)
    );
`, `
    -- A working session's request for a schedule, asked on its issue (ORR-458): its comment waits on the owner's
    -- decision, and this keeps what it asks beside it until they press Allow or Deny. \`schedule\` is the one it would
    -- change, or the one Allow made; \`changes\` and \`body\` are JSON, as the chat's requests hold them.
    CREATE TABLE schedule_requests (
        comment INTEGER PRIMARY KEY REFERENCES comments(id) ON DELETE CASCADE,
        schedule INTEGER,
        title TEXT NOT NULL,
        changes TEXT NOT NULL,
        body TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'asked',
        answered_by TEXT,
        answered_at TEXT
    );
`, `
    -- An issue waiting on another's outcome (ORR-601): \`issue\` depends on \`on_issue\`, in its own project or another
    -- on this orrery. Dispatch holds it while one it depends on isn't closed; what it blocks is read the other way.
    -- No foreign keys, as with comments: a move, renumber or delete rewrites them (\`issuesMoved\`, renumber.ts).
    CREATE TABLE issue_links (
        project TEXT NOT NULL,
        issue TEXT NOT NULL,
        on_project TEXT NOT NULL,
        on_issue TEXT NOT NULL,
        created_by TEXT NOT NULL,
        owned INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        PRIMARY KEY (project, issue, on_project, on_issue)
    );
    CREATE INDEX issue_links_on ON issue_links(on_project, on_issue);
`, `
    -- The GitHub issues an issue came from (ORR-635): a JSON list of \`owner/name#523\`. Those kept until now as links in
    -- \`external\`, which is for the team's tracker, move here.
    ALTER TABLE issues ADD COLUMN github_issues TEXT NOT NULL DEFAULT '[]';
    UPDATE issues SET
        github_issues = (SELECT json_group_array(replace(substr(value, 20), '/issues/', '#')) FROM json_each(issues.external)
                         WHERE value GLOB 'https://github.com/?*/?*/issues/[1-9]*' AND NOT value GLOB 'https://github.com/*/*/*/issues/*'
                             AND NOT value GLOB '*/issues/*[^0-9]*'),
        external = (SELECT json_group_array(value) FROM json_each(issues.external)
                    WHERE NOT (value GLOB 'https://github.com/?*/?*/issues/[1-9]*' AND NOT value GLOB 'https://github.com/*/*/*/issues/*'
                                   AND NOT value GLOB '*/issues/*[^0-9]*'))
    WHERE external GLOB '*https://github.com/*';
`, `
    -- What an event schedule's minute held back (ORR-357): the event that would have run it for this subject, as JSON,
    -- run in its turn if it still fits. One for each schedule and subject, the latest.
    CREATE TABLE schedule_held (
        schedule INTEGER NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
        subject TEXT NOT NULL,
        event TEXT NOT NULL,
        at TEXT NOT NULL,
        PRIMARY KEY (schedule, subject)
    );
`, `
    -- A schedule that moves issues itself (ORR-636), and the statuses (ids or kinds, JSON) it moves them out of. Rebuilt
    -- for its kind's check.
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
        kind TEXT NOT NULL DEFAULT 'issue' CHECK (kind IN ('issue', 'message', 'session', 'action')),
        only_if_changed INTEGER NOT NULL DEFAULT 0,
        untrusted INTEGER NOT NULL DEFAULT 0,
        on_event TEXT,
        on_filter TEXT,
        presets TEXT NOT NULL DEFAULT '[]',
        move_from TEXT NOT NULL DEFAULT '[]',
        CHECK ((cron IS NOT NULL) + (at IS NOT NULL) + (on_event IS NOT NULL) = 1)
    );
    INSERT INTO schedules_new (id, project, title, notes, cron, at, timezone, place, chunk, priority, labels, ask, skip_open, enabled, next_run,
        created_by, owned, created_at, updated_at, kind, only_if_changed, untrusted, on_event, on_filter, presets)
        SELECT id, project, title, notes, cron, at, timezone, place, chunk, priority, labels, ask, skip_open, enabled, next_run,
        created_by, owned, created_at, updated_at, kind, only_if_changed, untrusted, on_event, on_filter, presets FROM schedules;
    DROP TABLE schedules;
    ALTER TABLE schedules_new RENAME TO schedules;
    CREATE INDEX schedules_due ON schedules(enabled, next_run);
`, `
    -- A schedule across projects (ORR-638): what it says (\`body\`), and which projects it's for: \`*\`, or a JSON list, with
    -- \`skip\` those that opted out of \`*\`. Each of them has an ordinary schedule made from it, pointing back here.
    CREATE TABLE schedules_across (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        projects TEXT NOT NULL,
        skip TEXT NOT NULL DEFAULT '[]',
        body TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    ALTER TABLE schedules ADD COLUMN across INTEGER REFERENCES schedules_across(id) ON DELETE CASCADE;
    CREATE UNIQUE INDEX schedules_across_project ON schedules(across, project) WHERE across IS NOT NULL;
`, db => {
    db.exec(`
    -- The people on this orrery (ORR-653): the owner, moved over from settings, and the members they add. A person's id
    -- never changes once they're a member; the owner's follows their name, as it always has.
    CREATE TABLE people (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
        handle TEXT,
        created_at TEXT NOT NULL,
        removed_at TEXT
    );
    CREATE UNIQUE INDEX people_one_owner ON people(role) WHERE role = 'owner';
`)
    const owner = db.prepare("SELECT value FROM settings WHERE key = 'owner'").get() as {value: string} | undefined
    const person = owner && ownerPerson(owner.value)
    if (person) db.prepare("INSERT INTO people (id, name, role, created_at) VALUES (?, ?, 'owner', ?)").run(person.id, person.name, new Date().toISOString())
    db.exec("DELETE FROM settings WHERE key = 'owner'")
}, `
    -- A doc's past (ORR-675): a row for each save that changed its title or text, the whole of both, with ids across the
    -- orrery so one number can mark a moment on any project. A row with \`deleted\` is the doc being removed, holding its
    -- last text and its \`section\`, which only such a row keeps. They outlive the doc, so \`doc\` is a plain column. What's
    -- there now starts each doc's history, and \`doc_mark\` is the newest revision as a release shipped: none for those
    -- shipped before this, as that moment can't be worked out.
    CREATE TABLE doc_revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        doc TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        section TEXT,
        deleted INTEGER NOT NULL DEFAULT 0,
        created_by TEXT NOT NULL,
        session_name TEXT,
        owned INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
    );
    CREATE INDEX doc_revisions_doc ON doc_revisions(project, doc, id);
    INSERT INTO doc_revisions (project, doc, title, body, created_by, owned, created_at)
        SELECT project, id, title, body, created_by, owned, updated_at FROM docs ORDER BY updated_at, project, id;
    ALTER TABLE releases ADD COLUMN doc_mark INTEGER;
`]
