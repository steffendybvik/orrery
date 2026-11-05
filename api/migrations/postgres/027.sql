
    CREATE TABLE uploads (
        id text PRIMARY KEY,
        type text NOT NULL,
        name text,
        size integer NOT NULL,
        data bytea NOT NULL,
        created_by text NOT NULL,
        owned integer NOT NULL DEFAULT 0,
        created_at text NOT NULL
    );
