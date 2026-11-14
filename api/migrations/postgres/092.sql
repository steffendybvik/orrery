    -- Workspaces, step 4's secrets (ORR-1107): a secret is its workspace's, so two workspaces can each have a
    -- STRIPE_KEY of their own. Its key becomes (workspace, name). Every one here is in `default` already (step 090).
    ALTER TABLE secrets DROP CONSTRAINT secrets_pkey;
    ALTER TABLE secrets ADD PRIMARY KEY (workspace, name);
