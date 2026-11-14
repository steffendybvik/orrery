    -- Workspaces (ORR-1192): an owner made by the claim script after step 091 wasn't put in `default`, so with login on
    -- they reached no workspace and could make no project. An owner in no workspace at all owns `default`, as the first
    -- person does. Nobody else joins: someone who signed up has a workspace of their own and stays out of `default`.
    INSERT INTO workspace_members (workspace, person, role, created_at)
        SELECT 'default', id, 'owner', created_at FROM people
        WHERE role = 'owner' AND removed_at IS NULL AND NOT EXISTS (SELECT 1 FROM workspace_members m WHERE m.person = people.id);
