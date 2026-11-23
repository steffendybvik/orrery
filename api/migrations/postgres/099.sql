    -- The presets orrery ships, noted per workspace (ORR-1350): a key seeded in one workspace kept every other from
    -- having that default, so only `default` ever had them. Its key becomes (workspace, key). Every row here is in
    -- `default` already (step 090).
    ALTER TABLE preset_defaults DROP CONSTRAINT preset_defaults_pkey;
    ALTER TABLE preset_defaults ADD PRIMARY KEY (workspace, key);
