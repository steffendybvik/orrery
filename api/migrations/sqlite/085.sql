
    -- The outbox (ORR-929): a row for each thing a write set off, in the order they happened, so the local app can follow
    -- what changed on a board it doesn't front (GET /api/changes?after=<id>) and carry on from where it was after a gap.
    CREATE TABLE changes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        project TEXT,
        subject TEXT,
        actor TEXT,
        owner INTEGER NOT NULL DEFAULT 0,
        session TEXT,
        untrusted INTEGER NOT NULL DEFAULT 0,
        cause TEXT,
        payload TEXT,
        created_at TEXT NOT NULL
    );
    CREATE INDEX changes_at ON changes (created_at);
