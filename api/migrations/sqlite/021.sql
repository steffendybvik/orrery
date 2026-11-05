
    -- An issue's activity: who changed which field, from what to what, and when ('created' when it was made,
    -- 'project' when it moved in from another). Notes keep no values, only that they changed.
    CREATE TABLE issue_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project TEXT NOT NULL,
        issue TEXT NOT NULL,
        field TEXT NOT NULL,
        before TEXT,
        after TEXT,
        created_by TEXT NOT NULL,
        owned INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        FOREIGN KEY (project, issue) REFERENCES issues(project, id) ON DELETE CASCADE
    );
    CREATE INDEX issue_events_issue ON issue_events(project, issue);
