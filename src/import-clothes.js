// Reads data/clothes.json and puts it into the database.
//   npm run db:import              adds/updates clothes, keeps orders + current stock
//   npm run db:import -- --wipe    FIRST TIME: deletes everything (clothes, stock, test orders) first
//   npm run db:import -- --reset-stock   also resets stock to the numbers in the file
// Set PUBLIC_DIR in .env to your website's public folder and it will also
// check that every photo file exists (spelling AND capital letters).
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { pool } from "./db.js";

const file = JSON.parse(readFileSync(new URL("../data/clothes.json", import.meta.url), "utf8"));
const wipe = process.argv.includes("--wipe");
const resetStock = process.argv.includes("--reset-stock");

const fail = (msg) => {
  console.error("\nSTOP: " + msg);
  process.exit(1);
};

// ---------- check the file ----------
const slugs = new Set();
for (const p of file.products) {
  const at = `"${p.name ?? p.slug}"`;
  if (!/^[a-z0-9-]+$/.test(p.slug ?? "")) fail(`${at}: slug must be lowercase letters, numbers and dashes.`);
  if (slugs.has(p.slug)) fail(`${at}: slug "${p.slug}" is used twice.`);
  slugs.add(p.slug);
  if (!["men", "women", "unisex"].includes(p.category)) fail(`${at}: category must be men, women or unisex.`);
  if (!(p.priceNgn > 0) || !(p.priceUsd > 0)) fail(`${at}: priceNgn and priceUsd must be numbers above 0.`);
  if (!p.variants?.length) fail(`${at}: needs at least one variant.`);
}

// ---------- check the photos ----------
const publicDir = process.env.PUBLIC_DIR;
if (publicDir) {
  if (!existsSync(publicDir)) fail(`PUBLIC_DIR "${publicDir}" doesn't exist.`);
  const onDisk = readdirSync(publicDir);
  const lower = new Map(onDisk.map((f) => [f.toLowerCase(), f]));
  let missing = 0;

  for (const p of file.products) {
    for (const v of p.variants) {
      const name = v.image.replace(/^\//, "");
      if (onDisk.includes(name)) continue;
      missing++;
      const near = lower.get(name.toLowerCase());
      console.error(
        `  photo not found: ${v.image}  (${p.name} / ${v.label})` +
          (near ? `  -> a file named "${near}" exists: capital letters must match exactly` : "")
      );
    }
  }
  if (missing) fail(`${missing} photo(s) missing. Fix the names in data/clothes.json or rename the files.`);
  console.log("photos: all found");
} else {
  console.log("photos: not checked (set PUBLIC_DIR in .env to check them)");
}

// ---------- write to the database ----------
const client = await pool.connect();
try {
  await client.query("BEGIN");

  if (wipe) {
    console.log("wiping clothes, stock and orders");
    await client.query("TRUNCATE products, variants, stock, orders, order_items RESTART IDENTITY CASCADE");
  }

  for (const p of file.products) {
    const sizes = p.sizes ?? file.defaultSizes ?? ["S", "M", "L", "XL"];
    const sizeList = sizes.length ? sizes : [""]; // "" = one size
    const stockQty = p.stock ?? file.defaultStock ?? 10;

    const { rows: [prod] } = await client.query(
      `INSERT INTO products (slug, name, description, category, is_new, price_ngn, price_usd, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,true)
       ON CONFLICT (slug) DO UPDATE SET name=$2, description=$3, category=$4, is_new=$5,
         price_ngn=$6, price_usd=$7, active=true
       RETURNING id`,
      [p.slug, p.name, p.description ?? "", p.category, !!p.isNew,
       Math.round(p.priceNgn * 100), Math.round(p.priceUsd * 100)]
    );

    for (const [i, v] of p.variants.entries()) {
      const { rows: [vr] } = await client.query(
        `INSERT INTO variants (product_id, label, color, images, position)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (product_id, position) DO UPDATE SET label=$2, color=$3, images=$4
         RETURNING id`,
        [prod.id, v.label, v.color ?? null, [v.image], i]
      );

      for (const size of sizeList) {
        await client.query(
          `INSERT INTO stock (variant_id, size, quantity) VALUES ($1,$2,$3)
           ON CONFLICT (variant_id, size) DO UPDATE SET quantity = ${resetStock ? "$3" : "stock.quantity"}`,
          [vr.id, size, stockQty]
        );
      }

      // sizes you removed from the file stop being sold
      await client.query(
        "UPDATE stock SET quantity = 0 WHERE variant_id = $1 AND NOT (size = ANY($2::text[]))",
        [vr.id, sizeList]
      );
    }

    // styles you removed from the file: hide by emptying their stock
    await client.query(
      `UPDATE stock SET quantity = 0 WHERE variant_id IN
         (SELECT id FROM variants WHERE product_id = $1 AND position >= $2)`,
      [prod.id, p.variants.length]
    );
  }

  // anything in the database that is no longer in the file stops being shown
  const { rowCount } = await client.query(
    "UPDATE products SET active = false WHERE active AND NOT (slug = ANY($1::text[]))",
    [[...slugs]]
  );
  if (rowCount) console.log(`hidden ${rowCount} old product(s) that aren't in clothes.json`);

  await client.query("COMMIT");
  console.log(`done: ${file.products.length} products imported`);
} catch (e) {
  await client.query("ROLLBACK");
  console.error("import failed, nothing was changed:", e.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
