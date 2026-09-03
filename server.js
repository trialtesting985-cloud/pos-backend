const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
require("dotenv").config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5000;

// ----------------------
// DATABASE CONNECTION
// ----------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false, // required for Supabase
  },
});

// Test DB connection on startup
pool.connect()
  .then(() => console.log("✅ Database connected"))
  .catch(err => console.error("❌ DB connection error:", err.message));

// Helper to check valid UUID
const isValidUUID = (str) => {
  return typeof str === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str.trim());
};

// Health checks
app.get("/", (req, res) => {
  res.send("POS Backend Running ✅");
});

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

// ----------------------
// USER & AUTHENTICATION ROUTES
// ----------------------

// 1. Get all users
app.get("/api/users", async (req, res) => {
  try {
    // Queries all columns safely without assuming phone exists
    const result = await pool.query("SELECT * FROM users ORDER BY created_at DESC");
    const users = result.rows.map((u) => ({
      id: u.id,
      name: u.full_name || u.name || u.username,
      username: u.username,
      phone: u.phone || u.email || "",
      role: (u.role || "staff").toLowerCase(),
      created_at: u.created_at,
      mustChangePassword: u.must_change_password || false,
      password_updated_at: u.password_updated_at,
    }));
    res.json({ success: true, users });
  } catch (err) {
    console.error("❌ GET USERS ERROR:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// 2. Create new user
app.post("/api/users", async (req, res) => {
  const { name, username, role, password, email } = req.body;
  if (!username || !name) {
    return res.status(400).json({ success: false, message: "Name and username are required" });
  }

  try {
    const userEmail = email?.trim() || `${username.trim().toLowerCase()}@pos.local`;
    const result = await pool.query(
      `INSERT INTO users (full_name, username, email, password_hash, role, is_active)
       VALUES ($1, $2, $3, $4, $5, TRUE)
       RETURNING id, full_name AS name, username, role, created_at`,
      [name.trim(), username.trim().toLowerCase(), userEmail, password || "123456", (role || "STAFF").toUpperCase()]
    );

    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    console.error("❌ CREATE USER ERROR:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// 3. Delete user
app.delete("/api/users/:id", async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query("DELETE FROM users WHERE id = $1", [id]);
    res.json({ success: true, message: "User deleted" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 4. Change / Reset password
app.post(["/api/users/change-password", "/api/change-password"], async (req, res) => {
  const { targetUserId, newPassword } = req.body;
  if (!targetUserId || !newPassword) {
    return res.status(400).json({ success: false, message: "User ID and new password are required" });
  }

  try {
    await pool.query(
      `UPDATE users 
       SET password_hash = $1, password_updated_at = CURRENT_TIMESTAMP, must_change_password = false 
       WHERE id = $2`,
      [newPassword.trim(), targetUserId]
    );
    res.json({ success: true, message: "Password updated successfully" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 5. Login route
app.post(["/api/login", "/api/auth/login"], async (req, res) => {
  const { username, password } = req.body;
  if (!username) {
    return res.status(400).json({ success: false, message: "Username is required" });
  }

  try {
    const result = await pool.query(
      `SELECT id, COALESCE(full_name, username) AS name, username, phone, role, password_hash, must_change_password 
       FROM users 
       WHERE LOWER(username) = LOWER($1)`,
      [username.trim()]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ success: false, message: "Invalid username or password" });
    }

    const user = result.rows[0];
    if (user.password_hash && password && user.password_hash !== password.trim()) {
      return res.status(401).json({ success: false, message: "Invalid password" });
    }

    res.json({
      success: true,
      token: "jwt-" + user.id,
      user: {
        id: user.id,
        name: user.name,
        username: user.username,
        role: user.role,
        mustChangePassword: user.must_change_password || false
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ----------------------
// INITIAL DATA (FRONTEND BOOT)
// ----------------------
app.get("/api/initial-data", async (req, res) => {
  try {
    const [
      products,
      variants,
      categories,
      parentCategories,
      companies,
      mappings,
      sizes
    ] = await Promise.all([
      pool.query("SELECT * FROM products ORDER BY id"),
      pool.query("SELECT * FROM variants ORDER BY id"),
      pool.query("SELECT * FROM categories ORDER BY name ASC"),
      pool.query("SELECT * FROM parent_categories ORDER BY name ASC"),
      pool.query("SELECT * FROM companies ORDER BY name ASC"),
      pool.query(`
        SELECT
          m.id,
          m.parent_category_id,
          m.category_id,
          m.company_id,
          m.pattern_id,
          pc.name AS parent_category,
          cat.name AS category,
          c.name AS company,
          p.name AS pattern
        FROM company_mappings m
        LEFT JOIN parent_categories pc ON pc.id = m.parent_category_id
        LEFT JOIN categories cat ON cat.id = m.category_id
        LEFT JOIN companies c ON c.id = m.company_id
        LEFT JOIN patterns p ON p.id = m.pattern_id
        ORDER BY m.id
      `),
      pool.query("SELECT * FROM sizes ORDER BY id")
    ]);

    const formattedMappings = mappings.rows.map(m => ({
      id: m.id,
      parentCategoryId: m.parent_category_id,
      parentCategory: m.parent_category || "",
      categoryId: m.category_id,
      categoryName: m.category || "",
      companyId: m.company_id,
      companyName: m.company || "",
      patternId: m.pattern_id,
      patternName: m.pattern || ""
    }));

    res.json({
      success: true,
      store: {
        products: products.rows,
        variants: variants.rows,
        categories: categories.rows,
        parentCategories: parentCategories.rows,
        companies: companies.rows,
        companyMappings: formattedMappings,
        sizes: sizes.rows,
        bills: [],
        customers: []
      }
    });
  } catch (err) {
    console.error("❌ INITIAL DATA ERROR:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ----------------------
// CATALOG & SETTINGS ROUTES
// ----------------------

// Categories
app.get("/api/categories", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM categories ORDER BY name ASC");
    res.json({ success: true, categories: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/categories", async (req, res) => {
  try {
    const { name, parentCategory, code } = req.body;
    if (!name) return res.status(400).json({ success: false, error: "Category name is required" });

    let parentId = null;
    if (parentCategory) {
      if (isValidUUID(parentCategory)) {
        parentId = parentCategory;
      } else {
        const pRes = await pool.query(
          "SELECT id FROM parent_categories WHERE UPPER(name) = UPPER($1) LIMIT 1",
          [String(parentCategory).trim()]
        );
        if (pRes.rows.length > 0) parentId = pRes.rows[0].id;
      }
    }

    if (!parentId) {
      const defaultP = await pool.query("SELECT id FROM parent_categories ORDER BY id LIMIT 1");
      parentId = defaultP.rows[0]?.id;
    }

    const result = await pool.query(
      `INSERT INTO categories (parent_category_id, name, code)
       VALUES ($1, $2, $3)
       ON CONFLICT (parent_category_id, name) DO UPDATE SET name = EXCLUDED.name
       RETURNING *`,
      [parentId, String(name).trim().toUpperCase(), (code || name.slice(0, 3)).toUpperCase()]
    );

    res.json({ success: true, category: result.rows[0] });
  } catch (err) {
    console.error("❌ CREATE CATEGORY ERROR:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Parent Categories
app.get("/api/parent-categories", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM parent_categories ORDER BY name ASC");
    res.json({ success: true, parentCategories: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/parent-categories", async (req, res) => {
  try {
    const { name, code } = req.body;
    if (!name) return res.status(400).json({ success: false, error: "Name is required" });

    const result = await pool.query(
      `INSERT INTO parent_categories (name, code)
       VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET code = EXCLUDED.code
       RETURNING *`,
      [String(name).trim(), (code || name.slice(0, 3)).toUpperCase()]
    );
    res.json({ success: true, parentCategory: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Companies
app.get("/api/companies", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM companies ORDER BY name ASC");
    res.json({ success: true, companies: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/companies", async (req, res) => {
  try {
    const items = Array.isArray(req.body.companies) ? req.body.companies : [req.body];
    const saved = [];

    for (const item of items) {
      const name = item.name || item.companyName;
      const code = item.code || item.companyCode || (name ? name.slice(0, 3).toUpperCase() : "CMP");
      if (!name) continue;

      const result = await pool.query(
        `INSERT INTO companies (name, code)
         VALUES ($1, $2)
         ON CONFLICT (name) DO UPDATE SET code = EXCLUDED.code
         RETURNING *`,
        [String(name).trim().toUpperCase(), String(code).trim().toUpperCase()]
      );
      saved.push(result.rows[0]);
    }

    res.json({ success: true, companies: saved, company: saved[0] });
  } catch (err) {
    console.error("❌ CREATE COMPANY ERROR:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Sizes
app.get("/api/sizes", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM sizes ORDER BY id ASC");
    res.json({ success: true, sizes: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post("/api/sizes", async (req, res) => {
  const { name, code, category_id } = req.body;
  try {
    const sizeId = "sz-" + Date.now();
    const result = await pool.query(
      "INSERT INTO sizes (id, name, code, category_id) VALUES ($1, $2, $3, $4) RETURNING *",
      [sizeId, name, code || name, category_id || null]
    );
    res.json({ success: true, size: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Patterns
app.get("/api/patterns", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM patterns ORDER BY name ASC");
    res.json({ success: true, patterns: result.rows });
  } catch (err) {
    res.json({ success: true, patterns: [] });
  }
});

// ----------------------
// MAPPINGS ROUTES
// ----------------------

app.get("/api/get-mappings", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        m.id,
        m.parent_category_id,
        m.category_id,
        m.company_id,
        m.pattern_id,
        pc.name AS parent_category,
        cat.name AS category,
        c.name AS company,
        p.name AS pattern
      FROM company_mappings m
      LEFT JOIN parent_categories pc ON pc.id = m.parent_category_id
      LEFT JOIN categories cat ON cat.id = m.category_id
      LEFT JOIN companies c ON c.id = m.company_id
      LEFT JOIN patterns p ON p.id = m.pattern_id
      ORDER BY m.id
    `);

    const formatted = result.rows.map(r => ({
      id: r.id,
      parentCategoryId: r.parent_category_id,
      parentCategory: r.parent_category || "",
      categoryId: r.category_id,
      categoryName: r.category || "",
      companyId: r.company_id,
      companyName: r.company || "",
      patternId: r.pattern_id,
      patternName: r.pattern || ""
    }));

    res.json({ success: true, mappings: formatted });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Save Mapping (Handles Single, Batch, and UUID Auto-Resolution)
app.post("/api/save-mapping", async (req, res) => {
  try {
    const body = req.body;
    const parentCategoryInput = body.parentCategoryId || body.parentCategory || body.parentCategoryName || body.parent;
    const categoryInput = body.categoryId || body.categoryName || body.category;
    const patternIdInput = body.patternId || null;

    const companyInputs = Array.isArray(body.companyIds) && body.companyIds.length > 0
      ? body.companyIds
      : (body.companyId ? [body.companyId] : []);

    if (!parentCategoryInput || !categoryInput || companyInputs.length === 0) {
      return res.status(400).json({
        success: false,
        error: "parentCategoryId, categoryId and companyId are required"
      });
    }

    // A. Resolve parent_category_id
    let resolvedParentId = null;
    if (isValidUUID(parentCategoryInput)) {
      resolvedParentId = parentCategoryInput;
    } else {
      const pRes = await pool.query(
        "SELECT id FROM parent_categories WHERE UPPER(name) = UPPER($1) LIMIT 1",
        [String(parentCategoryInput).trim()]
      );
      if (pRes.rows.length > 0) {
        resolvedParentId = pRes.rows[0].id;
      } else {
        const pIns = await pool.query(
          "INSERT INTO parent_categories (name, code) VALUES ($1, $2) RETURNING id",
          [String(parentCategoryInput).trim(), String(parentCategoryInput).trim().slice(0, 3).toUpperCase()]
        );
        resolvedParentId = pIns.rows[0].id;
      }
    }

    // B. Resolve category_id
    let resolvedCatId = null;
    if (isValidUUID(categoryInput)) {
      resolvedCatId = categoryInput;
    } else {
      const catName = body.categoryName || categoryInput;
      const cRes = await pool.query(
        "SELECT id FROM categories WHERE UPPER(name) = UPPER($1) AND parent_category_id = $2 LIMIT 1",
        [String(catName).trim(), resolvedParentId]
      );
      if (cRes.rows.length > 0) {
        resolvedCatId = cRes.rows[0].id;
      } else {
        const cIns = await pool.query(
          "INSERT INTO categories (parent_category_id, name, code) VALUES ($1, $2, $3) RETURNING id",
          [resolvedParentId, String(catName).trim(), String(catName).trim().slice(0, 3).toUpperCase()]
        );
        resolvedCatId = cIns.rows[0].id;
      }
    }

    // C. Resolve and insert each company mapping
    const savedMappings = [];
    for (const cmpInput of companyInputs) {
      let resolvedCmpId = null;
      if (isValidUUID(cmpInput)) {
        resolvedCmpId = cmpInput;
      } else {
        const cmpName = body.companyName || cmpInput;
        const compRes = await pool.query(
          "SELECT id FROM companies WHERE UPPER(name) = UPPER($1) LIMIT 1",
          [String(cmpName).trim()]
        );
        if (compRes.rows.length > 0) {
          resolvedCmpId = compRes.rows[0].id;
        } else {
          const compIns = await pool.query(
            "INSERT INTO companies (name, code) VALUES ($1, $2) RETURNING id",
            [String(cmpName).trim(), String(cmpName).trim().slice(0, 3).toUpperCase()]
          );
          resolvedCmpId = compIns.rows[0].id;
        }
      }

      // Check existing mapping
      const existing = await pool.query(
        `SELECT * FROM company_mappings 
         WHERE parent_category_id = $1 AND category_id = $2 AND company_id = $3 LIMIT 1`,
        [resolvedParentId, resolvedCatId, resolvedCmpId]
      );

      if (existing.rows.length > 0) {
        savedMappings.push(existing.rows[0]);
      } else {
        const insertRes = await pool.query(
          `INSERT INTO company_mappings (parent_category_id, category_id, company_id, pattern_id)
           VALUES ($1, $2, $3, $4)
           RETURNING *`,
          [resolvedParentId, resolvedCatId, resolvedCmpId, isValidUUID(patternIdInput) ? patternIdInput : null]
        );
        savedMappings.push(insertRes.rows[0]);
      }
    }

    res.json({
      success: true,
      mapping: savedMappings[0],
      mappings: savedMappings
    });
  } catch (err) {
    console.error("❌ SAVE MAPPING ERROR:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete(["/api/company-mappings/:id", "/api/mappings/:id"], async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query("DELETE FROM company_mappings WHERE id = $1", [id]);
    res.json({ success: true, message: "Mapping deleted" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ----------------------
// INVENTORY, BILLING & BARCODE
// ----------------------

app.get("/api/inventory/search", async (req, res) => {
  try {
    const query = req.query.query;
    if (!query) return res.json({ success: false, message: "No query provided" });

    const result = await pool.query(`
      SELECT v.*, p.title
      FROM variants v
      JOIN products p ON v.product_id = p.id
      WHERE 
        p.title ILIKE $1 OR
        v.barcode ILIKE $1 OR
        v.design_code ILIKE $1
    `, [`%${query}%`]);

    res.json({ success: true, items: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/barcode/:code", async (req, res) => {
  const { code } = req.params;
  try {
    const result = await pool.query("SELECT * FROM variants WHERE barcode = $1", [code]);
    if (result.rows.length === 0) {
      return res.json({ success: false, message: "Item not found" });
    }
    res.json({ success: true, item: result.rows[0] });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.post("/api/stock/in", async (req, res) => {
  const { barcode, qty } = req.body;
  try {
    const variant = await pool.query("SELECT * FROM variants WHERE barcode = $1", [barcode]);
    if (variant.rows.length === 0) {
      return res.json({ success: false, message: "Barcode not found" });
    }

    await pool.query(
      `UPDATE variants 
       SET stock_qty = stock_qty + $1, updated_at = CURRENT_TIMESTAMP
       WHERE barcode = $2`,
      [qty, barcode]
    );

    res.json({ success: true, message: "Stock added successfully" });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.post("/api/stock/out", async (req, res) => {
  const { barcode, qty } = req.body;
  try {
    const result = await pool.query(
      `SELECT deduct_inventory_stock_atomic($1, $2, 'staff') AS result`,
      [barcode, qty]
    );
    res.json(result.rows[0].result);
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.post("/api/bills/create", async (req, res) => {
  const { items, payment_mode, customer_name } = req.body;
  if (!items || !Array.isArray(items)) {
    return res.status(400).json({ success: false, error: "items array is required" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let grand_total = 0;

    for (const item of items) {
      const { barcode, qty } = item;
      const result = await client.query(
        `SELECT deduct_inventory_stock_atomic($1, $2, 'staff') AS result`,
        [barcode, qty]
      );
      const response = result.rows[0].result;
      if (!response.success) {
        await client.query("ROLLBACK");
        return res.json(response);
      }

      const variant = await client.query("SELECT mrp FROM variants WHERE barcode = $1", [barcode]);
      const price = Number(variant.rows[0]?.mrp || 0);
      grand_total += price * qty;
    }

    const billId = "bill-" + Date.now();
    await client.query(
      `INSERT INTO bills (id, bill_number, customer_name, payment_mode, grand_total)
       VALUES ($1, $2, $3, $4, $5)`,
      [billId, Date.now(), customer_name || "Walk-in Customer", payment_mode || "CASH", grand_total]
    );

    for (const item of items) {
      const { barcode, qty } = item;
      const variant = await client.query("SELECT * FROM variants WHERE barcode = $1", [barcode]);
      const row = variant.rows[0] || {};
      await client.query(
        `INSERT INTO bill_items 
         (bill_id, variant_id, barcode, design_code, title, color, size, qty, unit_mrp, final_price)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          billId,
          row.id,
          barcode,
          row.design_code || "",
          "POS Sale",
          row.color || "",
          row.size || "",
          qty,
          row.mrp || 0,
          (row.mrp || 0) * qty
        ]
      );
    }

    await client.query("COMMIT");
    res.json({ success: true, message: "Bill created successfully", bill_id: billId, total: grand_total });
  } catch (err) {
    await client.query("ROLLBACK");
    res.json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

app.post("/api/bills/complete", async (req, res) => {
  const { bill_id, payment_mode, cash, upi, card } = req.body;
  try {
    const result = await pool.query(
      `UPDATE bills
       SET payment_mode = $1, cash_collected = $2, upi_collected = $3, card_collected = $4, status = 'completed'
       WHERE id = $5
       RETURNING *`,
      [payment_mode, cash || 0, upi || 0, card || 0, bill_id]
    );

    if (result.rows.length === 0) {
      return res.json({ success: false, message: "Bill not found" });
    }
    res.json({ success: true, message: "Payment completed", bill: result.rows[0] });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ----------------------
// START SERVER (At the bottom after all routes)
// ----------------------
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
// ==============================================================================
// 1. PATTERNS ROUTES (GET, POST, DELETE)
// ==============================================================================
app.get("/api/patterns", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.id, p.category_id AS "categoryId", p.name, p.code, c.name AS "categoryName"
      FROM patterns p
      LEFT JOIN categories c ON c.id = p.category_id
      ORDER BY p.name ASC
    `);
    res.json({ success: true, patterns: result.rows });
  } catch (err) {
    console.error("❌ GET PATTERNS ERROR:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/patterns", async (req, res) => {
  try {
    const { name, categoryId, code } = req.body;
    if (!name) {
      return res.status(400).json({ success: false, error: "Pattern name is required" });
    }

    // Resolve categoryId to a valid UUID
    let resolvedCatId = null;
    if (isValidUUID(categoryId)) {
      resolvedCatId = categoryId;
    } else if (categoryId) {
      const cRes = await pool.query(
        "SELECT id FROM categories WHERE UPPER(name) = UPPER($1) LIMIT 1",
        [String(categoryId).trim()]
      );
      if (cRes.rows.length > 0) resolvedCatId = cRes.rows[0].id;
    }

    if (!resolvedCatId) {
      const defaultC = await pool.query("SELECT id FROM categories ORDER BY id LIMIT 1");
      resolvedCatId = defaultC.rows[0]?.id;
    }

    if (!resolvedCatId) {
      return res.status(400).json({ success: false, error: "No valid category found to attach pattern" });
    }

    const patternCode = (code || name.slice(0, 3)).toUpperCase();
    const result = await pool.query(
      `INSERT INTO patterns (category_id, name, code)
       VALUES ($1, $2, $3)
       ON CONFLICT (category_id, name) DO UPDATE SET code = EXCLUDED.code
       RETURNING id, category_id AS "categoryId", name, code`,
      [resolvedCatId, String(name).trim().toUpperCase(), patternCode]
    );

    res.json({ success: true, pattern: result.rows[0] });
  } catch (err) {
    console.error("❌ CREATE PATTERN ERROR:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete("/api/patterns/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query("DELETE FROM patterns WHERE id = $1", [id]);
    res.json({ success: true, message: "Pattern deleted" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==============================================================================
// 2. SIZES ROUTES (Matches exact Supabase sizes table columns: name, type, numeric_value)
// ==============================================================================
app.get("/api/sizes", async (req, res) => {
  try {
    const result = await pool.query("SELECT id, name, type, numeric_value FROM sizes ORDER BY id ASC");
    res.json({ success: true, sizes: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post("/api/sizes", async (req, res) => {
  try {
    const { name, type } = req.body;
    if (!name) {
      return res.status(400).json({ success: false, error: "Size name is required" });
    }

    const cleanName = String(name).trim().toUpperCase();
    // Valid types in schema: 'numeric', 'alpha', 'kids'
    const allowedTypes = ['numeric', 'alpha', 'kids'];
    const sizeType = allowedTypes.includes(type?.toLowerCase()) ? type.toLowerCase() : (isNaN(Number(cleanName)) ? 'alpha' : 'numeric');
    const numericVal = !isNaN(Number(cleanName)) && Number(cleanName) >= 10 && Number(cleanName) <= 100 ? parseInt(cleanName, 10) : null;

    const result = await pool.query(
      `INSERT INTO sizes (name, type, numeric_value)
       VALUES ($1, $2, $3)
       ON CONFLICT (LOWER(name)) DO UPDATE SET type = EXCLUDED.type
       RETURNING id, name, type, numeric_value`,
      [cleanName, sizeType, numericVal]
    );

    res.json({ success: true, size: result.rows[0] });
  } catch (err) {
    console.error("❌ CREATE SIZE ERROR:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete("/api/sizes/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query("DELETE FROM sizes WHERE id = $1", [id]);
    res.json({ success: true, message: "Size deleted" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});