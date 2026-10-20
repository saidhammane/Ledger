import express from 'express';
import { randomUUID } from 'node:crypto';
import { pool } from './db.js';
import { requireAuth } from './auth.js';

export const financeRouter = express.Router();
financeRouter.use(requireAuth);
const methods = ['Cash', 'Cheque', 'Bank'];
const statuses = ['Pending', 'Confirmed', 'Partially paid', 'Paid', 'Disputed', 'Cancelled'];
const amount = value => /^\d{1,10}(?:\.\d{1,2})?$/.test(String(value || '')) && Number(value) > 0;
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const text = (value, max) => typeof value === 'string' && value.trim().length <= max;

async function audit(connection, actor, type, id, action, before, after) {
  await connection.execute('INSERT INTO financial_audit (actor_user_id,entity_type,entity_id,action,before_json,after_json) VALUES (?,?,?,?,?,?)', [actor, type, id, action, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null]);
}

async function notify(connection, userId, kind, title, body, agreementId = null, repaymentId = null) {
  await connection.execute('INSERT INTO notifications (id,user_id,agreement_id,repayment_id,kind,title,body) VALUES (?,?,?,?,?,?,?)', [randomUUID(), userId, agreementId, repaymentId, kind, title, body]);
}

function authorizedAgreement(row, userId) { return row && (row.creditor_user_id === userId || row.debtor_user_id === userId); }
export function canRespond(createdBy, userId, decision) {
  return decision === 'cancel' ? createdBy === userId : createdBy !== userId;
}

financeRouter.get('/users/search', async (req, res, next) => {
  try {
    const wanted = String(req.query.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(wanted)) return res.status(400).json({error:'Enter an exact email address.'});
    const [[user]] = await pool.query('SELECT id,name,email FROM users WHERE email=? AND id<>?', [wanted, req.user.id]);
    res.json({user: user || null});
  } catch (error) { next(error); }
});

financeRouter.get('/contacts', async (req, res, next) => {
  try { const [rows] = await pool.query('SELECT id,name,email,contact_user_id AS userId,created_at AS createdAt FROM contacts WHERE owner_user_id=? ORDER BY name,id', [req.user.id]); res.json({contacts:rows}); } catch (error) { next(error); }
});

financeRouter.post('/contacts', async (req, res, next) => {
  try {
    const name = String(req.body?.name || '').trim(), wanted = String(req.body?.email || '').trim().toLowerCase();
    if (!name || !text(name, 160) || (wanted && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(wanted))) return res.status(400).json({error:'Contact name or email is invalid.'});
    let linked = null;
    if (wanted) { const [[user]] = await pool.query('SELECT id FROM users WHERE email=?', [wanted]); linked = user?.id || null; }
    const id = randomUUID();
    await pool.execute('INSERT INTO contacts (id,owner_user_id,contact_user_id,name,email) VALUES (?,?,?,?,?)', [id, req.user.id, linked, name, wanted || null]);
    res.status(201).json({contact:{id,name,email:wanted || null,userId:linked}});
  } catch (error) { if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({error:'That contact email already exists.'}); next(error); }
});

financeRouter.delete('/contacts/:id', async (req, res, next) => {
  try {
    const [result] = await pool.execute('DELETE FROM contacts WHERE id=? AND owner_user_id=?', [req.params.id, req.user.id]);
    if (!result.affectedRows) return res.status(404).json({error:'Contact not found.'});
    res.status(204).end();
  } catch (error) { next(error); }
});

financeRouter.get('/agreements', async (req, res, next) => {
  try {
    const [rows] = await pool.query(`SELECT a.*, cu.name AS creditor_name, cu.email AS creditor_email, du.name AS debtor_name, du.email AS debtor_email,
      COALESCE((SELECT SUM(r.amount) FROM repayments r WHERE r.agreement_id=a.id AND r.status='Confirmed'),0) AS paid_amount
      FROM agreements a JOIN users cu ON cu.id=a.creditor_user_id JOIN users du ON du.id=a.debtor_user_id
      WHERE a.creditor_user_id=? OR a.debtor_user_id=? ORDER BY a.updated_at DESC, a.id`, [req.user.id, req.user.id]);
    res.json({agreements:rows.map(row => ({...row, amount:String(row.amount), paidAmount:String(row.paid_amount), remainingAmount:(Number(row.amount)-Number(row.paid_amount)).toFixed(2)}))});
  } catch (error) { next(error); }
});

financeRouter.post('/agreements', async (req, res, next) => {
  const connection = await pool.getConnection();
  try {
    const counterpartEmail = String(req.body?.counterpartEmail || '').trim().toLowerCase();
    const direction = req.body?.direction;
    const value = String(req.body?.amount || '');
    const description = String(req.body?.description || '').trim();
    const category = String(req.body?.category || 'General').trim();
    const dueDate = req.body?.dueDate || null;
    const method = req.body?.method || null;
    const reference = String(req.body?.reference || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(counterpartEmail) || !['owed_to_me', 'i_owe'].includes(direction) || !amount(value) || !text(description, 3000) || !text(category, 80) || (dueDate && !date(dueDate)) || (method && !methods.includes(method)) || reference.length > 160) return res.status(400).json({error:'Agreement details are invalid.'});
    const [[other]] = await connection.query('SELECT id,name,email FROM users WHERE email=? AND id<>?', [counterpartEmail, req.user.id]);
    if (!other) return res.status(404).json({error:'No registered user matches that email. Create a private contact instead.'});
    const creditor = direction === 'owed_to_me' ? req.user.id : other.id;
    const debtor = direction === 'owed_to_me' ? other.id : req.user.id;
    const id = randomUUID();
    await connection.beginTransaction();
    await connection.execute('INSERT INTO agreements (id,creditor_user_id,debtor_user_id,created_by,amount,description,category,due_date,method,reference) VALUES (?,?,?,?,?,?,?,?,?,?)', [id, creditor, debtor, req.user.id, value, description, category, dueDate, method, reference]);
    await notify(connection, other.id, 'agreement_pending', 'New financial agreement', `${req.user.name} sent you a ${value} MAD agreement to review.`, id);
    await audit(connection, req.user.id, 'agreement', id, 'created', null, {amount:value, creditor, debtor, status:'Pending'});
    await connection.commit();
    res.status(201).json({id,status:'Pending'});
  } catch (error) { await connection.rollback().catch(() => {}); next(error); } finally { connection.release(); }
});

financeRouter.get('/agreements/:id', async (req, res, next) => {
  try {
    const [[agreement]] = await pool.query(`SELECT a.*, cu.name AS creditor_name, cu.email AS creditor_email, du.name AS debtor_name, du.email AS debtor_email,
      COALESCE((SELECT SUM(r.amount) FROM repayments r WHERE r.agreement_id=a.id AND r.status='Confirmed'),0) AS paid_amount
      FROM agreements a JOIN users cu ON cu.id=a.creditor_user_id JOIN users du ON du.id=a.debtor_user_id WHERE a.id=?`, [req.params.id]);
    if (!authorizedAgreement(agreement, req.user.id)) return res.status(404).json({error:'Agreement not found.'});
    const [repayments] = await pool.query('SELECT r.*,u.name AS created_by_name FROM repayments r JOIN users u ON u.id=r.created_by WHERE r.agreement_id=? ORDER BY r.transaction_date DESC,r.created_at DESC', [agreement.id]);
    res.json({agreement:{...agreement, amount:String(agreement.amount), paidAmount:String(agreement.paid_amount), remainingAmount:(Number(agreement.amount)-Number(agreement.paid_amount)).toFixed(2)}, repayments});
  } catch (error) { next(error); }
});

async function recalculate(connection, agreementId) {
  const [[agreement]] = await connection.query('SELECT * FROM agreements WHERE id=? FOR UPDATE', [agreementId]);
  const [[paid]] = await connection.query("SELECT COALESCE(SUM(amount),0) AS total FROM repayments WHERE agreement_id=? AND status='Confirmed'", [agreementId]);
  const paidNumber = Number(paid.total), original = Number(agreement.amount);
  const status = paidNumber >= original ? 'Paid' : paidNumber > 0 ? 'Partially paid' : 'Confirmed';
  await connection.execute('UPDATE agreements SET status=? WHERE id=? AND status NOT IN (\'Disputed\',\'Cancelled\')', [status, agreementId]);
  return {agreement, status, paid:paidNumber};
}

financeRouter.post('/agreements/:id/respond', async (req, res, next) => {
  const connection = await pool.getConnection();
  try {
    const decision = req.body?.decision;
    if (!['confirm', 'dispute', 'cancel'].includes(decision)) return res.status(400).json({error:'Invalid agreement decision.'});
    await connection.beginTransaction();
    const [[agreement]] = await connection.query('SELECT * FROM agreements WHERE id=? FOR UPDATE', [req.params.id]);
    if (!authorizedAgreement(agreement, req.user.id)) { await connection.rollback(); return res.status(404).json({error:'Agreement not found.'}); }
    if (agreement.status !== 'Pending') { await connection.rollback(); return res.status(409).json({error:'This agreement has already been answered.'}); }
    if (!canRespond(agreement.created_by, req.user.id, decision)) { await connection.rollback(); return res.status(403).json({error:decision === 'cancel'?'Only the sender can cancel this agreement.':'The other participant must confirm or dispute this agreement.'}); }
    const nextStatus = decision === 'confirm' ? 'Confirmed' : decision === 'dispute' ? 'Disputed' : 'Cancelled';
    await connection.execute('UPDATE agreements SET status=?,confirmed_at=IF(?=\'Confirmed\',UTC_TIMESTAMP(),NULL) WHERE id=?', [nextStatus, nextStatus, agreement.id]);
    const other = agreement.created_by === req.user.id ? (agreement.creditor_user_id === req.user.id ? agreement.debtor_user_id : agreement.creditor_user_id) : agreement.created_by;
    await notify(connection, other, `agreement_${decision}`, `Agreement ${nextStatus.toLowerCase()}`, `${req.user.name} marked the agreement ${nextStatus.toLowerCase()}.`, agreement.id);
    await audit(connection, req.user.id, 'agreement', agreement.id, decision, agreement, {status:nextStatus});
    await connection.commit(); res.json({status:nextStatus});
  } catch (error) { await connection.rollback().catch(() => {}); next(error); } finally { connection.release(); }
});

financeRouter.post('/agreements/:id/repayments', async (req, res, next) => {
  const connection = await pool.getConnection();
  try {
    const value = String(req.body?.amount || ''), method = req.body?.method, transactionDate = req.body?.transactionDate, reference = String(req.body?.reference || '').trim();
    if (!amount(value) || !methods.includes(method) || !date(transactionDate) || transactionDate > new Date().toISOString().slice(0, 10) || reference.length > 160) return res.status(400).json({error:'Repayment details are invalid.'});
    await connection.beginTransaction();
    const [[agreement]] = await connection.query('SELECT * FROM agreements WHERE id=? FOR UPDATE', [req.params.id]);
    if (!authorizedAgreement(agreement, req.user.id)) { await connection.rollback(); return res.status(404).json({error:'Agreement not found.'}); }
    if (['Pending','Disputed','Cancelled','Paid'].includes(agreement.status)) { await connection.rollback(); return res.status(409).json({error:'This agreement cannot accept a repayment in its current state.'}); }
    const [[confirmed]] = await connection.query("SELECT COALESCE(SUM(amount),0) AS total FROM repayments WHERE agreement_id=? AND status IN ('Confirmed','Pending')", [agreement.id]);
    if (Number(confirmed.total) + Number(value) > Number(agreement.amount)) { await connection.rollback(); return res.status(400).json({error:'Repayment would exceed the agreement amount.'}); }
    const id = randomUUID();
    await connection.execute('INSERT INTO repayments (id,agreement_id,created_by,amount,method,reference,transaction_date) VALUES (?,?,?,?,?,?,?)', [id, agreement.id, req.user.id, value, method, reference, transactionDate]);
    const other = agreement.creditor_user_id === req.user.id ? agreement.debtor_user_id : agreement.creditor_user_id;
    await notify(connection, other, 'repayment_pending', 'Repayment needs confirmation', `${req.user.name} recorded a ${value} MAD repayment.`, agreement.id, id);
    await audit(connection, req.user.id, 'repayment', id, 'created', null, {agreementId:agreement.id, amount:value, status:'Pending'});
    await connection.commit(); res.status(201).json({id,status:'Pending'});
  } catch (error) { await connection.rollback().catch(() => {}); next(error); } finally { connection.release(); }
});

financeRouter.post('/repayments/:id/respond', async (req, res, next) => {
  const connection = await pool.getConnection();
  try {
    const decision = req.body?.decision;
    if (!['confirm', 'dispute', 'cancel'].includes(decision)) return res.status(400).json({error:'Invalid repayment decision.'});
    await connection.beginTransaction();
    const [[repayment]] = await connection.query('SELECT r.*,a.creditor_user_id,a.debtor_user_id,a.amount AS agreement_amount FROM repayments r JOIN agreements a ON a.id=r.agreement_id WHERE r.id=? FOR UPDATE', [req.params.id]);
    if (!repayment || ![repayment.creditor_user_id, repayment.debtor_user_id].includes(req.user.id)) { await connection.rollback(); return res.status(404).json({error:'Repayment not found.'}); }
    if (repayment.status !== 'Pending') { await connection.rollback(); return res.status(409).json({error:'This repayment has already been answered.'}); }
    if (!canRespond(repayment.created_by, req.user.id, decision)) { await connection.rollback(); return res.status(403).json({error:decision === 'cancel'?'Only the recorder can cancel this repayment.':'The other participant must confirm or dispute this repayment.'}); }
    const status = decision === 'confirm' ? 'Confirmed' : decision === 'dispute' ? 'Disputed' : 'Cancelled';
    await connection.execute('UPDATE repayments SET status=?,confirmed_at=IF(?=\'Confirmed\',UTC_TIMESTAMP(),NULL) WHERE id=?', [status, status, repayment.id]);
    const result = status === 'Confirmed' ? await recalculate(connection, repayment.agreement_id) : {agreement:{status:'',creditor_user_id:repayment.creditor_user_id,debtor_user_id:repayment.debtor_user_id}};
    const other = repayment.created_by === req.user.id ? (repayment.creditor_user_id === req.user.id ? repayment.debtor_user_id : repayment.creditor_user_id) : repayment.created_by;
    await notify(connection, other, `repayment_${decision}`, `Repayment ${status.toLowerCase()}`, `${req.user.name} marked the repayment ${status.toLowerCase()}.`, repayment.agreement_id, repayment.id);
    await audit(connection, req.user.id, 'repayment', repayment.id, decision, repayment, {status});
    await connection.commit(); res.json({status, agreementStatus:result.status || null});
  } catch (error) { await connection.rollback().catch(() => {}); next(error); } finally { connection.release(); }
});

financeRouter.get('/notifications', async (req, res, next) => {
  try { const [rows] = await pool.query('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 100', [req.user.id]); res.json({notifications:rows}); } catch (error) { next(error); }
});

financeRouter.post('/notifications/:id/read', async (req, res, next) => {
  try { await pool.execute('UPDATE notifications SET read_at=UTC_TIMESTAMP() WHERE id=? AND user_id=?', [req.params.id, req.user.id]); res.status(204).end(); } catch (error) { next(error); }
});

financeRouter.get('/dashboard', async (req, res, next) => {
  try {
    const [[summary]] = await pool.query(`SELECT
      COALESCE(SUM(CASE WHEN a.debtor_user_id=? THEN a.amount - COALESCE((SELECT SUM(r.amount) FROM repayments r WHERE r.agreement_id=a.id AND r.status='Confirmed'),0) ELSE 0 END),0) AS money_owe,
      COALESCE(SUM(CASE WHEN a.creditor_user_id=? THEN a.amount - COALESCE((SELECT SUM(r.amount) FROM repayments r WHERE r.agreement_id=a.id AND r.status='Confirmed'),0) ELSE 0 END),0) AS money_owed,
      COALESCE((SELECT SUM(r.amount) FROM repayments r JOIN agreements a2 ON a2.id=r.agreement_id WHERE r.status='Confirmed' AND a2.debtor_user_id=?),0) AS repayments_made,
      COALESCE((SELECT SUM(r.amount) FROM repayments r JOIN agreements a2 ON a2.id=r.agreement_id WHERE r.status='Confirmed' AND a2.creditor_user_id=?),0) AS repayments_received
      FROM agreements a WHERE a.status IN ('Confirmed','Partially paid','Paid') AND (a.creditor_user_id=? OR a.debtor_user_id=?)`, [req.user.id, req.user.id, req.user.id, req.user.id, req.user.id, req.user.id]);
    const [[pending]] = await pool.query("SELECT COUNT(*) AS count FROM notifications WHERE user_id=? AND read_at IS NULL", [req.user.id]);
    res.json({summary:{...summary,pendingConfirmations:Number(pending.count)}});
  } catch (error) { next(error); }
});
