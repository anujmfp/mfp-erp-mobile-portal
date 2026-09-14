-- =========================================================================
-- MFP ERP - Supabase PostgreSQL Database Schema
-- Copy-paste this SQL script into your Supabase SQL Editor to initialize tables.
-- =========================================================================

-- 1. RAW MATERIALS TABLE
CREATE TABLE IF NOT EXISTS raw_materials (
    id TEXT PRIMARY KEY,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    current_stock NUMERIC DEFAULT 0.0,
    unit TEXT DEFAULT 'kg',
    average_price NUMERIC DEFAULT 0.0,
    min_stock NUMERIC DEFAULT 5.0,
    description TEXT
);

-- 2. PRODUCTS & BILL OF MATERIALS (BOM)
-- The 'bom' column stores the ingredients recipe as a JSONB array of objects:
-- [{"material_id": "rm_id", "quantity": 0.025, "wastage_percentage": 1.5}]
CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    price NUMERIC DEFAULT 0.0,
    selling_price NUMERIC DEFAULT 0.0,
    current_stock NUMERIC DEFAULT 0.0,
    min_stock NUMERIC DEFAULT 20.0,
    packaging_type TEXT DEFAULT 'Bottles', -- Bottles, Pouches, Sachets, Horeca
    description TEXT,
    bom JSONB DEFAULT '[]'::jsonb
);

-- 3. PURCHASE ORDERS (ORDER BOOK)
CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    material_id TEXT REFERENCES raw_materials(id) ON DELETE SET NULL,
    material_name TEXT NOT NULL,
    quantity_requested NUMERIC NOT NULL,
    vendor_name TEXT,
    price_suggested NUMERIC,
    status TEXT DEFAULT 'Pending' -- Pending, Inwarded, Cancelled
);

-- 4. INWARD RECEIPTS (MATERIAL ARRIVAL)
CREATE TABLE IF NOT EXISTS inwards (
    id TEXT PRIMARY KEY,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    invoice_no TEXT NOT NULL,
    material_id TEXT REFERENCES raw_materials(id) ON DELETE SET NULL,
    material_name TEXT NOT NULL,
    quantity_received NUMERIC NOT NULL,
    rate_billed NUMERIC NOT NULL,
    supplier TEXT NOT NULL,
    linked_order_id TEXT REFERENCES orders(id) ON DELETE SET NULL,
    has_variance BOOLEAN DEFAULT FALSE,
    variance_notes TEXT
);

-- 5. DAILY PRODUCTION RUNS
CREATE TABLE IF NOT EXISTS productions (
    id TEXT PRIMARY KEY,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
    product_name TEXT NOT NULL,
    quantity_produced NUMERIC NOT NULL,
    packaging_type TEXT NOT NULL -- Bottles, Pouches, Sachets, Horeca
);

-- 6. OUTWARD DISPATCHES (SALES DISPATCH)
CREATE TABLE IF NOT EXISTS outwards (
    id TEXT PRIMARY KEY,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    invoice_no TEXT NOT NULL,
    product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
    product_name TEXT NOT NULL,
    quantity_dispatched NUMERIC NOT NULL,
    price_billed NUMERIC NOT NULL,
    customer TEXT NOT NULL
);

-- 7. DISABLE ROW LEVEL SECURITY (RLS) FOR DIRECT ACCESS
-- If RLS is enabled in your Supabase project, run these commands in Supabase SQL Editor
-- so that your mobile app and desktop portal can read and write tables without permission errors:
ALTER TABLE raw_materials DISABLE ROW LEVEL SECURITY;
ALTER TABLE products DISABLE ROW LEVEL SECURITY;
ALTER TABLE orders DISABLE ROW LEVEL SECURITY;
ALTER TABLE inwards DISABLE ROW LEVEL SECURITY;
ALTER TABLE productions DISABLE ROW LEVEL SECURITY;
ALTER TABLE outwards DISABLE ROW LEVEL SECURITY;
