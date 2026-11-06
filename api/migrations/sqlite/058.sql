
    -- An issue waiting on another's outcome (ORR-601): `issue` depends on `on_issue`, in its own project or another
    -- on this orrery. Dispatch holds it while one it depends on isn't closed; what it blocks is read the other way.
    -- No foreign keys, as with comments: a move, renumber or delete rewrites them (`issuesMoved`, renumber.ts).
    CREATE TABLE issue_links (
        project TEXT NOT NULL,
        issue TEXT NOT NULL,
        on_project TEXT NOT NULL,
        on_issue TEXT NOT NULL,
        created_by TEXT NOT NULL,
        owned INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        PRIMARY KEY (project, issue, on_project, on_issue)
    );
    CREATE INDEX issue_links_on ON issue_links(on_project, on_issue);
