
    -- Logging in and verifying people (ORR-664). Only a hash of a key, a login or an invite is kept. A key's kind fixes its
    -- rights: an agent key acts as an agent of its person, a person key signs in to the page.
    CREATE TABLE keys (
        id text PRIMARY KEY,
        person text NOT NULL REFERENCES people(id) ON UPDATE CASCADE,
        kind text NOT NULL CHECK (kind IN ('agent', 'person')),
        name text NOT NULL,
        hash text NOT NULL,
        created_at text NOT NULL,
        last_used_at text,
        revoked_at text
    );
    CREATE UNIQUE INDEX keys_hash ON keys(hash);
    CREATE TABLE logins (
        id text PRIMARY KEY,
        person text NOT NULL REFERENCES people(id) ON UPDATE CASCADE,
        expires_at text NOT NULL
    );
    CREATE TABLE identities (
        issuer text NOT NULL,
        subject text NOT NULL,
        person text NOT NULL REFERENCES people(id) ON UPDATE CASCADE,
        PRIMARY KEY (issuer, subject)
    );
    CREATE TABLE invites (
        id text PRIMARY KEY,
        person text NOT NULL REFERENCES people(id) ON UPDATE CASCADE,
        expires_at text NOT NULL,
        used_at text
    );
