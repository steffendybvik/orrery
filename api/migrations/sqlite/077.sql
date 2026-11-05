
    -- The owner's chats (ORR-877), kept so a restart or rebuild loses none: the chat as the page reads it, its messages
    -- in it, as JSON. ended_at is set once it has ended, kept to read.
    CREATE TABLE chats (
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        chat TEXT NOT NULL
    );
