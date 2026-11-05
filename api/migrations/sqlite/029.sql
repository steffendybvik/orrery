
    -- A project can take its releases from another (a monorepo's apps going out in one shared release): its
    -- issues are set for that project's releases, and it has none of its own.
    ALTER TABLE projects ADD COLUMN releases_from TEXT;
