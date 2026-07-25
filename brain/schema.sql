-- ToolCompression development brain.
-- Durable task, decision, and experiment state for agents working this repo.
-- Benchmark *results* live in bench/results/*.jsonl (append-only, diffable);
-- this DB holds the metadata pointer and the reasoning around them.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- tasks
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tasks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  spec          TEXT,                       -- Spec Kit feature slug, if any
  title         TEXT NOT NULL,
  detail        TEXT,
  status        TEXT NOT NULL DEFAULT 'todo'
                CHECK (status IN ('todo','in_progress','blocked','done','dropped')),
  blocked_on    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_spec   ON tasks(spec);

CREATE TRIGGER IF NOT EXISTS tasks_touch
AFTER UPDATE ON tasks
BEGIN
  UPDATE tasks SET updated_at = datetime('now') WHERE id = NEW.id;
END;

-- ---------------------------------------------------------------------------
-- decisions — the why, not just the what
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS decisions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  title         TEXT NOT NULL,
  decision      TEXT NOT NULL,
  rationale     TEXT NOT NULL,
  alternatives  TEXT,                       -- what was rejected and why
  evidence      TEXT,                       -- pointer to a sweep_id or file
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','superseded','reversed')),
  superseded_by INTEGER REFERENCES decisions(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- experiments — one row per benchmark sweep
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sweeps (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  sweep_key     TEXT NOT NULL UNIQUE,       -- the results file timestamp
  model         TEXT NOT NULL,
  arms          TEXT NOT NULL,              -- json array
  scenarios     TEXT NOT NULL,              -- json array
  reps          INTEGER NOT NULL,
  results_path  TEXT NOT NULL,
  turns_path    TEXT,
  total_cost    REAL,
  notes         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Per arm×scenario roll-up, so queries do not have to reparse JSONL.
CREATE TABLE IF NOT EXISTS sweep_results (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  sweep_id            INTEGER NOT NULL REFERENCES sweeps(id) ON DELETE CASCADE,
  arm                 TEXT NOT NULL,
  scenario            TEXT NOT NULL,
  rep                 INTEGER NOT NULL,
  tool_block_tokens   INTEGER,
  total_prompt_tokens INTEGER,
  total_output_tokens INTEGER,
  turns               INTEGER,
  meta_calls          INTEGER,
  correct_calls       INTEGER,
  expected_calls      INTEGER,
  hallucinated        INTEGER,
  malformed           INTEGER,
  task_success        INTEGER,
  wall_ms             INTEGER,
  cost_usd            REAL,
  error               TEXT
);

CREATE INDEX IF NOT EXISTS idx_sr_sweep ON sweep_results(sweep_id);
CREATE INDEX IF NOT EXISTS idx_sr_arm   ON sweep_results(arm, scenario);

-- ---------------------------------------------------------------------------
-- convenience views
-- ---------------------------------------------------------------------------
CREATE VIEW IF NOT EXISTS v_arm_summary AS
SELECT
  s.sweep_key,
  r.arm,
  COUNT(*)                                            AS runs,
  ROUND(AVG(r.tool_block_tokens))                     AS avg_block,
  ROUND(AVG(r.total_prompt_tokens))                   AS avg_prompt,
  ROUND(AVG(r.turns), 2)                              AS avg_turns,
  ROUND(AVG(r.meta_calls), 2)                         AS avg_meta,
  SUM(r.correct_calls)                                AS correct,
  SUM(r.expected_calls)                               AS expected,
  ROUND(100.0 * SUM(r.correct_calls) / SUM(r.expected_calls), 1) AS accuracy_pct,
  SUM(r.hallucinated)                                 AS hallucinated,
  SUM(r.malformed)                                    AS malformed,
  ROUND(AVG(r.wall_ms))                               AS avg_ms,
  ROUND(SUM(r.cost_usd), 4)                           AS total_cost
FROM sweep_results r
JOIN sweeps s ON s.id = r.sweep_id
GROUP BY s.sweep_key, r.arm;

CREATE VIEW IF NOT EXISTS v_open_tasks AS
SELECT id, spec, title, status, blocked_on, updated_at
FROM tasks
WHERE status IN ('todo','in_progress','blocked')
ORDER BY
  CASE status WHEN 'in_progress' THEN 0 WHEN 'blocked' THEN 1 ELSE 2 END,
  id;
