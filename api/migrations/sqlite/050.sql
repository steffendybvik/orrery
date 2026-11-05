
    -- An agent's proposal the owner cleared from the bell (ORR-430), as it was put up then: put up again, it's back.
    CREATE TABLE proposal_clears (
        project TEXT NOT NULL,
        issue TEXT NOT NULL,
        put_up TEXT NOT NULL,
        cleared_at TEXT NOT NULL,
        PRIMARY KEY (project, issue, put_up),
        FOREIGN KEY (project, issue) REFERENCES issues(project, id) ON DELETE CASCADE ON UPDATE CASCADE
    );
