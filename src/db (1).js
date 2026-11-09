import pg from "pg";

// A "pool" keeps a few database connections open and reuses them,
// instead of opening a new one for every request.
// Neon's connection string already contains ?sslmode=require, so the
// connection is encrypted without anything extra here.
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
});

export const query = (text, params) => pool.query(text, params);
