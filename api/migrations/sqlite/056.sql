
    -- Sections made on their own, so one can be empty before any doc is filed under it (ORR-560). A doc names its
    -- section itself (`docs.section`); the list shows these and every name a doc uses.
    CREATE TABLE doc_sections (
        project TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (project, name)
    );
