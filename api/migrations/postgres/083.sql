
    -- Chunks are milestones (ORR-896): the tables, columns and stored names that said chunk say milestone.
    ALTER TABLE chunks RENAME TO milestones;
    ALTER TABLE chunk_aliases RENAME TO milestone_aliases;
    ALTER TABLE milestone_aliases RENAME COLUMN chunk TO milestone;
    ALTER TABLE projects RENAME COLUMN next_chunk TO next_milestone;
    ALTER TABLE projects RENAME COLUMN chunk_prompt TO milestone_prompt;
    ALTER TABLE issues RENAME COLUMN chunk TO milestone;
    ALTER TABLE signals RENAME COLUMN chunk TO milestone;
    ALTER TABLE schedules RENAME COLUMN chunk TO milestone;
    UPDATE settings SET key = 'milestone_prompt' WHERE key = 'chunk_prompt';
    UPDATE issue_events SET field = 'milestone' WHERE field = 'chunk';
    UPDATE events SET kind = 'milestone' || substr(kind, 6) WHERE kind LIKE 'chunk.%';
    UPDATE feature_use SET feature = 'milestones' WHERE feature = 'chunks';
    -- The prompts' {chunk} is {milestone} now.
    UPDATE settings SET value = replace(value, '{chunk}', '{milestone}') WHERE key IN ('focus_prompt', 'milestone_prompt');
    UPDATE projects SET focus_prompt = replace(focus_prompt, '{chunk}', '{milestone}'), milestone_prompt = replace(milestone_prompt, '{chunk}', '{milestone}');
