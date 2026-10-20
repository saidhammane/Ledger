import mysql from 'mysql2/promise';

const connection = await mysql.createConnection({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3307),
  user: process.env.DB_USER || 'loan_app',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'loan_manager'
});
const pattern = '^(said|farouk|browser|browser-creditor|browser-debtor)-[0-9]+@example\\.com$';
try {
  await connection.beginTransaction();
  const [users] = await connection.execute('SELECT id FROM users WHERE email REGEXP ?', [pattern]);
  const ids = users.map(user => user.id);
  if (ids.length) {
    const marks = ids.map(() => '?').join(',');
    const [agreements] = await connection.query(`SELECT id FROM agreements WHERE creditor_user_id IN (${marks}) OR debtor_user_id IN (${marks})`, [...ids, ...ids]);
    const agreementIds = agreements.map(agreement => agreement.id);
    if (agreementIds.length) {
      const agreementMarks = agreementIds.map(() => '?').join(',');
      await connection.query(`DELETE FROM notifications WHERE agreement_id IN (${agreementMarks})`, agreementIds);
      await connection.query(`DELETE FROM repayments WHERE agreement_id IN (${agreementMarks})`, agreementIds);
      await connection.query(`DELETE FROM financial_audit WHERE entity_type='agreement' AND entity_id IN (${agreementMarks})`, agreementIds);
      await connection.query(`DELETE FROM agreements WHERE id IN (${agreementMarks})`, agreementIds);
    }
    await connection.query(`DELETE FROM financial_audit WHERE actor_user_id IN (${marks})`, ids);
    await connection.query(`DELETE FROM users WHERE id IN (${marks})`, ids);
  }
  await connection.commit();
  console.log(`Removed ${ids.length} verifier account(s).`);
} catch (error) {
  await connection.rollback();
  throw error;
} finally {
  await connection.end();
}
