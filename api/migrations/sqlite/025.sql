
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
