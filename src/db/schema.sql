-- Background Jobs System - schema
--
-- Repeatable migration: safe to run against a fresh database or an existing one.
-- All DDL is idempotent (IF NOT EXISTS, DROP IF EXISTS + re-add for constraints).

-- ---------------------------------------------------------------------------
-- jobs: every job is one immutable row with full lifecycle visibility
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL,
  last_error TEXT,
  run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  idempotency_key TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for query performance.
-- The partial index covers only claimable states, so it stays small as the
-- table of finished jobs grows.
CREATE INDEX IF NOT EXISTS idx_jobs_status_run_at
  ON jobs(status, run_at) WHERE status IN ('pending', 'failed');

CREATE INDEX IF NOT EXISTS idx_jobs_idempotency_key ON jobs(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_jobs_type ON jobs(type);

-- Supports the dead letter queue, which pages by finished_at DESC.
CREATE INDEX IF NOT EXISTS idx_jobs_dead_finished_at
  ON jobs(finished_at DESC) WHERE status = 'dead';

-- ---------------------------------------------------------------------------
-- Constraints
--
-- These are DROP IF EXISTS + re-add rather than guarded by conname, so that
-- changing a constraint definition and re-running the migration actually
-- repairs databases that were created with the old definition.
-- ---------------------------------------------------------------------------

-- Only the five defined statuses may ever be stored.
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS valid_status;
ALTER TABLE jobs ADD CONSTRAINT valid_status
  CHECK (status IN ('pending', 'processing', 'succeeded', 'failed', 'dead'));

-- finished_at tracks terminal states, and only terminal states.
--
-- Terminal states are 'succeeded' and 'dead'. 'failed' is NOT terminal: it means
-- "this attempt threw, a retry is scheduled", so a failed job must have no
-- finished_at yet. This is enforced in both directions so neither a finished
-- job missing its timestamp nor an in-flight job carrying one can exist.
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS finished_has_timestamps;
ALTER TABLE jobs ADD CONSTRAINT finished_has_timestamps
  CHECK (
    (status IN ('succeeded', 'dead') AND finished_at IS NOT NULL)
    OR
    (status IN ('pending', 'processing', 'failed') AND finished_at IS NULL)
  );

-- A job that is claimed has a started_at; an unclaimed one does not.
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS started_at_matches_status;
ALTER TABLE jobs ADD CONSTRAINT started_at_matches_status
  CHECK (
    (status = 'processing' AND started_at IS NOT NULL)
    OR
    (status <> 'processing')
  );

ALTER TABLE jobs DROP CONSTRAINT IF EXISTS attempts_non_negative;
ALTER TABLE jobs ADD CONSTRAINT attempts_non_negative
  CHECK (attempts >= 0);

-- Note: there is deliberately no `attempts <= max_attempts` constraint. Stuck
-- job recovery increments attempts without raising max_attempts, so a job
-- recovered on its final attempt would trip such a check while being perfectly
-- valid. `dead_means_exhausted` carries the invariant that actually matters.

ALTER TABLE jobs DROP CONSTRAINT IF EXISTS max_attempts_positive;
ALTER TABLE jobs ADD CONSTRAINT max_attempts_positive
  CHECK (max_attempts >= 1);

-- A dead job is dead because it ran out of attempts, so the two must agree.
-- A human retry bumps max_attempts, which keeps this satisfied.
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS dead_means_exhausted;
ALTER TABLE jobs ADD CONSTRAINT dead_means_exhausted
  CHECK (status <> 'dead' OR attempts >= max_attempts);

-- ---------------------------------------------------------------------------
-- State transition enforcement
--
-- A CHECK constraint can validate a row but cannot see the row it is replacing.
-- Transitions need a trigger, so the database - not the application - is what
-- guarantees a job cannot go from succeeded back to processing.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION jobs_enforce_status_transition()
RETURNS TRIGGER AS $$
DECLARE
  allowed BOOLEAN := FALSE;
BEGIN
  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  allowed := CASE OLD.status
    WHEN 'pending'    THEN NEW.status IN ('processing', 'pending')
    WHEN 'processing' THEN NEW.status IN ('succeeded', 'failed', 'dead', 'pending')
    WHEN 'failed'     THEN NEW.status IN ('processing', 'dead', 'pending')
    WHEN 'dead'       THEN NEW.status IN ('pending')
    WHEN 'succeeded'  THEN FALSE
    ELSE FALSE
  END;

  IF NOT allowed THEN
    RAISE EXCEPTION
      'illegal job status transition % -> % for job %',
      OLD.status, NEW.status, OLD.id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_jobs_status_transition ON jobs;
CREATE TRIGGER trg_jobs_status_transition
  BEFORE UPDATE OF status ON jobs
  FOR EACH ROW
  EXECUTE FUNCTION jobs_enforce_status_transition();

-- ---------------------------------------------------------------------------
-- charges: handler infrastructure for the charge_card job handler.
--
-- charge_card uses idempotency strategy Option C (database dedupe). The
-- authoritative output of a charge is the charges row, keyed on job.id, so
-- re-executing the same job after a worker crash returns the existing charge
-- instead of charging the card twice.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS charges (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id),
  charge_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_charges_charge_id ON charges(charge_id);
