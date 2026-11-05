
    -- A working session's request for a schedule, asked on its issue (ORR-458): its comment waits on the owner's
    -- decision, and this keeps what it asks beside it until they press Allow or Deny. `schedule` is the one it would
    -- change, or the one Allow made; `changes` and `body` are JSON, as the chat's requests hold them.
    CREATE TABLE schedule_requests (
        comment integer PRIMARY KEY REFERENCES comments(id) ON DELETE CASCADE,
        schedule integer,
        title text NOT NULL,
        changes text NOT NULL,
        body text NOT NULL,
        state text NOT NULL DEFAULT 'asked',
        answered_by text,
        answered_at text
    );
