
    -- What each pull request on the projects' GitHub repos was when last polled (ORR-506): its issue ids (`names`),
    -- where it stood, and the changes already told (`told`, their keys), so a change goes out once. And when each repo
    -- was polled, with a token or not, and why it couldn't be when it couldn't.
    CREATE TABLE pull_states (
        repo TEXT NOT NULL,
        number INTEGER NOT NULL,
        names TEXT NOT NULL DEFAULT '[]',
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        branch TEXT NOT NULL,
        base TEXT NOT NULL,
        author TEXT NOT NULL,
        draft INTEGER NOT NULL DEFAULT 0,
        head_sha TEXT,
        state TEXT NOT NULL,
        review TEXT,
        review_id TEXT,
        checks TEXT,
        merged INTEGER NOT NULL DEFAULT 0,
        closed INTEGER NOT NULL DEFAULT 0,
        merge_sha TEXT,
        closed_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        seen_at TEXT NOT NULL,
        told TEXT NOT NULL DEFAULT '[]',
        PRIMARY KEY (repo, number)
    );
    CREATE TABLE pull_repos (
        repo TEXT PRIMARY KEY,
        polled_at TEXT NOT NULL,
        token INTEGER NOT NULL DEFAULT 0,
        error TEXT
    );
