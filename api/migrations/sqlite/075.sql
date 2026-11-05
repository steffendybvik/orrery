
    -- The key a login was started with (ORR-786), so revoking it ends them; a provider's login has none. known is 0 on
    -- those from before this step, which nothing ties to a key, so a revoke of any of their person's keys ends them too.
    ALTER TABLE logins ADD COLUMN by_key TEXT;
    ALTER TABLE logins ADD COLUMN known INTEGER NOT NULL DEFAULT 0;
