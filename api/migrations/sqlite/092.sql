    -- Workspaces, step 4's secrets (ORR-1107): a secret is its workspace's, so two workspaces can each have a
    -- STRIPE_KEY of their own. Its key becomes (workspace, name). Every one here is in `default` already (step 090).
    CREATE TABLE secrets_new (
        name TEXT NOT NULL,
        value TEXT NOT NULL,
        last4 TEXT NOT NULL,
        hosts TEXT NOT NULL DEFAULT '[]',
        projects TEXT,
        created_by TEXT NOT NULL,
        owned INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        workspace TEXT NOT NULL DEFAULT 'default' REFERENCES workspaces(id),
        PRIMARY KEY (workspace, name)
    );
    INSERT INTO secrets_new (name, value, last4, hosts, projects, created_by, owned, created_at, updated_at, workspace)
        SELECT name, value, last4, hosts, projects, created_by, owned, created_at, updated_at, workspace FROM secrets;
    DROP TABLE secrets;
    ALTER TABLE secrets_new RENAME TO secrets;
