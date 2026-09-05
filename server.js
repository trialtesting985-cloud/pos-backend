const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
require("dotenv").config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: "50mb" }));

const PORT = process.env.PORT || 5000;

// -----------------------------------------------------------------------------
// 1. DATABASE CONNECTION
// -----------------------------------------------------------------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false, // Required for Supabase / Cloud hosted PostgreSQL
  },
});

// Test DB connection on startup
pool
  .connect()
  .then(() => console.log("✅ Database connected"))
  .catch((err) => console.error("❌ DB connection error:", err.message));

// Helper: UUID Validator
const isValidUUID = (str) => {
  return (
    typeof str === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str.trim())
  );
};

// -----------------------------------------------------------------------------
// 2. AUTHENTICATION & ROLE VERIFICATION MIDDLEWARE
// -----------------------------------------------------------------------------
const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : authHeader;

  if (!token) {
    return res.status(401).json({ success: false, message: "Authentication token required" });
  }

  try {
    // Extract userId from 'jwt-<userId>' format or raw token
    const userId = token.startsWith("jwt-") ? token.replace("jwt-", "") : token;

    const result = await pool.query(
      `SELECT id, username, full_name, role 
       FROM users 
       WHERE id::text = $1 OR username = $1 
       LIMIT 1`,
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ success: false, message: "Invalid or expired session" });
    }

    req.user = {
      ...result.rows[0],
      role: (result.rows[0].role || "staff").toLowerCase(),
    };
    next();
  } catch (err) {
    console.error("Auth middleware error:", err);
    return res.status(401).json({ success: false, message: "Authentication verification failed" });
  }
};

// Health checks
app.get("/", (req, res) => {
  res.send("POS Backend Running ✅");
});

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

// -----------------------------------------------------------------------------
// 3. USER & AUTHENTICATION ROUTES
// -----------------------------------------------------------------------------

// 1. Get all users
app.get("/api/users", async (req, res) => {
  try {
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
        mustChangePassword: user.must_change_password || false,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// -----------------------------------------------------------------------------
// 4. PRODUCTS & VARIANTS (CRUD & BATCH MANAGEMENT)
// -----------------------------------------------------------------------------

// GET all products
app.get("/api/products", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        p.id,
        p.design_code AS "designCode",
        p.category_id AS "categoryId",
        cat.name AS "categoryName",
        COALESCE(pc.name, 'Gents') AS "parentCategory",
        p.company_id AS "companyId",
        cmp.name AS "companyName",
        p.pattern_id AS "patternId",
        pat.name AS "patternName",
        p.created_at AS "createdAt"
      FROM products p
      LEFT JOIN categories cat ON cat.id = p.category_id
      LEFT JOIN parent_categories pc ON pc.id = cat.parent_category_id
      LEFT JOIN companies cmp ON cmp.id = p.company_id
      LEFT JOIN patterns pat ON pat.id = p.pattern_id
      ORDER BY p.id DESC
    `);
    res.json({ success: true, products: result.rows, total: result.rows.length });
  } catch (err) {
    console.error("❌ GET PRODUCTS ERROR:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST single product
app.post("/api/products", async (req, res) => {
  const { product, variants } = req.body;
  if (!product || !product.designCode) {
    return res.status(400).json({ success: false, message: "Product design code is required" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const pRes = await client.query(
      `INSERT INTO products (company_id, category_id, pattern_id, design_code, created_at)
       VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
       ON CONFLICT (design_code) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
       RETURNING id`,
      [
        isValidUUID(product.companyId) ? product.companyId : null,
        isValidUUID(product.categoryId) ? product.categoryId : null,
        isValidUUID(product.patternId) ? product.patternId : null,
        product.designCode,
      ]
    );
    const prodId = pRes.rows[0].id;

    if (Array.isArray(variants)) {
      for (const v of variants) {
        await client.query(
          `INSERT INTO variants (product_id, barcode, design_code, size, color, cost_price, mrp, stock_qty)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (barcode) DO UPDATE 
           SET mrp = EXCLUDED.mrp, stock_qty = variants.stock_qty + EXCLUDED.stock_qty`,
          [
            prodId,
            v.barcode,
            v.designCode || product.designCode,
            v.size,
            v.color,
            v.costPrice || 0,
            v.mrp || 0,
            v.stockQty || v.qty || 1,
          ]
        );
      }
    }

    await client.query("COMMIT");
    res.json({ success: true, message: "Product saved successfully", productId: prodId });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ CREATE PRODUCT ERROR:", err);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
});

// POST Batch Products (used by ProductSetup & MRP Tagging)
app.post(["/api/products/add-batch", "/api/products/add"], async (req, res) => {
  const items = req.body.items || [req.body];
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, message: "Invalid batch items payload" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    for (const item of items) {
      const { product, variants } = item;
      if (!product?.designCode) continue;

      const pRes = await client.query(
        `INSERT INTO products (company_id, category_id, pattern_id, design_code, created_at)
         VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
         ON CONFLICT (design_code) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
         RETURNING id`,
        [
          isValidUUID(product.companyId) ? product.companyId : null,
          isValidUUID(product.categoryId) ? product.categoryId : null,
          isValidUUID(product.patternId) ? product.patternId : null,
          product.designCode,
        ]
      );
      const prodId = pRes.rows[0].id;

      if (Array.isArray(variants)) {
        for (const v of variants) {
          await client.query(
            `INSERT INTO variants (product_id, barcode, design_code, size, color, cost_price, mrp, stock_qty)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (barcode) DO UPDATE 
             SET mrp = EXCLUDED.mrp, stock_qty = variants.stock_qty + EXCLUDED.stock_qty`,
            [
              prodId,
              v.barcode,
              v.designCode || product.designCode,
              v.size,
              v.color,
              v.costPrice || 0,
              v.mrp || 0,
              v.stockQty || v.qty || 1,
            ]
          );
        }
      }
    }

    await client.query("COMMIT");
    res.json({ success: true, message: `Successfully staged and saved ${items.length} product(s)` });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ ADD BATCH PRODUCTS ERROR:", err);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
});

// DELETE Product (Admin-Only & Transactional Historical Sales Protection)
app.delete("/api/products/:id", authenticateToken, async (req, res) => {
  const { id } = req.params;

  // 1. Role verification
  if (req.user?.role !== "admin") {
    return res.status(403).json({
      success: false,
      message: "Access denied: Only Administrators are authorized to delete products.",
    });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 2. Fetch product details
    const prodRes = await client.query(
      "SELECT id, design_code FROM products WHERE id::text = $1 OR design_code = $1 LIMIT 1",
      [id]
    );

    if (prodRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Product not found" });
    }

    const productId = prodRes.rows[0].id;
    const designCode = prodRes.rows[0].design_code;

    // 3. Find associated variants and barcodes
    const variantRes = await client.query(
      "SELECT id, barcode FROM variants WHERE product_id = $1 OR design_code = $2",
      [productId, designCode]
    );

    const variantIds = variantRes.rows.map((v) => v.id);
    const barcodes = variantRes.rows.map((v) => v.barcode).filter(Boolean);

    // 4. HISTORICAL SALES CHECK: Protect past invoices in bill_items
    if (variantIds.length > 0 || barcodes.length > 0) {
      const salesCheck = await client.query(
        `SELECT bi.id, bi.barcode, b.bill_number 
         FROM bill_items bi
         LEFT JOIN bills b ON bi.bill_id = b.id
         WHERE (bi.variant_id IS NOT NULL AND bi.variant_id = ANY($1::uuid[]))
            OR bi.barcode = ANY($2::text[])
         LIMIT 5`,
        [
          variantIds.length > 0 ? variantIds : ["00000000-0000-0000-0000-000000000000"],
          barcodes.length > 0 ? barcodes : ["__NO_BARCODE__"],
        ]
      );

      if (salesCheck.rows.length > 0) {
        await client.query("ROLLBACK");
        const sampleBills = salesCheck.rows
          .map((r) => (r.bill_number ? `Bill #${r.bill_number}` : `Barcode ${r.barcode}`))
          .join(", ");

        return res.status(409).json({
          success: false,
          conflict: true,
          message: `Cannot delete product: One or more variants are referenced in historical bills or invoices (${sampleBills}). Under retail accounting rules, historical financial data cannot be deleted.`,
        });
      }

      // 5. Delete variants if no billing history exists
      await client.query("DELETE FROM variants WHERE product_id = $1 OR design_code = $2", [
        productId,
        designCode,
      ]);
    }

    // 6. Delete parent product
    await client.query("DELETE FROM products WHERE id = $1", [productId]);

    await client.query("COMMIT");
    res.json({
      success: true,
      message: `Product and ${variantRes.rows.length} variant(s) permanently deleted.`,
      deletedVariantsCount: variantRes.rows.length,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ DELETE PRODUCT ERROR:", err);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
});

// -----------------------------------------------------------------------------
// 5. INITIAL DATA (FRONTEND BOOT)
// -----------------------------------------------------------------------------
app.get("/api/initial-data", async (req, res) => {
  try {
    const [products, variants, categories, parentCategories, companies, mappings, sizes, patterns] =
      await Promise.all([
        pool.query(`
          SELECT 
            p.id,
            p.design_code AS "designCode",
            p.category_id AS "categoryId",
            cat.name AS "categoryName",
            COALESCE(pc.name, 'Gents') AS "parentCategory",
            p.company_id AS "companyId",
            cmp.name AS "companyName",
            p.pattern_id AS "patternId",
            pat.name AS "patternName",
            p.created_at AS "createdAt"
          FROM products p
          LEFT JOIN categories cat ON cat.id = p.category_id
          LEFT JOIN parent_categories pc ON pc.id = cat.parent_category_id
          LEFT JOIN companies cmp ON cmp.id = p.company_id
          LEFT JOIN patterns pat ON pat.id = p.pattern_id
          ORDER BY p.id DESC
        `),
        pool.query(`
          SELECT 
            v.id,
            v.product_id AS "productId",
            v.barcode,
            v.design_code AS "designCode",
            v.size,
            v.color,
            v.cost_price AS "costPrice",
            v.mrp,
            v.stock_qty AS "stockQty",
            v.stock_qty AS "stock",
            p.category_id AS "categoryId",
            cat.name AS "categoryName",
            COALESCE(pc.name, 'Gents') AS "parentCategory",
            cmp.name AS "companyName"
          FROM variants v
          LEFT JOIN products p ON p.id = v.product_id
          LEFT JOIN categories cat ON cat.id = p.category_id
          LEFT JOIN parent_categories pc ON pc.id = cat.parent_category_id
          LEFT JOIN companies cmp ON cmp.id = p.company_id
          ORDER BY v.id DESC
        `),
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
        pool.query("SELECT * FROM sizes ORDER BY id ASC"),
        pool.query(`
          SELECT p.id, p.category_id AS "categoryId", p.name, p.code, c.name AS "categoryName"
          FROM patterns p
          LEFT JOIN categories c ON c.id = p.category_id
          ORDER BY p.name ASC
        `),
      ]);

    const formattedMappings = mappings.rows.map((m) => ({
      id: m.id,
      parentCategoryId: m.parent_category_id,
      parentCategory: m.parent_category || "",
      categoryId: m.category_id,
      categoryName: m.category || "",
      companyId: m.company_id,
      companyName: m.company || "",
      patternId: m.pattern_id,
      patternName: m.pattern || "",
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
        patterns: patterns.rows,
        bills: [],
        customers: [],
      },
    });
  } catch (err) {
    console.error("❌ INITIAL DATA ERROR:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// -----------------------------------------------------------------------------
// 6. CATALOG & SETTINGS ROUTES
// -----------------------------------------------------------------------------

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

// Patterns
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

// Sizes
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
    const allowedTypes = ["numeric", "alpha", "kids"];
    const sizeType = allowedTypes.includes(type?.toLowerCase())
      ? type.toLowerCase()
      : isNaN(Number(cleanName))
      ? "alpha"
      : "numeric";
    const numericVal =
      !isNaN(Number(cleanName)) && Number(cleanName) >= 10 && Number(cleanName) <= 100
        ? parseInt(cleanName, 10)
        : null;

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

// -----------------------------------------------------------------------------
// 7. COMPANY MAPPINGS ROUTES
// -----------------------------------------------------------------------------

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

    const formatted = result.rows.map((r) => ({
      id: r.id,
      parentCategoryId: r.parent_category_id,
      parentCategory: r.parent_category || "",
      categoryId: r.category_id,
      categoryName: r.category || "",
      companyId: r.company_id,
      companyName: r.company || "",
      patternId: r.pattern_id,
      patternName: r.pattern || "",
    }));

    res.json({ success: true, mappings: formatted });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/save-mapping", async (req, res) => {
  try {
    const body = req.body;
    const parentCategoryInput = body.parentCategoryId || body.parentCategory || body.parentCategoryName || body.parent;
    const categoryInput = body.categoryId || body.categoryName || body.category;
    const patternIdInput = body.patternId || null;

    const companyInputs =
      Array.isArray(body.companyIds) && body.companyIds.length > 0
        ? body.companyIds
        : body.companyId
        ? [body.companyId]
        : [];

    if (!parentCategoryInput || !categoryInput || companyInputs.length === 0) {
      return res.status(400).json({
        success: false,
        error: "parentCategoryId, categoryId and companyId are required",
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

    // C. Resolve each company mapping
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
      mappings: savedMappings,
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

// -----------------------------------------------------------------------------
// 8. INVENTORY, BILLING & BARCODES
// -----------------------------------------------------------------------------

app.get("/api/inventory/search", async (req, res) => {
  try {
    const query = req.query.query;
    if (!query) return res.json({ success: false, message: "No query provided" });

    const result = await pool.query(
      `
      SELECT v.*, p.design_code AS title
      FROM variants v
      JOIN products p ON v.product_id = p.id
      WHERE 
        p.design_code ILIKE $1 OR
        v.barcode ILIKE $1 OR
        v.design_code ILIKE $1
    `,
      [`%${query}%`]
    );

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
    const variant = await pool.query("SELECT * FROM variants WHERE barcode = $1", [barcode]);
    if (variant.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Barcode not found" });
    }

    const currentStock = variant.rows[0].stock_qty || 0;
    if (currentStock < qty) {
      return res.status(400).json({
        success: false,
        message: `Insufficient stock: Requested ${qty}, available ${currentStock}`,
      });
    }

    await pool.query(
      `UPDATE variants SET stock_qty = stock_qty - $1, updated_at = CURRENT_TIMESTAMP WHERE barcode = $2`,
      [qty, barcode]
    );

    res.json({ success: true, message: `Successfully deducted ${qty} pcs` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
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

      const variant = await client.query("SELECT * FROM variants WHERE barcode = $1", [barcode]);
      if (variant.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ success: false, message: `Barcode ${barcode} not found` });
      }

      const available = variant.rows[0].stock_qty || 0;
      if (available < qty) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          success: false,
          message: `Insufficient stock for ${barcode}: Available ${available}, requested ${qty}`,
        });
      }

      await client.query(
        "UPDATE variants SET stock_qty = stock_qty - $1, updated_at = CURRENT_TIMESTAMP WHERE barcode = $2",
        [qty, barcode]
      );

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
          (row.mrp || 0) * qty,
        ]
      );
    }

    await client.query("COMMIT");
    res.json({ success: true, message: "Bill created successfully", bill_id: billId, total: grand_total });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ success: false, error: err.message });
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
      return res.status(404).json({ success: false, message: "Bill not found" });
    }
    res.json({ success: true, message: "Payment completed", bill: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// -----------------------------------------------------------------------------
// 9. START SERVER
// -----------------------------------------------------------------------------
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});