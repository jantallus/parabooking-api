// tests/routes/availabilities.test.js
// Statuts renvoyés par /api/public/availabilities : available / booked (client) / unavailable.

jest.mock('../../db', () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
}));
jest.mock('stripe', () => () => ({ checkout: { sessions: { create: jest.fn() } } }));
jest.mock('../../services/email', () => ({
  sendConfirmationEmail:      jest.fn(),
  sendConfirmationSMS:        jest.fn(),
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

const request = require('supertest');
const { pool } = require('../../db');

let app;
beforeAll(() => { app = require('../../app'); });

const slot = (id, status, title) => ({
  id, status, title, monitor_id: 2,
  start_time: new Date('2026-12-14T10:40:00Z'), end_time: new Date('2026-12-14T11:20:00Z'),
});

function mockSlots(rows) {
  pool.query.mockImplementation(async (sql) => (sql.includes('FROM slots') ? { rows } : { rows: [] }));
}

describe('GET /api/public/availabilities', () => {
  it('distingue réservation client et indisponibilité, sans exposer le titre', async () => {
    mockSlots([
      slot(1, 'available', null),
      slot(2, 'booked', 'Marie DUPONT'),
      slot(3, 'booked', '↪️ Suite Marie DUPONT'),
      slot(4, 'booked', '☕ PAUSE'),
      slot(5, 'booked', 'NON DISPO (Admin)'),
      slot(6, 'booked', 'NOTE'),
      slot(7, 'booked', null),
    ]);

    const res = await request(app).get('/api/public/availabilities?start=2026-12-14&end=2026-12-14');

    expect(res.status).toBe(200);
    expect(res.body.map(s => s.status)).toEqual([
      'available', 'booked', 'booked', 'unavailable', 'unavailable', 'unavailable', 'unavailable',
    ]);
    res.body.forEach(s => expect(s).not.toHaveProperty('title'));
  });

  it('marque indisponibles les horaires non autorisés pour le vol', async () => {
    pool.query.mockImplementation(async (sql) => {
      if (sql.includes('allowed_time_slots')) return { rows: [{ allowed_time_slots: ['09:40'] }] };
      if (sql.includes('FROM slots')) return { rows: [slot(1, 'available', null)] };
      return { rows: [] };
    });

    const res = await request(app).get('/api/public/availabilities?start=2026-12-14&end=2026-12-14&flight_type_id=19');

    expect(res.body[0].status).toBe('unavailable');
  });
});
