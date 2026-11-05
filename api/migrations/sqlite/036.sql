
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
