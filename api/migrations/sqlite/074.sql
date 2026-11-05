
    -- The order a project's doc sections are arranged in (ORR-767), by name. Empty keeps them A–Z, as every project had them.
    ALTER TABLE projects ADD COLUMN doc_section_order TEXT NOT NULL DEFAULT '[]';
