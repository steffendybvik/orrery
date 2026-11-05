
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
