
    -- The GitHub issues an issue came from (ORR-635): a JSON list of `owner/name#523`. Those kept until now as links in
    -- `external`, which is for the team's tracker, move here.
    ALTER TABLE issues ADD COLUMN github_issues text NOT NULL DEFAULT '[]';
    UPDATE issues SET
        github_issues = COALESCE((SELECT json_agg(replace(substr(t.value, 20), '/issues/', '#') ORDER BY t.n)
                                  FROM json_array_elements_text(external::json) WITH ORDINALITY AS t(value, n)
                                  WHERE t.value ~ '^https://github\.com/[^/]+/[^/]+/issues/[1-9][0-9]*$')::text, '[]'),
        external = COALESCE((SELECT json_agg(t.value ORDER BY t.n)
                             FROM json_array_elements_text(external::json) WITH ORDINALITY AS t(value, n)
                             WHERE t.value !~ '^https://github\.com/[^/]+/[^/]+/issues/[1-9][0-9]*$')::text, '[]')
    WHERE external LIKE '%https://github.com/%';
