
    -- The GitHub issues an issue came from (ORR-635): a JSON list of `owner/name#523`. Those kept until now as links in
    -- `external`, which is for the team's tracker, move here.
    ALTER TABLE issues ADD COLUMN github_issues TEXT NOT NULL DEFAULT '[]';
    UPDATE issues SET
        github_issues = (SELECT json_group_array(replace(substr(value, 20), '/issues/', '#')) FROM json_each(issues.external)
                         WHERE value GLOB 'https://github.com/?*/?*/issues/[1-9]*' AND NOT value GLOB 'https://github.com/*/*/*/issues/*'
                             AND NOT value GLOB '*/issues/*[^0-9]*'),
        external = (SELECT json_group_array(value) FROM json_each(issues.external)
                    WHERE NOT (value GLOB 'https://github.com/?*/?*/issues/[1-9]*' AND NOT value GLOB 'https://github.com/*/*/*/issues/*'
                                   AND NOT value GLOB '*/issues/*[^0-9]*'))
    WHERE external GLOB '*https://github.com/*';
