// tests/routes/takamaka.test.js
// Endpoints partenaire Takamaka : lecture des créneaux et blocage.

jest.mock('../../db', () => ({
  pool: { query: jest.fn(), connect: jest.fn() },
}));
jest.mock('stripe', () => () => ({
  checkout: { sessions: { create: jest.fn() } },
}));
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

const API_KEY = 'test-takamaka-key';
let app;
beforeAll(() => {
  process.env.TAKAMAKA_API_KEY = API_KEY;
  app = require('../../app');
});

// 2027-02-08 en hiver : Paris = UTC+1, donc 10:40Z = 11:40 à Paris
const slot = (id, monitorId, utcStart, minutes = 20) => {
  const start = new Date(`2027-02-08T${utcStart}:00Z`);
  return { id, monitor_id: monitorId, start_time: start, end_time: new Date(start.getTime() + minutes * 60000) };
};

const DEFAULT_SLOTS = [
  slot(1, 10, '10:40'), slot(2, 10, '11:00'),   // moniteur 10 : 11:40 + 12:00 contigus
  slot(3, 11, '10:40'), slot(4, 11, '11:00'),   // moniteur 11 : idem
  slot(5, 12, '12:00'), slot(6, 12, '12:20'),   // 13:00 : hors horaires autorisés
];

function fakeDb({ flightType = { duration_minutes: 40, allowed_time_slots: ['11:40', '12:00'], booking_delay_hours: 24 },
                  slots = DEFAULT_SLOTS, partner = { id: 7, name: 'Takamaka', code: 'TAKAMAKA', color_code: '#f00' },
                  existing = [] } = {}) {
  const updates = [];
  const query = jest.fn(async (sql, params) => {
    if (sql.includes('FROM flight_types WHERE id = $1 AND is_active')) return { rows: flightType ? [flightType] : [] };
    if (sql.includes('SELECT name FROM flight_types')) return { rows: [{ name: 'Beauregard Hiver' }] };
    if (sql.includes("FROM slots\n     WHERE status = 'available'")) return { rows: slots };
    if (sql.includes('FROM monitor_availabilities')) return { rows: [] };
    if (sql.includes('google_calendar_sync')) return { rows: [] };
    if (sql.includes('FROM partners')) return { rows: partner ? [partner] : [] };
    if (sql.includes("payment_data->>'partner_ref'")) return { rows: existing };
    if (sql.startsWith('UPDATE slots')) { updates.push(params); return { rows: [] }; }
    return { rows: [] };
  });
  const client = { query, release: jest.fn() };
  pool.query.mockImplementation(query);
  pool.connect.mockResolvedValue(client);
  return { query, client, updates };
}

beforeEach(() => { jest.clearAllMocks(); });

describe('GET /api/public/takamaka/slots', () => {
  it('retourne 400 sans from/to', async () => {
    const res = await request(app).get('/api/public/takamaka/slots');
    expect(res.status).toBe(400);
  });

  it('retourne 400 au-delà de 31 jours', async () => {
    const res = await request(app).get('/api/public/takamaka/slots?from=2027-01-01&to=2027-02-01');
    expect(res.status).toBe(400);
  });

  it('retourne 400 si to est avant from', async () => {
    const res = await request(app).get('/api/public/takamaka/slots?from=2027-02-10&to=2027-02-08');
    expect(res.status).toBe(400);
  });

  it('compte les moniteurs libres sur toute la durée du vol, aux horaires autorisés', async () => {
    fakeDb();
    const res = await request(app).get('/api/public/takamaka/slots?from=2027-02-08&to=2027-02-14');
    expect(res.status).toBe(200);
    // 12:00 exclu : il faudrait 12:00 + 12:20 ; 13:00 exclu : hors horaires autorisés
    expect(res.body).toEqual({ '2027-02-08': { '11:40': 2 } });
  });

  it('exclut les créneaux dans le délai minimum de réservation', async () => {
    fakeDb({ flightType: { duration_minutes: 40, allowed_time_slots: ['11:40'], booking_delay_hours: 720 * 100 } });
    const res = await request(app).get('/api/public/takamaka/slots?from=2027-02-08&to=2027-02-14');
    expect(res.body).toEqual({});
  });
});

describe('POST /api/public/takamaka/book', () => {
  const body = { date: '2027-02-08', time: '11:40', nb_passengers: 1, partner_ref: 'TK-2027-00142' };

  it('retourne 401 sans clé', async () => {
    const res = await request(app).post('/api/public/takamaka/book').send(body);
    expect(res.status).toBe(401);
  });

  it('retourne 401 avec une mauvaise clé', async () => {
    const res = await request(app).post('/api/public/takamaka/book').set('X-API-Key', 'nope').send(body);
    expect(res.status).toBe(401);
  });

  it('retourne 400 si partner_ref contient du HTML', async () => {
    const res = await request(app).post('/api/public/takamaka/book').set('X-API-Key', API_KEY)
      .send({ ...body, partner_ref: '<b>x</b>' });
    expect(res.status).toBe(400);
  });

  it('retourne 503 si le partenaire TAKAMAKA n\'existe pas', async () => {
    fakeDb({ partner: null });
    const res = await request(app).post('/api/public/takamaka/book').set('X-API-Key', API_KEY).send(body);
    expect(res.status).toBe(503);
  });

  it('retourne 409 s\'il n\'y a pas assez de moniteurs', async () => {
    const { updates } = fakeDb();
    const res = await request(app).post('/api/public/takamaka/book').set('X-API-Key', API_KEY)
      .send({ ...body, nb_passengers: 3 });
    expect(res.status).toBe(409);
    expect(res.body.available).toBe(2);
    expect(updates).toHaveLength(0);
  });

  it('bloque un moniteur sur toute la durée du vol et marque la réservation partenaire', async () => {
    const { updates, client } = fakeDb();
    const res = await request(app).post('/api/public/takamaka/book').set('X-API-Key', API_KEY).send(body);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ booking_id: 1, slot_ids: [1], date: '2027-02-08', time: '11:40', status: 'confirmed' });
    expect(updates.map(u => u[4])).toEqual([1, 2]);
    expect(updates[0][0]).toBe('Takamaka TK-2027-00142');
    expect(updates[1][0]).toBe('↪️ Suite Takamaka TK-2027-00142');
    const pd = JSON.parse(updates[0][3]);
    expect(pd).toMatchObject({ partner: true, partner_id: 7, partner_ref: 'TK-2027-00142' });
    expect(client.query).toHaveBeenCalledWith('COMMIT');
    expect(client.release).toHaveBeenCalled();
  });

  it('bloque deux moniteurs différents pour 2 passagers', async () => {
    const { updates } = fakeDb();
    const res = await request(app).post('/api/public/takamaka/book').set('X-API-Key', API_KEY)
      .send({ ...body, nb_passengers: 2 });
    expect(res.status).toBe(200);
    expect(res.body.slot_ids).toEqual([1, 3]);
    expect(updates.map(u => u[4])).toEqual([1, 2, 3, 4]);
  });

  it('ne réserve pas deux fois la même référence', async () => {
    const { updates } = fakeDb({ existing: [{ id: 1, start_time: new Date('2027-02-08T10:40:00Z') }] });
    const res = await request(app).post('/api/public/takamaka/book').set('X-API-Key', API_KEY).send(body);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ booking_id: 1, already_booked: true, time: '11:40' });
    expect(updates).toHaveLength(0);
  });
});
