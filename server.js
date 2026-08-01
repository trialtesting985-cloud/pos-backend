const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

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

// ----------------------
// BASIC ROUTES
// ----------------------

// Health check
app.get("/", (req, res) => {
  res.send("POS Backend Running ✅");
});

// DB test route
app.get("/api/test-db", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");
    res.json({
      success: true,
      server_time: result.rows[0],
    });
  } catch (err) {
    console.error("DB Error:", err.message);
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

// ----------------------
// SAMPLE INVENTORY ROUTE (TEST)
// ----------------------
app.get("/api/inventory/search", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM products LIMIT 10");
    res.json({
      success: true,
      data: result.rows,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

// ----------------------
// SERVER START
// ----------------------
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});

// ----------------------
// STOCK IN (ADD STOCK)
// ----------------------
app.post("/api/stock/in", async (req, res) => {
  const { barcode, qty } = req.body;

  try {
    // Check variant exists
    const variant = await pool.query(
      "SELECT * FROM variants WHERE barcode = $1",
      [barcode]
    );

    if (variant.rows.length === 0) {
      return res.json({
        success: false,
        message: "Barcode not found"
      });
    }

    // Update stock
    await pool.query(
      `UPDATE variants 
       SET stock_qty = stock_qty + $1, updated_at = CURRENT_TIMESTAMP
       WHERE barcode = $2`,
      [qty, barcode]
    );

    // Insert stock log
    await pool.query(
      `INSERT INTO stock_history 
       (id, variant_id, barcode, design_code, product_title, qty, type, reason)
       VALUES (
         $1, $2, $3, $4, $5, $6, 'IN', 'Manual Stock In'
       )`,
      [
        "sh-" + Date.now(),
        variant.rows[0].id,
        barcode,
        variant.rows[0].design_code,
        "Manual Entry",
        qty
      ]
    );

    res.json({
      success: true,
      message: "Stock added successfully"
    });

  } catch (err) {
    res.json({
      success: false,
      error: err.message
    });
  }
});

// ----------------------
// STOCK OUT (SELL)
// ----------------------
app.post("/api/stock/out", async (req, res) => {
  const { barcode, qty } = req.body;

  try {
    const result = await pool.query(
      `SELECT deduct_inventory_stock_atomic($1, $2, 'staff') AS result`,
      [barcode, qty]
    );

    res.json(result.rows[0].result);

  } catch (err) {
    res.json({
      success: false,
      error: err.message
    });
  }
});

app.post("/api/bills/create", async (req, res) => {
  const { items, payment_mode, customer_name } = req.body;

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    let grand_total = 0;

    // Step 1: process each item
    for (const item of items) {
      const { barcode, qty } = item;

      // Deduct stock using DB function
      const result = await client.query(
        `SELECT deduct_inventory_stock_atomic($1, $2, 'staff') AS result`,
        [barcode, qty]
      );

      const response = result.rows[0].result;

      if (!response.success) {
        await client.query("ROLLBACK");
        return res.json(response);
      }

      // Fetch price
      const variant = await client.query(
        "SELECT mrp FROM variants WHERE barcode = $1",
        [barcode]
      );

      const price = variant.rows[0].mrp;
      grand_total += price * qty;
    }

    // Step 2: create bill
    const billId = "bill-" + Date.now();

    await client.query(
      `INSERT INTO bills (id, bill_number, customer_name, payment_mode, grand_total)
       VALUES ($1, $2, $3, $4, $5)`,
      [billId, Date.now(), customer_name, payment_mode, grand_total]
    );

    // Step 3: insert bill items
    for (const item of items) {
      const { barcode, qty } = item;

      const variant = await client.query(
        "SELECT * FROM variants WHERE barcode = $1",
        [barcode]
      );

      await client.query(
        `INSERT INTO bill_items 
        (bill_id, variant_id, barcode, design_code, title, color, size, qty, unit_mrp, final_price)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          billId,
          variant.rows[0].id,
          barcode,
          variant.rows[0].design_code,
          "POS Sale",
          variant.rows[0].color,
          variant.rows[0].size,
          qty,
          variant.rows[0].mrp,
          variant.rows[0].mrp * qty
        ]
      );
    }

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "Bill created successfully",
      bill_id: billId,
      total: grand_total
    });

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
       SET payment_mode = $1,
           cash_collected = $2,
           upi_collected = $3,
           card_collected = $4,
           status = 'completed'
       WHERE id = $5
       RETURNING *`,
      [payment_mode, cash || 0, upi || 0, card || 0, bill_id]
    );

    if (result.rows.length === 0) {
      return res.json({ success: false, message: "Bill not found" });
    }

    res.json({
      success: true,
      message: "Payment completed",
      bill: result.rows[0]
    });

  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});
app.get("/api/bills/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const bill = await pool.query(
      "SELECT * FROM bills WHERE id = $1",
      [id]
    );

    const items = await pool.query(
      "SELECT * FROM bill_items WHERE bill_id = $1",
      [id]
    );

    if (bill.rows.length === 0) {
      return res.json({ success: false, message: "Bill not found" });
    }

    res.json({
      success: true,
      bill: bill.rows[0],
      items: items.rows
    });

  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});
app.get("/api/barcode/:code", async (req, res) => {
  const { code } = req.params;

  try {
    const result = await pool.query(
      "SELECT * FROM variants WHERE barcode = $1",
      [code]
    );

    if (result.rows.length === 0) {
      return res.json({
        success: false,
        message: "Item not found"
      });
    }

    res.json({
      success: true,
      item: result.rows[0]
    });

  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});