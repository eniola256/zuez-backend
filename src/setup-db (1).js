import { readFileSync } from "node:fs";
import { pool } from "./db.js";

const run = async (file) => {
  const sql = readFileSync(new URL(file, import.meta.url), "utf8");
  await pool.query(sql);
  console.log("ran", file);
};

try {
  await run("./schema.sql");
  if (process.argv.includes("--seed")) await run("./seed.sql");
  if (process.argv.includes("--demo")) {
    console.log("DEMO: replacing all clothes, stock and orders with the 13 placeholder pieces");
    await run("./seed-demo.sql");
  }
  const { rows } = await pool.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY 1"
  );
  console.log("tables:", rows.map((r) => r.table_name).join(", "));
} catch (e) {
  console.error("setup failed:", e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
