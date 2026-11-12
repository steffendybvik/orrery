
    -- Workspaces, step 3's first part (ORR-1106): everyone here joins `default`, the owner as its owner and the rest as
    -- members, so nobody loses what they reach today when access checks the workspace. Step 089 put in only the owner,
    -- and one named after it (a new orrery) wasn't there yet. Someone removed stays out.
    INSERT INTO workspace_members (workspace, person, role, created_at)
        SELECT 'default', id, CASE WHEN role = 'owner' THEN 'owner' ELSE 'member' END, created_at FROM people
        WHERE removed_at IS NULL AND NOT EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace = 'default' AND m.person = people.id);
