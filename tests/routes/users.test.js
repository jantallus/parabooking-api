// tests/routes/users.test.js
// Tests d'intégration des routes utilisateurs (CRUD, disponibilités, moniteurs).

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('../../db', () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
}));
jest.mock('stripe', () => () => ({
  checkout: { sessions: { create: jest.fn() } },
}));
jest.mock('../../services/email', () => ({
  sendConfirmationEmail:      jest.fn(),
  sendAdminNotificationEmail: jest.fn(),
  notifyGoogleCalendar:       jest.fn(),
}));
jest.mock('../../services/sentry', () => ({
  initSentry:            () => {},
  sentryErrorMiddleware: (err, req, res, next) => next(err),
}));
jest.mock('../../services/googleSync', () => ({ googleSyncCache: new Map() }));
jest.mock('../../services/ical',       () => ({ generateICalFeed: jest.fn() }));
jest.mock('../../services/pdf',        () => ({
  generatePDFBuffer: jest.fn().mockResolvedValue(Buffer.from('pdf')),
  drawBackground:    jest.fn(),
}));
jest.mock('../../routes/webhook', () => {
  const express = require('express');
  return express.Router();
});
jest.mock('bcrypt', () => ({
  compare: jest.fn(),
  hash:    jest.fn().mockResolvedValue('$hashed'),
}));

// ── Setup ──────────────────────────────────────────────────────────────────────

const request  = require('supertest');
const jwt      = require('jsonwebtoken');
const bcrypt   = require('bcrypt');
const { pool } = require('../../db');

let app;
beforeAll(() => { app = require('../../app'); });
beforeEach(() => {
  jest.resetAllMocks();
  // Restaure l'implémentation de bcrypt après resetAllMocks
  bcrypt.hash.mockResolvedValue('$hashed');
  pool.connect.mockResolvedValue({
    query:   jest.fn().mockResolvedValue({ rows: [] }),
    release: jest.fn(),
  });
});

const JWT_SECRET  = process.env.JWT_SECRET;
const adminToken  = () => jwt.sign({ id: 1, role: 'admin',   email: 'a@test.com' }, JWT_SECRET, { expiresIn: '1h' });
const monitorToken= () => jwt.sign({ id: 2, role: 'monitor', email: 'm@test.com' }, JWT_SECRET, { expiresIn: '1h' });
const userToken   = () => jwt.sign({ id: 3, role: 'permanent', email: 'p@test.com' }, JWT_SECRET, { expiresIn: '1h' });

const VALID_USER = {
  first_name: 'Jean',
  email:      'jean@test.com',
  password:   'motdepasse123',
  role:       'monitor',
};

// ── GET /api/users ─────────────────────────────────────────────────────────────

describe('GET /api/users', () => {
  it('retourne 401 sans token', async () => {
    expect((await request(app).get('/api/users')).status).toBe(401);
  });

  it('retourne 403 si rôle non-admin', async () => {
    const res = await request(app)
      .get('/api/users')
      .set('Authorization', `Bearer ${monitorToken()}`);
    expect(res.status).toBe(403);
  });

  it('retourne 200 avec la liste des utilisateurs pour un admin', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 1, first_name: 'Admin', email: 'a@test.com', role: 'admin' }],
    });

    const res = await request(app)
      .get('/api/users')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0].role).toBe('admin');
  });
});

// ── POST /api/users ────────────────────────────────────────────────────────────

describe('POST /api/users', () => {
  it('retourne 401 sans token', async () => {
    expect((await request(app).post('/api/users').send(VALID_USER)).status).toBe(401);
  });

  it('retourne 400 si Zod invalide (password trop court)', async () => {
    const res = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ ...VALID_USER, password: 'court' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Données invalides/);
  });

  it('retourne 400 si le rôle est inconnu', async () => {
    const res = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ ...VALID_USER, role: 'superadmin' });

    expect(res.status).toBe(400);
  });

  it('crée un utilisateur et retourne id, first_name, role', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 10, first_name: 'Jean', role: 'monitor' }] });

    const res = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send(VALID_USER);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 10, first_name: 'Jean', role: 'monitor' });
    // Vérifie que le mot de passe a été hashé avant insertion
    expect(pool.query.mock.calls[0][1]).toContain('$hashed');
  });
});

// ── PATCH /api/users/:id ───────────────────────────────────────────────────────

describe('PATCH /api/users/:id', () => {
  it('retourne 401 sans token', async () => {
    expect((await request(app).patch('/api/users/3').send({ first_name: 'Test' })).status).toBe(401);
  });

  it('retourne 403 si un user tente de modifier le profil d\'un autre', async () => {
    const res = await request(app)
      .patch('/api/users/99') // id 99 ≠ userToken id (3)
      .set('Authorization', `Bearer ${userToken()}`)
      .send({ first_name: 'Pirate' });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/propre profil/);
  });

  it('permet à un user de modifier son propre profil', async () => {
    // Pour un non-admin, le middleware relit role/status depuis la DB
    pool.query
      .mockResolvedValueOnce({ rows: [{ role: 'permanent', is_active_monitor: false, status: 'Actif' }] }) // SELECT check
      .mockResolvedValueOnce({ rows: [] }); // UPDATE

    const res = await request(app)
      .patch('/api/users/3') // id 3 = userToken id
      .set('Authorization', `Bearer ${userToken()}`)
      .send({ first_name: 'Paul', email: 'paul@test.com' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('permet à un admin de modifier n\'importe quel profil', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] }); // UPDATE

    const res = await request(app)
      .patch('/api/users/99')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ first_name: 'Modifié', email: 'mod@test.com', role: 'monitor' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('hashe le nouveau mot de passe si fourni', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ role: 'permanent', is_active_monitor: false, status: 'Actif' }] })
      .mockResolvedValueOnce({ rows: [] });

    await request(app)
      .patch('/api/users/3')
      .set('Authorization', `Bearer ${userToken()}`)
      .send({ first_name: 'Paul', email: 'paul@test.com', password: 'nouveau_mdp_123' });

    // L'UPDATE avec password doit contenir '$hashed'
    const updateCall = pool.query.mock.calls.find(c => typeof c[0] === 'string' && c[0].includes('password_hash'));
    expect(updateCall).toBeDefined();
    expect(updateCall[1]).toContain('$hashed');
  });
});

// ── DELETE /api/users/:id ──────────────────────────────────────────────────────

describe('DELETE /api/users/:id', () => {
  it('retourne 401 sans token', async () => {
    expect((await request(app).delete('/api/users/2')).status).toBe(401);
  });

  it('supprime l\'utilisateur et retourne success', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .delete('/api/users/2')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

// ── GET /api/monitors ──────────────────────────────────────────────────────────

describe('GET /api/monitors', () => {
  it('retourne 200 sans authentification (route publique)', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 2, first_name: 'Sophie' }] });

    const res = await request(app).get('/api/monitors');

    expect(res.status).toBe(200);
    expect(res.body[0].first_name).toBe('Sophie');
  });
});

// ── GET /api/monitors-admin ────────────────────────────────────────────────────

describe('GET /api/monitors-admin', () => {
  it('retourne 401 sans token', async () => {
    expect((await request(app).get('/api/monitors-admin')).status).toBe(401);
  });

  it('retourne tous les moniteurs pour un admin', async () => {
    pool.query.mockResolvedValueOnce({ rows: [
      { id: 1, first_name: 'Admin', role: 'admin' },
      { id: 2, first_name: 'Sophie', role: 'monitor' },
    ]});

    const res = await request(app)
      .get('/api/monitors-admin')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });

  // Voulu : un moniteur temporaire doit pouvoir joindre les autres moniteurs
  it('renvoie la liste complète à un moniteur', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 2, first_name: 'Sophie', role: 'monitor' }, { id: 4, first_name: 'Paul', role: 'monitor' }] });

    const res = await request(app)
      .get('/api/monitors-admin')
      .set('Authorization', `Bearer ${monitorToken()}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(pool.query.mock.calls[0][0]).not.toContain('AND id = $1');
  });
});

// ── GET /api/users/:id/availabilities ─────────────────────────────────────────

describe('GET /api/users/:id/availabilities', () => {
  it('retourne 401 sans token', async () => {
    expect((await request(app).get('/api/users/1/availabilities')).status).toBe(401);
  });

  it('retourne les disponibilités formatées', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 1, start_date: '2025-06-01', end_date: '2025-06-30' }] });

    const res = await request(app)
      .get('/api/users/1/availabilities')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

// ── PUT /api/users/:id/availabilities ─────────────────────────────────────────

describe('PUT /api/users/:id/availabilities', () => {
  it('retourne 401 sans token', async () => {
    expect((await request(app).put('/api/users/1/availabilities').send({ availabilities: [] })).status).toBe(401);
  });

  it('remplace les disponibilités dans une transaction', async () => {
    const fakeClient = { query: jest.fn().mockResolvedValue({ rows: [] }), release: jest.fn() };
    pool.connect.mockResolvedValueOnce(fakeClient);

    const res = await request(app)
      .put('/api/users/1/availabilities')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ availabilities: [{ start_date: '2025-06-01', end_date: '2025-06-30', daily_start_time: '09:00', daily_end_time: '17:00' }] });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // BEGIN → DELETE → INSERT → COMMIT
    const queries = fakeClient.query.mock.calls.map(c => c[0]);
    expect(queries[0]).toBe('BEGIN');
    expect(queries.some(q => q.includes('DELETE FROM monitor_availabilities'))).toBe(true);
    expect(queries.some(q => q.includes('INSERT INTO monitor_availabilities'))).toBe(true);
    expect(queries[queries.length - 1]).toBe('COMMIT');
  });
});
