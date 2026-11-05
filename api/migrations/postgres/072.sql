
    -- Every pull request that names an issue, kept for good (ORR-795): pull_states is a recent-changes cache that lets a
    -- merged one go after a week, so an issue couldn't say what shipped for it. One row per issue a PR names. A repo's older
    -- closed PRs are read a page a poll (history_page, 0 once done). Kept when the project leaves the repo: it's still what happened.
    CREATE TABLE issue_pulls (
        project text NOT NULL,
        issue text NOT NULL,
        repo text NOT NULL,
        number integer NOT NULL,
        title text NOT NULL,
        url text NOT NULL,
        branch text NOT NULL,
        base text NOT NULL,
        author text NOT NULL,
        state text NOT NULL CHECK (state IN ('open', 'merged', 'closed')),
        merged_at text,
        created_at text NOT NULL,
        updated_at text NOT NULL,
        PRIMARY KEY (project, issue, repo, number),
        FOREIGN KEY (project, issue) REFERENCES issues(project, id) ON DELETE CASCADE ON UPDATE CASCADE
    );
    CREATE INDEX issue_pulls_repo ON issue_pulls (repo, number);
    ALTER TABLE pull_repos ADD COLUMN history_page integer NOT NULL DEFAULT 1;
