
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
