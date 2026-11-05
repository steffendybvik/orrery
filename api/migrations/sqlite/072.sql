
    -- Every pull request that names an issue, kept for good (ORR-795): pull_states is a recent-changes cache that lets a
    -- merged one go after a week, so an issue couldn't say what shipped for it. One row per issue a PR names. A repo's older
    -- closed PRs are read a page a poll (history_page, 0 once done). Kept when the project leaves the repo: it's still what happened.
    CREATE TABLE issue_pulls (
        project TEXT NOT NULL,
        issue TEXT NOT NULL,
        repo TEXT NOT NULL,
        number INTEGER NOT NULL,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        branch TEXT NOT NULL,
        base TEXT NOT NULL,
        author TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('open', 'merged', 'closed')),
        merged_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project, issue, repo, number),
        FOREIGN KEY (project, issue) REFERENCES issues(project, id) ON DELETE CASCADE ON UPDATE CASCADE
    );
    CREATE INDEX issue_pulls_repo ON issue_pulls (repo, number);
    ALTER TABLE pull_repos ADD COLUMN history_page INTEGER NOT NULL DEFAULT 1;
