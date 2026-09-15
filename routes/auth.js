const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { pool } = db;

const JWT_SECRET = process.env.JWT_SECRET;

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  message: { error: 'Trop de tentatives de connexion. Réessayez dans 15 minutes.' },
  standardHeaders: true, legacyHeaders: false,
});


router.post('/api/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body;
  try {
    const r = await pool.query("SELECT * FROM users WHERE LOWER(email) = LOWER($1)", [email]);
    if (r.rows.length === 0) return res.status(401).json({ error: "Identifiants incorrects" });

    const user = r.rows[0];
    const isCorrectPassword = await bcrypt.compare(password, user.password_hash);

    if (!isCorrectPassword) {
      return res.status(401).json({ error: "Identifiants incorrects" });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, enseigne: user.enseigne || (user.role === 'aravis' ? 'aravis' : 'fluide') },
      JWT_SECRET,
      { expiresIn: '30m' }
    );

    // Cookie HttpOnly : inaccessible depuis JavaScript (protège contre le XSS)
    const isProduction = process.env.NODE_ENV === 'production';
    res.cookie('auth_token', token, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax', // 'strict' bloque les cookies cross-origin (ex: Railway frontend ≠ backend)
      maxAge: 30 * 60 * 1000,
      path: '/',
    });

    res.json({
      token, // Nécessaire pour l'authentification des requêtes admin
      user: { id: user.id, first_name: user.first_name, email: user.email, role: user.role, enseigne: user.enseigne || (user.role === 'aravis' ? 'aravis' : 'fluide') }
    });

  } catch (err) {
    console.error("ERREUR CRITIQUE LOGIN:", err);
    res.status(500).json({ error: "Erreur serveur lors de la connexion" });
  }
});

router.post('/api/logout', (req, res) => {
  res.clearCookie('auth_token', { path: '/' });
  res.json({ success: true });
});


module.exports = router;
