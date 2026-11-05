
    -- What a session hears when asked to focus. A project can have its own templates (none uses the orrery's,
    -- kept in settings), its own standing instructions (a JSON list of {id, text, on}) and the orrery's it
    -- switches off (a JSON list of their ids). A focus keeps the instructions picked for it (a JSON list of texts).
    ALTER TABLE projects ADD COLUMN focus_prompt TEXT;
    ALTER TABLE projects ADD COLUMN chunk_prompt TEXT;
    ALTER TABLE projects ADD COLUMN instructions TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE projects ADD COLUMN muted TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE signals ADD COLUMN instructions TEXT NOT NULL DEFAULT '[]';
