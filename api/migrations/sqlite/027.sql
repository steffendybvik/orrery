
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
