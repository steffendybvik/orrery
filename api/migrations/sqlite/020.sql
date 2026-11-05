
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
