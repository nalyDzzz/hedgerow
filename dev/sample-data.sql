-- Sample database for developing and trying out the app.
-- Load it into a local MySQL server:
--   docker exec -i hedgerow-mysql-dev mysql -uroot -pdevpass < dev/sample-data.sql

DROP DATABASE IF EXISTS shop;
CREATE DATABASE shop CHARACTER SET utf8mb4;
USE shop;

CREATE TABLE customers (
  id          INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  email       VARCHAR(190) NOT NULL,
  full_name   VARCHAR(120) NOT NULL,
  country     CHAR(2) NOT NULL,
  is_active   TINYINT(1) NOT NULL DEFAULT 1,
  preferences JSON,
  created_at  DATETIME NOT NULL,
  UNIQUE KEY customers_email (email)
);

CREATE TABLE products (
  id          INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  sku         VARCHAR(32) NOT NULL,
  name        VARCHAR(160) NOT NULL,
  price       DECIMAL(10, 2) NOT NULL,
  tags        JSON,
  description TEXT,
  UNIQUE KEY products_sku (sku)
);

CREATE TABLE orders (
  id          BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  customer_id INT UNSIGNED NOT NULL,
  status      ENUM('pending', 'paid', 'shipped', 'delivered', 'refunded') NOT NULL,
  total       DECIMAL(12, 2) NOT NULL,
  shipping    JSON,
  notes       TEXT,
  placed_at   DATETIME NOT NULL,
  KEY orders_customer (customer_id),
  KEY orders_placed_at (placed_at),
  CONSTRAINT orders_customer_fk FOREIGN KEY (customer_id) REFERENCES customers (id)
);

CREATE TABLE order_items (
  order_id   BIGINT UNSIGNED NOT NULL,
  product_id INT UNSIGNED NOT NULL,
  quantity   SMALLINT UNSIGNED NOT NULL,
  unit_price DECIMAL(10, 2) NOT NULL,
  PRIMARY KEY (order_id, product_id),
  CONSTRAINT order_items_order_fk FOREIGN KEY (order_id) REFERENCES orders (id),
  CONSTRAINT order_items_product_fk FOREIGN KEY (product_id) REFERENCES products (id)
);

SET SESSION cte_max_recursion_depth = 10000;

INSERT INTO customers (email, full_name, country, is_active, preferences, created_at)
WITH RECURSIVE seq (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 400)
SELECT
  CONCAT('customer', n, '@example.com'),
  CONCAT(ELT(1 + n % 8, 'Ada', 'Grace', 'Linus', 'Margaret', 'Dennis', 'Barbara', 'Ken', 'Radia'), ' ',
         ELT(1 + n % 7, 'Okafor', 'Lindqvist', 'Tanaka', 'Moreau', 'Silva', 'Novak', 'Haddad')),
  ELT(1 + n % 6, 'US', 'DE', 'JP', 'BR', 'FR', 'NG'),
  n % 11 <> 0,
  IF(n % 5 = 0, NULL, JSON_OBJECT(
    'theme', ELT(1 + n % 3, 'dark', 'light', 'system'),
    'newsletter', n % 2 = 0,
    'languages', JSON_ARRAY(ELT(1 + n % 4, 'en', 'de', 'ja', 'pt'), 'en'),
    'limits', JSON_OBJECT('daily', n * 10, 'burst', NULL)
  )),
  TIMESTAMP('2024-01-01') + INTERVAL n * 37 HOUR
FROM seq;

INSERT INTO products (sku, name, price, tags, description)
WITH RECURSIVE seq (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 60)
SELECT
  CONCAT('SKU-', LPAD(n, 4, '0')),
  CONCAT(ELT(1 + n % 6, 'Walnut', 'Steel', 'Linen', 'Ceramic', 'Brass', 'Cork'), ' ',
         ELT(1 + n % 5, 'Desk Lamp', 'Notebook', 'Planter', 'Tray', 'Bookend')),
  ROUND(4 + n * 3.35, 2),
  JSON_ARRAY(ELT(1 + n % 4, 'home', 'office', 'gift', 'outdoor'), ELT(1 + n % 3, 'new', 'bestseller', 'sale')),
  IF(n % 4 = 0, NULL, CONCAT('Made in small batches. Batch ', n, ' ships in recycled packaging.'))
FROM seq;

INSERT INTO orders (customer_id, status, total, shipping, notes, placed_at)
WITH RECURSIVE seq (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 2500)
SELECT
  1 + (n * 7) % 400,
  ELT(1 + n % 5, 'pending', 'paid', 'shipped', 'delivered', 'refunded'),
  ROUND(12 + (n * 13) % 900 + (n % 100) / 100, 2),
  JSON_OBJECT(
    'carrier', ELT(1 + n % 3, 'DHL', 'UPS', 'Yamato'),
    'address', JSON_OBJECT('city', ELT(1 + n % 5, 'Berlin', 'Austin', 'Osaka', 'Lagos', 'Lyon'), 'zip', LPAD(n * 17 % 99999, 5, '0')),
    'tracking', IF(n % 4 = 0, NULL, CONCAT('TRK', LPAD(n, 9, '0'))),
    'gift', n % 9 = 0
  ),
  IF(n % 6 = 0, 'Leave at the side door.', NULL),
  TIMESTAMP('2025-01-01') + INTERVAL n * 173 MINUTE
FROM seq;

INSERT INTO order_items (order_id, product_id, quantity, unit_price)
SELECT o.id, 1 + (o.id * 3) % 60, 1 + o.id % 4, p.price
FROM orders o
JOIN products p ON p.id = 1 + (o.id * 3) % 60;

CREATE VIEW customer_totals AS
SELECT c.id, c.email, COUNT(o.id) AS orders, COALESCE(SUM(o.total), 0) AS lifetime_value
FROM customers c
LEFT JOIN orders o ON o.customer_id = c.id
GROUP BY c.id, c.email;
