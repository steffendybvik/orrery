
    -- Comments on a milestone and on an epic (ORR-977): words on the page, kept apart from an issue's, so the issue's
    -- comments (their asks, the bell, the sessions they reach, the Rust API's reads and writes) stay as they are. A
    -- milestone's go with it, and follow it when the project's ids are numbered again.
    CREATE TABLE milestone_comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project TEXT NOT NULL,
        milestone TEXT NOT NULL,
        body TEXT NOT NULL,
        created_by TEXT NOT NULL,
        session_name TEXT,
        owned INTEGER NOT NULL DEFAULT 0,
        person TEXT,
        by_agent INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (project, milestone) REFERENCES milestones(project, id) ON DELETE CASCADE ON UPDATE CASCADE
    );
    CREATE INDEX milestone_comments_of ON milestone_comments (project, milestone);
    CREATE TABLE epic_comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        epic INTEGER NOT NULL REFERENCES epics(id) ON DELETE CASCADE,
        body TEXT NOT NULL,
        created_by TEXT NOT NULL,
        session_name TEXT,
        owned INTEGER NOT NULL DEFAULT 0,
        person TEXT,
        by_agent INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE INDEX epic_comments_of ON epic_comments (epic);
