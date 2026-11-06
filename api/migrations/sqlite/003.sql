
    -- Ids are the project's from here on: chunks 1, 2, …, issues KEY-1, KEY-2, … The ids things had
    -- before stay as aliases.
    CREATE TABLE issue_aliases (
        project TEXT NOT NULL,
        alias TEXT NOT NULL,
        issue TEXT NOT NULL,
        PRIMARY KEY (project, alias)
    );
    CREATE TABLE chunk_aliases (
        project TEXT NOT NULL,
        alias TEXT NOT NULL,
        chunk TEXT NOT NULL,
        PRIMARY KEY (project, alias)
    );
    ALTER TABLE projects ADD COLUMN next_chunk INTEGER NOT NULL DEFAULT 1;
