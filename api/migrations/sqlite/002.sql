
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
