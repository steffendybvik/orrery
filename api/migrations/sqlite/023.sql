
    -- Which Claude session last worked each issue (wrote to it, or was asked to focus on it), so the
    -- owner's comment on it goes to that session alone instead of every session on the project.
    CREATE TABLE issue_sessions (
        project TEXT NOT NULL,
        issue TEXT NOT NULL,
        session TEXT NOT NULL,
        at TEXT NOT NULL,
        PRIMARY KEY (project, issue),
        FOREIGN KEY (project, issue) REFERENCES issues(project, id) ON DELETE CASCADE ON UPDATE CASCADE
    );
