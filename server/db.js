import mysql from 'mysql2/promise';

export const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3307),
  user: process.env.DB_USER || 'loan_app',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'loan_manager',
  connectionLimit: 5,
  decimalNumbers: true,
  dateStrings: true,
  charset: 'utf8mb4',
  multipleStatements: false
});

export async function readState(connection = pool) {
  const [[meta]] = await connection.query('SELECT revision FROM app_meta WHERE id=1');
  const [loans] = await connection.query('SELECT * FROM loans ORDER BY who, id');
  const [payments] = await connection.query('SELECT * FROM payments ORDER BY date, id');
  const [income] = await connection.query('SELECT * FROM income ORDER BY date, id');
  return {
    revision: Number(meta.revision),
    loans: loans.map(l => ({...l, dueDate: l.dueDate || '', method: l.method || '', example: Boolean(l.example)})),
    payments: payments.map(p => ({...p, cashed: Boolean(p.cashed)})),
    income
  };
}
