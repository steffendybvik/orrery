
    CREATE TABLE pull_states (
        repo text NOT NULL,
        number integer NOT NULL,
        names text NOT NULL DEFAULT '[]',
        title text NOT NULL,
        url text NOT NULL,
        branch text NOT NULL,
        base text NOT NULL,
        author text NOT NULL,
        draft integer NOT NULL DEFAULT 0,
        head_sha text,
        state text NOT NULL,
        review text,
        review_id text,
        checks text,
        merged integer NOT NULL DEFAULT 0,
        closed integer NOT NULL DEFAULT 0,
        merge_sha text,
        closed_by text,
        created_at text NOT NULL,
        updated_at text NOT NULL,
        seen_at text NOT NULL,
        told text NOT NULL DEFAULT '[]',
        PRIMARY KEY (repo, number)
    );
    CREATE TABLE pull_repos (
        repo text PRIMARY KEY,
        polled_at text NOT NULL,
        token integer NOT NULL DEFAULT 0,
        error text
    );
