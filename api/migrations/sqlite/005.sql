
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
