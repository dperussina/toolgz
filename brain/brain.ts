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
 *   ./brain/brain.ts task done 3
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

function open(): DatabaseSync {
  const db = new DatabaseSync(DB_PATH);
  db.exec(readFileSync(SCHEMA, "utf8"));
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
    } else if (["start", "done", "block", "drop"].includes(sub ?? "")) {
      const map: Record<string, string> = {
        start: "in_progress",
        done: "done",
        block: "blocked",
        drop: "dropped",
      };
      const id = Number(rest[0]);
      db.prepare("UPDATE tasks SET status=?, blocked_on=? WHERE id=?").run(
        map[sub!],
        flag("on") ?? null,
        id,
      );
      console.log(`#${id} → ${map[sub!]}`);
    } else {
      console.log("task add|start|done|block|drop");
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
      "usage: brain init | task … | tasks | decide … | decisions | ingest <file> | report",
    );
}

db.close();
