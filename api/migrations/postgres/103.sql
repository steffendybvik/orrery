    -- Status ids are unique per workspace, not across the server (ORR-1442): a status is keyed by (workspace, id), and
    -- another workspace's ids lose the workspace's id in front (`work-in-review` becomes `in-review`), where they meet
    -- nothing of that id in the workspace already and don't become `proposed`. What points at them follows: issues,
    -- schedules (`place`, `move_from`), schedules across projects, focus signals and status activity. The old id still
    -- resolves, as an alias the API works out. An issue's or a schedule's status can't reference the id alone now, so
    -- those references go (with the key they hang on); the API checks a status is the workspace's.
    CREATE TABLE status_renames AS
        SELECT s.workspace AS workspace, s.id AS old, substr(s.id, length(s.workspace) + 2) AS new FROM statuses s
        WHERE s.workspace <> 'default' AND substr(s.id, 1, length(s.workspace) + 1) = s.workspace || '-'
            AND substr(s.id, length(s.workspace) + 2) NOT IN ('', 'proposed')
            AND NOT EXISTS (SELECT 1 FROM statuses o WHERE o.workspace = s.workspace AND o.id = substr(s.id, length(s.workspace) + 2));

    ALTER TABLE statuses DROP CONSTRAINT statuses_pkey CASCADE;
    UPDATE statuses SET id = r.new FROM status_renames r WHERE r.workspace = statuses.workspace AND r.old = statuses.id;
    ALTER TABLE statuses ADD PRIMARY KEY (workspace, id);

    UPDATE issues SET status = r.new FROM status_renames r, projects p
        WHERE p.id = issues.project AND r.workspace = p.workspace AND r.old = issues.status;
    UPDATE schedules SET place = r.new FROM status_renames r, projects p
        WHERE p.id = schedules.project AND r.workspace = p.workspace AND r.old = schedules.place;
    UPDATE schedules SET move_from = (SELECT json_agg(coalesce(r.new, j.value) ORDER BY j.n)::text
            FROM json_array_elements_text(schedules.move_from::json) WITH ORDINALITY AS j(value, n)
            LEFT JOIN projects p ON p.id = schedules.project LEFT JOIN status_renames r ON r.workspace = p.workspace AND r.old = j.value)
        WHERE EXISTS (SELECT 1 FROM json_array_elements_text(schedules.move_from::json) AS j(value) JOIN projects p ON p.id = schedules.project
            JOIN status_renames r ON r.workspace = p.workspace AND r.old = j.value);
    UPDATE schedules_across SET body = jsonb_set(body::jsonb, '{column}', to_jsonb(r.new))::text FROM status_renames r
        WHERE r.workspace = schedules_across.workspace AND r.old = body::jsonb ->> 'column';
    UPDATE schedules_across SET body = jsonb_set(body::jsonb, '{move_from}', (SELECT jsonb_agg(coalesce(r.new, j.value) ORDER BY j.n)
            FROM jsonb_array_elements_text(schedules_across.body::jsonb -> 'move_from') WITH ORDINALITY AS j(value, n)
            LEFT JOIN status_renames r ON r.workspace = schedules_across.workspace AND r.old = j.value))::text
        WHERE jsonb_typeof(body::jsonb -> 'move_from') = 'array' AND EXISTS (SELECT 1
            FROM jsonb_array_elements_text(schedules_across.body::jsonb -> 'move_from') AS j(value)
            JOIN status_renames r ON r.workspace = schedules_across.workspace AND r.old = j.value);
    UPDATE signals SET status = r.new FROM status_renames r, projects p
        WHERE p.id = signals.project AND r.workspace = p.workspace AND r.old = signals.status;
    UPDATE issue_events SET "before" = r.new FROM status_renames r, projects p
        WHERE issue_events.field = 'status' AND p.id = issue_events.project AND r.workspace = p.workspace AND r.old = issue_events."before";
    UPDATE issue_events SET "after" = r.new FROM status_renames r, projects p
        WHERE issue_events.field = 'status' AND p.id = issue_events.project AND r.workspace = p.workspace AND r.old = issue_events."after";
    DROP TABLE status_renames;
