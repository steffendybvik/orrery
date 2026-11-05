
    -- Environments are servers after all, each with its own database (NUXT_PUBLIC_ENVIRONMENT names it).
    ALTER TABLE projects DROP COLUMN environment;
