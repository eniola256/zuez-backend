-- ZUEZ database. Money is stored as whole minor units:
-- kobo for NGN (₦1 = 100) and cents for USD ($1 = 100). Never decimals.

CREATE TABLE IF NOT EXISTS products (
  id          SERIAL PRIMARY KEY,
  slug        TEXT UNIQUE NOT NULL,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category    TEXT NOT NULL CHECK (category IN ('men','women','unisex')),
  is_new      BOOLEAN NOT NULL DEFAULT false,
  price_ngn   INTEGER NOT NULL CHECK (price_ngn >= 0),
  price_usd   INTEGER NOT NULL CHECK (price_usd >= 0),
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- a colour / style of a product, with its photos
CREATE TABLE IF NOT EXISTS variants (
  id         SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  label      TEXT NOT NULL,
  color      TEXT,
  images     TEXT[] NOT NULL DEFAULT '{}',
  position   INTEGER NOT NULL DEFAULT 0
);

-- how many we have of each style + size (size '' = one-size items)
CREATE TABLE IF NOT EXISTS stock (
  id         SERIAL PRIMARY KEY,
  variant_id INTEGER NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
  size       TEXT NOT NULL DEFAULT '',
  quantity   INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  UNIQUE (variant_id, size)
);

CREATE TABLE IF NOT EXISTS shipping_zones (
  id       SERIAL PRIMARY KEY,
  name     TEXT NOT NULL,
  fee_ngn  INTEGER NOT NULL DEFAULT 0,
  fee_usd  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS orders (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ref           TEXT UNIQUE NOT NULL,           -- shown to the customer, e.g. ZUEZ-8F3K2A
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','paid','failed','expired','shipped','delivered')),
  currency      TEXT NOT NULL CHECK (currency IN ('NGN','USD')),
  subtotal      INTEGER NOT NULL,
  shipping_fee  INTEGER NOT NULL DEFAULT 0,
  total         INTEGER NOT NULL,
  customer_name TEXT NOT NULL,
  email         TEXT NOT NULL,
  phone         TEXT NOT NULL,
  address       TEXT NOT NULL,
  city          TEXT NOT NULL,
  state         TEXT NOT NULL DEFAULT '',
  country       TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at       TIMESTAMPTZ
);

-- a snapshot of what was bought, at the price it was bought for
CREATE TABLE IF NOT EXISTS order_items (
  id         SERIAL PRIMARY KEY,
  order_id   UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  variant_id INTEGER REFERENCES variants(id) ON DELETE SET NULL,
  name       TEXT NOT NULL,
  variant    TEXT NOT NULL,
  size       TEXT NOT NULL DEFAULT '',
  qty        INTEGER NOT NULL CHECK (qty > 0),
  unit_price INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_orders_email  ON orders(email);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

-- A NULL fee means "we don't ship there when paying in that currency".
ALTER TABLE shipping_zones ALTER COLUMN fee_ngn DROP NOT NULL;
ALTER TABLE shipping_zones ALTER COLUMN fee_usd DROP NOT NULL;
ALTER TABLE shipping_zones ALTER COLUMN fee_ngn DROP DEFAULT;
ALTER TABLE shipping_zones ALTER COLUMN fee_usd DROP DEFAULT;

-- one style per position per product (lets the importer update styles safely)
CREATE UNIQUE INDEX IF NOT EXISTS uq_variants_position ON variants(product_id, position);
