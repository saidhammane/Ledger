import express from 'express';
import bcrypt from 'bcryptjs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { pool } from './db.js';

export const authRouter = express.Router();
const SESSION_COOKIE = 'ledger_session';
const CSRF_COOKIE = 'ledger_csrf';
const SESSION_DAYS = 14;
const attempts = new Map();

const hash = value => createHash('sha256').update(value).digest('hex');
const email = value => String(value || '').trim().toLowerCase();
const cookie = (req, name) => (req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith(name + '='))?.slice(name.length + 1) || '';
const secureCookie = process.env.NODE_ENV === 'production' ? '; Secure' : '';
const setCookie = (res, name, value, options = '') => res.append('Set-Cookie', `${name}=${value}; Path=/; ${options}${secureCookie}`);
const safeUser = user => ({id:user.id, name:user.name, email:user.email, emailVerified:Boolean(user.email_verified)});

export function csrfMiddleware(req, res, next) {
  const existing = cookie(req, CSRF_COOKIE);
  if (!existing) setCookie(res, CSRF_COOKIE, randomBytes(24).toString('hex'), 'SameSite=Strict');
  if (existing && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && existing !== req.get('x-csrf-token')) return res.status(403).json({error:'CSRF token rejected.'});
  next();
}

export async function optionalAuth(req, res, next) {
  const raw = cookie(req, SESSION_COOKIE);
  if (!raw) return next();
  try {
    const [[user]] = await pool.query('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND s.expires_at > UTC_TIMESTAMP()', [hash(raw)]);
    if (user) {
      req.user = user;
      await pool.execute('UPDATE sessions SET last_seen_at=UTC_TIMESTAMP() WHERE id=?', [hash(raw)]);
    }
  } catch {}
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({error:'Authentication required.'});
  next();
}

function rateLimited(key) {
  const now = Date.now();
  const recent = (attempts.get(key) || []).filter(time => now - time < 15 * 60 * 1000);
  attempts.set(key, recent);
  return recent.length >= 10;
}

function markAttempt(key) {
  attempts.set(key, [...(attempts.get(key) || []), Date.now()]);
}

async function createSession(userId, res) {
  const raw = randomBytes(32).toString('hex');
  await pool.execute('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? DAY))', [hash(raw), userId, SESSION_DAYS]);
  setCookie(res, SESSION_COOKIE, raw, 'HttpOnly; SameSite=Strict; Max-Age=1209600');
}

authRouter.post('/register', async (req, res, next) => {
  try {
    const name = String(req.body?.name || '').trim();
    const userEmail = email(req.body?.email);
    const password = String(req.body?.password || '');
    if (name.length < 2 || name.length > 160 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(userEmail) || password.length < 12 || password.length > 200) return res.status(400).json({error:'Use a valid name, email, and password of 12 to 200 characters.'});
    const id = randomUUID();
    await pool.execute('INSERT INTO users (id,name,email,password_hash) VALUES (?,?,?,?)', [id, name, userEmail, await bcrypt.hash(password, 12)]);
    await createSession(id, res);
    const [[user]] = await pool.query('SELECT * FROM users WHERE id=?', [id]);
    res.status(201).json({user:safeUser(user)});
  } catch (error) { if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({error:'That email address is already registered.'}); next(error); }
});

authRouter.post('/login', async (req, res, next) => {
  try {
    const userEmail = email(req.body?.email);
    const key = `${req.ip}:${userEmail}`;
    if (rateLimited(key)) return res.status(429).json({error:'Too many login attempts. Try again later.'});
    const [[user]] = await pool.query('SELECT * FROM users WHERE email=?', [userEmail]);
    if (!user || !(await bcrypt.compare(String(req.body?.password || ''), user.password_hash))) { markAttempt(key); return res.status(401).json({error:'Invalid email or password.'}); }
    await createSession(user.id, res);
    res.json({user:safeUser(user)});
  } catch (error) { next(error); }
});

authRouter.post('/logout', async (req, res, next) => {
  try { const raw = cookie(req, SESSION_COOKIE); if (raw) await pool.execute('DELETE FROM sessions WHERE id=?', [hash(raw)]); setCookie(res, SESSION_COOKIE, '', 'HttpOnly; SameSite=Strict; Max-Age=0'); res.status(204).end(); } catch (error) { next(error); }
});

authRouter.get('/me', requireAuth, (req, res) => res.json({user:safeUser(req.user)}));

authRouter.put('/profile', requireAuth, async (req, res, next) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (name.length < 2 || name.length > 160) return res.status(400).json({error:'Name must be between 2 and 160 characters.'});
    await pool.execute('UPDATE users SET name=? WHERE id=?', [name, req.user.id]);
    req.user.name = name;
    res.json({user:safeUser(req.user)});
  } catch (error) { next(error); }
});

authRouter.put('/password', requireAuth, async (req, res, next) => {
  try {
    const current = String(req.body?.currentPassword || ''), nextPassword = String(req.body?.newPassword || '');
    if (nextPassword.length < 12 || nextPassword.length > 200 || !(await bcrypt.compare(current, req.user.password_hash))) return res.status(400).json({error:'Current password or new password is invalid.'});
    await pool.execute('UPDATE users SET password_hash=? WHERE id=?', [await bcrypt.hash(nextPassword, 12), req.user.id]);
    await pool.execute('DELETE FROM sessions WHERE user_id=?', [req.user.id]);
    await createSession(req.user.id, res);
    res.status(204).end();
  } catch (error) { next(error); }
});

authRouter.post('/password-reset/request', async (req, res, next) => {
  try {
    const userEmail = email(req.body?.email);
    const [[user]] = await pool.query('SELECT id FROM users WHERE email=?', [userEmail]);
    if (!user) return res.json({message:'If that email exists, a reset has been created.'});
    const raw = randomBytes(32).toString('hex');
    await pool.execute('INSERT INTO password_reset_tokens (id,user_id,expires_at) VALUES (?,?,DATE_ADD(UTC_TIMESTAMP(), INTERVAL 30 MINUTE))', [hash(raw), user.id]);
    const response = {message:'If that email exists, a reset has been created.'};
    if (process.env.NODE_ENV !== 'production' && !process.env.SMTP_HOST) response.devResetToken = raw;
    res.json(response);
  } catch (error) { next(error); }
});

authRouter.post('/password-reset/confirm', async (req, res, next) => {
  const connection = await pool.getConnection();
  try {
    const token = String(req.body?.token || ''), password = String(req.body?.password || '');
    if (password.length < 12 || password.length > 200) return res.status(400).json({error:'Password must be between 12 and 200 characters.'});
    const [[record]] = await connection.query('SELECT * FROM password_reset_tokens WHERE id=? AND used_at IS NULL AND expires_at > UTC_TIMESTAMP()', [hash(token)]);
    if (!record) return res.status(400).json({error:'Reset token is invalid or expired.'});
    await connection.beginTransaction();
    await connection.execute('UPDATE users SET password_hash=? WHERE id=?', [await bcrypt.hash(password, 12), record.user_id]);
    await connection.execute('UPDATE password_reset_tokens SET used_at=UTC_TIMESTAMP() WHERE id=?', [record.id]);
    await connection.execute('DELETE FROM sessions WHERE user_id=?', [record.user_id]);
    await connection.commit();
    res.status(204).end();
  } catch (error) { await connection.rollback().catch(() => {}); next(error); }
  finally { connection.release(); }
});
