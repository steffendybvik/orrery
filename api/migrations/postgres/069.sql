
    -- A doc's kind (ORR-677): Markdown, or an artifact, its text HTML that's only ever served locked down and drawn in a
    -- sandboxed frame. Its revisions keep it too, so a deleted artifact comes back as one.
    ALTER TABLE docs ADD COLUMN kind text NOT NULL DEFAULT 'markdown' CHECK (kind IN ('markdown', 'artifact'));
    ALTER TABLE doc_revisions ADD COLUMN kind text NOT NULL DEFAULT 'markdown' CHECK (kind IN ('markdown', 'artifact'));
