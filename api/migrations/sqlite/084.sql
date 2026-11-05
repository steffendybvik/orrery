
    -- Epics (ORR-895): one piece of work across projects, holding issues from any of them, with a number of its own
    -- across the orrery. An issue is in one epic at most (epic), and a sub-issue with none goes with its parent's.
    CREATE TABLE epics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        notes TEXT,
        position INTEGER NOT NULL DEFAULT 0,
        created_by TEXT NOT NULL,
        owned INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    ALTER TABLE issues ADD COLUMN epic INTEGER;
    CREATE INDEX issues_epic ON issues (epic) WHERE epic IS NOT NULL;
