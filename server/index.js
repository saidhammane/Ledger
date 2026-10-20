import express from 'express';
import helmet from 'helmet';
import { fileURLToPath } from 'node:url';
import { pool, readState } from './db.js';
import { validateState, ValidationError } from './validation.js';
import { authRouter, csrfMiddleware, optionalAuth } from './auth.js';
import { financeRouter } from './finance.js';

const app = express();
const configuredOrigins = new Set((process.env.ALLOWED_ORIGINS || process.env.APP_ORIGIN || '').split(',').map(value => value.trim()).filter(Boolean));
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3000);
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({contentSecurityPolicy:false}));
app.use(express.json({limit:'8mb'}));
app.use(optionalAuth);
app.use('/api', (req,res,next) => {
  res.set('Cache-Control','no-store');
  if (!['GET','HEAD'].includes(req.method)) {
    const origin = req.get('origin');
    const requestHost = req.get('host');
    const hostOrigins = requestHost ? new Set([`http://${requestHost}`, `https://${requestHost}`]) : new Set();
    if (req.get('x-loan-client') !== 'dashboard' || (origin && !configuredOrigins.has(origin) && !hostOrigins.has(origin))) return res.status(403).json({error:'Request origin rejected.'});
  }
  next();
});
app.use('/api/auth', csrfMiddleware, authRouter);
app.use('/api/finance', csrfMiddleware, financeRouter);
app.get('/api/health',async (req,res,next) => {
  try { await pool.query('SELECT 1'); res.json({status:'ok',database:'mysql'}); } catch(e) { next(e); }
});
async function requireLegacyAccess(req, res) {
  if (req.user) return true;
  const [[row]] = await pool.query('SELECT COUNT(*) AS count FROM users');
  if (Number(row.count) > 0) { res.status(401).json({error:'Authentication required.'}); return false; }
  return true;
}
app.get('/api/state',async (req,res,next) => {
  if (!(await requireLegacyAccess(req, res))) return;
  if (req.user) {
    try {
      const [[row]] = await pool.query('SELECT revision,state FROM user_legacy_state WHERE user_id=?', [req.user.id]);
          const snapshot = row ? (typeof row.state === 'string' ? JSON.parse(row.state) : row.state) : {loans:[],payments:[],income:[]};
          return res.json({...snapshot, revision:row ? Number(row.revision) : 0});
    } catch(e) { return next(e); }
  }
  const c = await pool.getConnection().catch(next); if (!c) return;
  try { await c.beginTransaction(); const state = await readState(c); await c.commit(); res.json(state); }
  catch(e) { await c.rollback(); next(e); } finally { c.release(); }
});
app.put('/api/state',async (req,res,next) => {
  let c;
  try {
    if (!(await requireLegacyAccess(req, res))) return;
    const state = validateState(req.body);
    if (!Number.isSafeInteger(state.revision) || state.revision < 0) throw new ValidationError('Missing revision. Reload the dashboard.');
    if (req.user) {
      c = await pool.getConnection(); await c.beginTransaction();
      const [[row]] = await c.query('SELECT revision FROM user_legacy_state WHERE user_id=? FOR UPDATE', [req.user.id]);
      const currentRevision = row ? Number(row.revision) : 0;
      if (currentRevision !== state.revision) { await c.rollback(); return res.status(409).json({error:'Data changed in another tab. Reload before saving.'}); }
      const nextRevision = currentRevision + 1;
      const snapshot = JSON.stringify({loans:state.loans,payments:state.payments,income:state.income});
      await c.execute(`INSERT INTO user_legacy_state (user_id,revision,state) VALUES (?,?,?) ON DUPLICATE KEY UPDATE revision=VALUES(revision),state=VALUES(state)`, [req.user.id,nextRevision,snapshot]);
      await c.execute('INSERT INTO financial_audit (actor_user_id,entity_type,entity_id,action,after_json) VALUES (?,?,?,?,?)', [req.user.id,'legacy_state',req.user.id,'updated',snapshot]);
      await c.commit(); return res.json({revision:nextRevision});
    }
    c = await pool.getConnection(); await c.beginTransaction();
    const [[meta]] = await c.query('SELECT revision FROM app_meta WHERE id=1 FOR UPDATE');
    if (Number(meta.revision) !== state.revision) { await c.rollback(); return res.status(409).json({error:'Data changed in another tab. Reload before saving.'}); }
    await c.query('DELETE FROM payments'); await c.query('DELETE FROM loans'); await c.query('DELETE FROM income');
    for (const l of state.loans) await c.execute('INSERT INTO loans (id,who,type,direction,total,installment,frequency,dueDate,method,notes,example) VALUES (?,?,?,?,?,?,?,?,?,?,?)',[l.id,l.who,l.type,l.direction,l.total,l.installment,l.frequency,l.dueDate || null,l.method || null,l.notes,l.example]);
    for (const p of state.payments) await c.execute('INSERT INTO payments (id,loanId,date,amount,method,chequeNumber,cashed) VALUES (?,?,?,?,?,?,?)',[p.id,p.loanId,p.date,p.amount,p.method,p.chequeNumber,p.cashed]);
    for (const i of state.income) await c.execute('INSERT INTO income (id,date,source,amount) VALUES (?,?,?,?)',[i.id,i.date,i.source,i.amount]);
    await c.query('UPDATE app_meta SET revision=revision+1 WHERE id=1');
    await c.execute('INSERT INTO audit_log (revision,summary) VALUES (?,?)',[state.revision+1,JSON.stringify({loans:state.loans.length,payments:state.payments.length,income:state.income.length})]);
    await c.commit(); res.json({revision:state.revision+1});
  } catch(e) { if(c) await c.rollback(); next(e); } finally { c?.release(); }
});
app.use('/vendor',express.static(fileURLToPath(new URL('../public/vendor',import.meta.url))));
app.get('/',(req,res) => res.sendFile(fileURLToPath(new URL('../index.html',import.meta.url))));
app.use((err,req,res,next) => {
  if (err instanceof ValidationError || err.type === 'entity.parse.failed') return res.status(400).json({error:err.message});
  console.error('Request failed:',err.code || err.name);
  res.status(503).json({error:'Database unavailable. Your changes were not saved. Please retry.'});
});

let server;
export async function startServer() {
  if (server) return server;
  await pool.query('SELECT revision FROM app_meta WHERE id=1');
  server = app.listen(port,host,() => console.log(`Loan manager: http://${host}:${port}`));
  for (const signal of ['SIGINT','SIGTERM']) process.on(signal,() => server.close(async () => { await pool.end(); process.exit(0); }));
  return server;
}

export default app;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startServer().catch(error => {
    console.error('Startup failed:', error.code || error.name);
    process.exit(1);
  });
}
