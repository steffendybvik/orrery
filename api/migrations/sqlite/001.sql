
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
