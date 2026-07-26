#!/usr/bin/env -S npx tsx --disable-warning=ExperimentalWarning
/**
 * brain — CLI over the development state store.
 *
 * Uses node:sqlite (built in on Node 22+), so there is no native dependency
 * and nothing to compile. The library itself never imports this; it is
 * development infrastructure only.
 *
 *   ./brain/brain.ts init
 *   ./brain/brain.ts task add "title" --spec=001-core --detail="…"
 *   ./brain/brain.ts task done 3 --evidence="commit abc1234; bench/fixtures/…"
 *   ./brain/brain.ts task note 3 --text="…"
 *   ./brain/brain.ts task edit 3 --detail="…" --spec=002
 *   ./brain/brain.ts task show 3
 *   ./brain/brain.ts tasks
 *   ./brain/brain.ts decide "title" --decision="…" --rationale="…" --evidence=sweep:…
 *   ./brain/brain.ts decisions
 *   ./brain/brain.ts ingest bench/results/results-….jsonl
 *   ./brain/brain.ts report
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DB_PATH = resolve(HERE, "../brain.db");
const SCHEMA = resolve(HERE, "schema.sql");

/**
 * Additive migrations, applied on every open right after schema.sql.
 *
 * Every statement is `IF NOT EXISTS`, so this is idempotent: running it against
 * a fresh database and against one already holding real rows both converge on
 * the same shape, and nothing is ever rewritten or dropped. That is the same
 * discipline schema.sql uses, which is what makes re-entering the init path on
 * a live DB safe.
 *
 * `task_notes` is a child table rather than extra columns on `tasks` precisely
 * because an accountability ledger must accumulate. One task can collect many
 * notes over months — evidence on close, a correction, a pointer to a sweep —
 * and a single column would force each new fact to destroy the last one.
 */
const MIGRATIONS = `
CREATE TABLE IF NOT EXISTS task_notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL DEFAULT 'note'
             CHECK (kind IN ('note','evidence','detail')),
  text       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_task_notes_task ON task_notes(task_id);
`;

function open(): DatabaseSync {
  const db = new DatabaseSync(DB_PATH);
  db.exec(readFileSync(SCHEMA, "utf8"));
  db.exec(MIGRATIONS);
  return db;
}

function flag(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

function table(rows: any[]): void {
  if (!rows.length) return console.log("(none)");
  const cols = Object.keys(rows[0]);
  const w = cols.map((c) =>
    Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)),
  );
  const line = (cells: string[]) =>
    cells.map((s, i) => s.padEnd(w[i])).join("  ");
  console.log(line(cols));
  console.log(w.map((n) => "─".repeat(n)).join("  "));
  for (const r of rows) console.log(line(cols.map((c) => String(r[c] ?? ""))));
}

/** Resolve `<id>` from the first positional arg, failing loudly on a typo. */
function taskId(db: DatabaseSync, raw: string | undefined): number {
  const id = Number(raw);
  if (!raw || !Number.isInteger(id))
    throw new Error(`expected a task id, got ${JSON.stringify(raw ?? null)}`);
  const hit = db.prepare("SELECT id FROM tasks WHERE id=?").get(id);
  if (!hit) throw new Error(`no such task: #${id}`);
  return id;
}

/** Append-only. Nothing in here is ever updated or deleted by the CLI. */
function note(
  db: DatabaseSync,
  taskIdent: number,
  kind: "note" | "evidence" | "detail",
  text: string,
): void {
  db.prepare("INSERT INTO task_notes (task_id,kind,text) VALUES (?,?,?)").run(
    taskIdent,
    kind,
    text,
  );
}

const [, , cmd, sub, ...rest] = process.argv;
const db = open();

switch (cmd) {
  case "init":
    console.log(`brain ready at ${DB_PATH}`);
    break;

  case "task": {
    if (sub === "add") {
      const title = rest.find((a) => !a.startsWith("--"));
      if (!title) throw new Error("task add <title>");
      const r = db
        .prepare("INSERT INTO tasks (spec,title,detail) VALUES (?,?,?)")
        .run(flag("spec") ?? null, title, flag("detail") ?? null);
      console.log(`#${r.lastInsertRowid} ${title}`);
    } else if (sub === "note") {
      // Notes APPEND, always. A note is a fact that was true at a point in
      // time; overwriting one destroys the record the ledger exists to keep.
      const text = flag("text");
      if (!text) throw new Error('task note <id> --text="…"');
      const id = taskId(db, rest[0]);
      note(db, id, "note", text);
      console.log(`#${id} + note`);
    } else if (sub === "edit") {
      // `detail` is the task's current summary, so it has to be able to become
      // accurate — an in_progress task whose detail says "xAI outstanding"
      // after the sweep moved past it is misinformation, not history. So edit
      // REPLACES the field, but copies the superseded value into task_notes
      // first. Overwrite with archival: the current view stays true, and the
      // old wording is still recoverable via `task show`. Nothing is lost.
      const detail = flag("detail");
      const spec = flag("spec");
      if (detail === undefined && spec === undefined)
        throw new Error('task edit <id> --detail="…" and/or --spec=…');
      const id = taskId(db, rest[0]);
      if (detail !== undefined) {
        const prev = (
          db.prepare("SELECT detail FROM tasks WHERE id=?").get(id) as any
        ).detail as string | null;
        if (prev && prev !== detail) note(db, id, "detail", prev);
        db.prepare("UPDATE tasks SET detail=? WHERE id=?").run(detail, id);
      }
      if (spec !== undefined)
        db.prepare("UPDATE tasks SET spec=? WHERE id=?").run(spec, id);
      console.log(
        `#${id} edited${detail !== undefined ? " (previous detail archived)" : ""}`,
      );
    } else if (sub === "show") {
      const id = taskId(db, rest[0]);
      const row = db.prepare("SELECT * FROM tasks WHERE id=?").get(id) as any;
      table(Object.entries(row).map(([field, value]) => ({ field, value })));
      console.log("\n── notes ──");
      table(
        db
          .prepare(
            "SELECT id,kind,text,created_at FROM task_notes WHERE task_id=? ORDER BY id",
          )
          .all(id) as any[],
      );
    } else if (["start", "done", "block", "drop"].includes(sub ?? "")) {
      const map: Record<string, string> = {
        start: "in_progress",
        done: "done",
        block: "blocked",
        drop: "dropped",
      };
      const id = taskId(db, rest[0]);
      // --evidence is accepted on every transition, not just done: "why this is
      // blocked" and "why this was dropped" are exactly as load-bearing as
      // "what closed it", and they are the entries most often lost to chat.
      const evidence = flag("evidence");
      if (evidence) note(db, id, "evidence", `${map[sub!]}: ${evidence}`);
      // `blocked_on` is only written when --on is given, and cleared only by
      // unblocking. It used to be set to `flag("on") ?? null` on every
      // transition, so `task done <id>` silently erased a recorded reason —
      // the same quiet data loss the note/evidence work above exists to stop.
      const on = flag("on");
      if (on !== undefined) {
        db.prepare("UPDATE tasks SET status=?, blocked_on=? WHERE id=?").run(map[sub!], on, id);
      } else if (sub === "block") {
        db.prepare("UPDATE tasks SET status=? WHERE id=?").run(map[sub!], id);
      } else {
        // Leaving `blocked` clears the reason; it no longer describes the task.
        db.prepare("UPDATE tasks SET status=?, blocked_on=NULL WHERE id=?").run(map[sub!], id);
      }
      console.log(`#${id} → ${map[sub!]}${evidence ? " + evidence" : ""}`);
    } else {
      console.log("task add|note|edit|show|start|done|block|drop");
    }
    break;
  }

  case "tasks":
    table(db.prepare("SELECT * FROM v_open_tasks").all() as any[]);
    break;

  case "decide": {
    const title = sub;
    if (!title) throw new Error("decide <title> --decision= --rationale=");
    const r = db
      .prepare(
        "INSERT INTO decisions (title,decision,rationale,alternatives,evidence) VALUES (?,?,?,?,?)",
      )
      .run(
        title,
        flag("decision") ?? "",
        flag("rationale") ?? "",
        flag("alternatives") ?? null,
        flag("evidence") ?? null,
      );
    console.log(`decision #${r.lastInsertRowid} recorded`);
    break;
  }

  case "decisions":
    table(
      db
        .prepare(
          "SELECT id,title,status,substr(decision,1,60) AS decision,evidence,created_at FROM decisions ORDER BY id",
        )
        .all() as any[],
    );
    break;

  case "ingest": {
    const path = sub;
    if (!path || !existsSync(path)) throw new Error(`no such file: ${path}`);
    const rows = readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const key = path.match(/results-(.+)\.jsonl$/)?.[1] ?? path;
    const arms = [...new Set(rows.map((r) => r.arm))];
    const scen = [...new Set(rows.map((r) => r.scenario))];
    const reps = Math.max(...rows.map((r) => r.rep));
    const total = rows.reduce((a, r) => a + (r.costUsd ?? 0), 0);

    db.exec("BEGIN");
    db.prepare(
      `INSERT OR REPLACE INTO sweeps
       (sweep_key,model,arms,scenarios,reps,results_path,total_cost,notes)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(
      key,
      flag("model") ?? "claude-opus-5",
      JSON.stringify(arms),
      JSON.stringify(scen),
      reps,
      path,
      total,
      flag("notes") ?? null,
    );
    const sweepId = (
      db.prepare("SELECT id FROM sweeps WHERE sweep_key=?").get(key) as any
    ).id;
    db.prepare("DELETE FROM sweep_results WHERE sweep_id=?").run(sweepId);
    const ins = db.prepare(
      `INSERT INTO sweep_results
       (sweep_id,arm,scenario,rep,tool_block_tokens,total_prompt_tokens,
        total_output_tokens,turns,meta_calls,correct_calls,expected_calls,
        hallucinated,malformed,task_success,wall_ms,cost_usd,error)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const r of rows) {
      ins.run(
        sweepId, r.arm, r.scenario, r.rep,
        r.toolBlockTokens ?? 0, r.totalPromptTokens ?? 0,
        r.totalOutputTokens ?? 0, r.turns ?? 0, r.metaCalls ?? 0,
        r.correctToolCalls ?? 0, r.expectedToolCalls ?? 0,
        r.hallucinatedNames ?? 0, r.malformedArgs ?? 0,
        r.taskSuccess ? 1 : 0, r.wallMs ?? 0, r.costUsd ?? 0,
        r.error ?? null,
      );
    }
    db.exec("COMMIT");
    console.log(`ingested ${rows.length} rows as sweep "${key}" ($${total.toFixed(4)})`);
    break;
  }

  case "report": {
    console.log("\n── per arm (all sweeps) ──");
    table(db.prepare("SELECT * FROM v_arm_summary").all() as any[]);
    console.log("\n── per arm × scenario ──");
    table(
      db
        .prepare(
          `SELECT scenario, arm,
                  ROUND(AVG(tool_block_tokens))    AS block,
                  ROUND(AVG(total_prompt_tokens))  AS prompt,
                  ROUND(AVG(turns),1)              AS turns,
                  ROUND(AVG(meta_calls),1)         AS meta,
                  SUM(correct_calls)||'/'||SUM(expected_calls) AS acc,
                  SUM(hallucinated)                AS halluc,
                  SUM(malformed)                   AS bad,
                  ROUND(AVG(wall_ms))              AS ms,
                  ROUND(AVG(cost_usd),4)           AS usd
           FROM sweep_results GROUP BY scenario, arm ORDER BY scenario, arm`,
        )
        .all() as any[],
    );
    break;
  }

  default:
    console.log(
      "usage: brain init | task add|note|edit|show|start|done|block|drop … | tasks | " +
        "decide … | decisions | ingest <file> | report",
    );
}

db.close();
