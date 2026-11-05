
    -- The presets orrery ships (ORR-343, shared/presets.ts): one keeps its key, and each key seeded is noted, so a
    -- default the owner removed isn't seeded again.
    ALTER TABLE presets ADD COLUMN default_key TEXT;
    CREATE TABLE preset_defaults (
        key TEXT PRIMARY KEY,
        seeded_at TEXT NOT NULL
    );
