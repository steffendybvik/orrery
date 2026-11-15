    -- Workspaces, step 4's settings (ORR-1107): what decision-workspaces gives the workspace (its colour, prompts and
    -- instructions, tracker, starting sessions, proposals, advanced and the kinds of work) is kept per workspace here,
    -- `default`'s copied from `settings`. The rows stay in `settings` too, unread from now on, so an older build put
    -- back still finds them. The person's and the machine's (handle, use counting, starred, terminal, agent) and the
    -- server's (id, uid) stay in `settings`.
    CREATE TABLE workspace_settings (
        workspace text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
        key text NOT NULL,
        value text NOT NULL,
        PRIMARY KEY (workspace, key)
    );
    INSERT INTO workspace_settings (workspace, key, value)
        SELECT 'default', key, value FROM settings
        WHERE key IN ('tint', 'focus_prompt', 'milestone_prompt', 'instructions', 'tracker', 'starts', 'restrict_proposals', 'advanced', 'work_kinds');
