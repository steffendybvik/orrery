
    -- An issue can be a proposal, out of the committed work until the owner commits it; the owner's
    -- last decision on it is kept: who, when, and what they said.
    ALTER TABLE issues ADD COLUMN proposal TEXT CHECK (proposal IN ('pending', 'approved', 'changes', 'rejected'));
    ALTER TABLE issues ADD COLUMN decided_by TEXT;
    ALTER TABLE issues ADD COLUMN decided_at TEXT;
    ALTER TABLE issues ADD COLUMN decision_note TEXT;
