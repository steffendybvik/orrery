    -- A session's record (ORR-1171): whether it's an untrusted schedule's session or the owner's chat, and the project an
    -- untrusted one was started for, kept here so the rails read it themselves rather than take the router's word on
    -- every request. The Nuxt server writes it once (PUT /api/sessions/:session), and a later write can only tighten it.
    -- `project` has no reference: deleting a project mustn't free a session held to it.
    CREATE TABLE session_records (
        session TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('untrusted', 'chat')),
        project TEXT,
        workspace TEXT NOT NULL DEFAULT 'default' REFERENCES workspaces(id),
        at TEXT NOT NULL
    );
