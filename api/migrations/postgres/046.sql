
    ALTER TABLE presets ADD COLUMN default_key text;
    CREATE TABLE preset_defaults (
        key text PRIMARY KEY,
        seeded_at text NOT NULL
    );
