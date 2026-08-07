const express = require('express');
const bcrypt = require('bcrypt');
//const { Pool } = require('pg');

const router = express.Router();

//const pool = new Pool({
  //connectionString: process.env.DATABASE_URL,
//});
const pool = require('../db');

// CREATE STAFF
router.post('/users', async (req, res) => {
  const { name, username, password } = req.body;

  try {
    const hashedPassword = await bcrypt.hash(password, 10);

    await pool.query(
      'INSERT INTO users (name, username, password, role) VALUES ($1,$2,$3,$4)',
      [name, username, hashedPassword, 'staff']
    );

    res.json({ msg: 'User created' });

  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: 'Error creating user' });
  }
});

module.exports = router;