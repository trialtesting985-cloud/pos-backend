const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
//const { Pool } = require('pg');

const router = express.Router();

/*const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});*/
const pool = require('../db');

// LOGIN API
// LOGIN API
router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  try {
    const result = await pool.query(
      'SELECT * FROM users WHERE username = $1',
      [username]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'User not found'
      });
    }

    const user = result.rows[0];

    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      return res.status(400).json({
        success: false,
        message: 'Wrong password'
      });
    }

    const token = jwt.sign(
      { id: user.id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '1d' }
    );

    // ✅ FIX: read from DB
    const mustChangePassword = user.mustchangepassword===true;

    res.json({
      success: true,
      token,
      
      user: {
        id: user.id,
        name: user.name,
        role: user.role,
        mustChangePassword: user.must_change_password,
        passwordUpdatedAt: user.password_updated_at
      },
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});
module.exports = router;