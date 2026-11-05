
    -- The owner's chats (ORR-877), kept so a restart or rebuild loses none: the chat as the page reads it, its messages
    -- in it, as JSON. ended_at is set once it has ended, kept to read.
    CREATE TABLE chats (
        id text PRIMARY KEY,
        project text NOT NULL REFERENCES projects(id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
        started_at text NOT NULL,
        ended_at text,
        chat text NOT NULL
    );
