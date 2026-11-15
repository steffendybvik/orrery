
    -- Workspaces, step 2's second half (ORR-1105), expand only: nothing reads these yet. What the server holds today and
    -- decision-workspaces gives the workspace gets its column, all of it in `default`. A person key is the person's,
    -- above every workspace, so only agent keys get one. `settings` moves into workspace settings when they're read
    -- (ORR-1107), not copied now to drift.
    ALTER TABLE statuses ADD COLUMN workspace TEXT NOT NULL DEFAULT 'default' REFERENCES workspaces(id);
    ALTER TABLE presets ADD COLUMN workspace TEXT NOT NULL DEFAULT 'default' REFERENCES workspaces(id);
    ALTER TABLE preset_defaults ADD COLUMN workspace TEXT NOT NULL DEFAULT 'default' REFERENCES workspaces(id);
    ALTER TABLE secrets ADD COLUMN workspace TEXT NOT NULL DEFAULT 'default' REFERENCES workspaces(id);
    ALTER TABLE secret_uses ADD COLUMN workspace TEXT NOT NULL DEFAULT 'default' REFERENCES workspaces(id);
    ALTER TABLE epics ADD COLUMN workspace TEXT NOT NULL DEFAULT 'default' REFERENCES workspaces(id);
    ALTER TABLE events ADD COLUMN workspace TEXT NOT NULL DEFAULT 'default' REFERENCES workspaces(id);
    ALTER TABLE chats ADD COLUMN workspace TEXT NOT NULL DEFAULT 'default' REFERENCES workspaces(id);
    ALTER TABLE schedules_across ADD COLUMN workspace TEXT NOT NULL DEFAULT 'default' REFERENCES workspaces(id);
    ALTER TABLE session_people ADD COLUMN workspace TEXT NOT NULL DEFAULT 'default' REFERENCES workspaces(id);
    ALTER TABLE invites ADD COLUMN workspace TEXT NOT NULL DEFAULT 'default' REFERENCES workspaces(id);
    ALTER TABLE uploads ADD COLUMN workspace TEXT NOT NULL DEFAULT 'default' REFERENCES workspaces(id);
    ALTER TABLE feature_use ADD COLUMN workspace TEXT NOT NULL DEFAULT 'default' REFERENCES workspaces(id);
    ALTER TABLE keys ADD COLUMN workspace TEXT REFERENCES workspaces(id);
    UPDATE keys SET workspace = 'default' WHERE kind = 'agent';
