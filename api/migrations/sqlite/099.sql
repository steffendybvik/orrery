    -- The presets orrery ships, noted per workspace (ORR-1350): a key seeded in one workspace kept every other from
    -- having that default, so only `default` ever had them. Its key becomes (workspace, key). Every row here is in
    -- `default` already (step 090).
    CREATE TABLE preset_defaults_new (
        key TEXT NOT NULL,
        seeded_at TEXT NOT NULL,
        workspace TEXT NOT NULL DEFAULT 'default' REFERENCES workspaces(id),
        PRIMARY KEY (workspace, key)
    );
    INSERT INTO preset_defaults_new (key, seeded_at, workspace) SELECT key, seeded_at, workspace FROM preset_defaults;
    DROP TABLE preset_defaults;
    ALTER TABLE preset_defaults_new RENAME TO preset_defaults;
