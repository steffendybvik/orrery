
    -- Logging in and verifying people (ORR-664). Only a hash of a key, a login or an invite is kept. A key's kind fixes its
    -- rights: an agent key acts as an agent of its person, a person key signs in to the page.
    CREATE TABLE keys (
        id TEXT PRIMARY KEY,
        person TEXT NOT NULL REFERENCES people(id) ON UPDATE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('agent', 'person')),
        name TEXT NOT NULL,
        hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT,
        revoked_at TEXT
    );
    CREATE UNIQUE INDEX keys_hash ON keys(hash);
    CREATE TABLE logins (
        id TEXT PRIMARY KEY,
        person TEXT NOT NULL REFERENCES people(id) ON UPDATE CASCADE,
        expires_at TEXT NOT NULL
    );
    CREATE TABLE identities (
        issuer TEXT NOT NULL,
        subject TEXT NOT NULL,
        person TEXT NOT NULL REFERENCES people(id) ON UPDATE CASCADE,
        PRIMARY KEY (issuer, subject)
    );
    CREATE TABLE invites (
        id TEXT PRIMARY KEY,
        person TEXT NOT NULL REFERENCES people(id) ON UPDATE CASCADE,
        expires_at TEXT NOT NULL,
        used_at TEXT
    );
