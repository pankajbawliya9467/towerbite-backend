-- A teammate saying "I paid" is a claim; it only counts as paid when the host confirms (safe to re-run).
alter table team_members add column if not exists claimed_at timestamptz;
