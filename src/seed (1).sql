-- A few sample rows so you can test. Safe to run once; real clothes come later.
INSERT INTO products (slug, name, description, category, is_new, price_ngn, price_usd) VALUES
 ('pinstripe-off-duty-shorts','Pinstripe Off-Duty Shorts','Loose, knee-length shorts in a crisp pinstripe.','unisex',true,2800000,2800),
 ('borough-cap','Borough Cap','A soft, unstructured cap.','unisex',true,1500000,1800)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO variants (product_id, label, position)
SELECT id, 'Default', 0 FROM products
WHERE slug IN ('pinstripe-off-duty-shorts','borough-cap')
  AND NOT EXISTS (SELECT 1 FROM variants v WHERE v.product_id = products.id);

INSERT INTO stock (variant_id, size, quantity)
SELECT v.id, s.size, 10
FROM variants v JOIN products p ON p.id = v.product_id
CROSS JOIN LATERAL (VALUES (CASE WHEN p.slug='borough-cap' THEN '' ELSE 'S' END),
                           (CASE WHEN p.slug='borough-cap' THEN NULL ELSE 'M' END),
                           (CASE WHEN p.slug='borough-cap' THEN NULL ELSE 'L' END)) AS s(size)
WHERE s.size IS NOT NULL
ON CONFLICT (variant_id, size) DO NOTHING;

INSERT INTO shipping_zones (name, fee_ngn, fee_usd)
SELECT * FROM (VALUES ('Lagos',350000,0),('Rest of Nigeria',550000,0),('International',0,2500)) AS z(name,fee_ngn,fee_usd)
WHERE NOT EXISTS (SELECT 1 FROM shipping_zones);

-- PLACEHOLDER shipping fees: change these to your real ones (kobo / cents).
UPDATE shipping_zones SET fee_ngn = 350000, fee_usd = 300  WHERE name = 'Lagos';
UPDATE shipping_zones SET fee_ngn = 550000, fee_usd = 500  WHERE name = 'Rest of Nigeria';
UPDATE shipping_zones SET fee_ngn = NULL,   fee_usd = 2500 WHERE name = 'International';
