
    -- Which environment a project is in (personal, work, …): the page can show one at a time.
    ALTER TABLE projects ADD COLUMN environment TEXT NOT NULL DEFAULT 'personal';
