import mysql from 'mysql2/promise';
import {readFile} from 'node:fs/promises';

const name = process.env.DB_NAME || 'loan_manager';
if (!/^[a-zA-Z0-9_]+$/.test(name)) throw new Error('Invalid database name');
const c = await mysql.createConnection({host:process.env.DB_HOST || '127.0.0.1',port:Number(process.env.DB_PORT || 3307),user:process.env.DB_ADMIN_USER || 'root',password:process.env.DB_ADMIN_PASSWORD || '',multipleStatements:true});
try {
  await c.query(`CREATE DATABASE IF NOT EXISTS \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  await c.query(`USE \`${name}\``);
  await c.query(await readFile(new URL('../server/schema.sql',import.meta.url),'utf8'));
  const user = process.env.DB_USER || 'loan_app', password = process.env.DB_PASSWORD;
  if (!password || password.length < 20) throw new Error('Set a random DB_PASSWORD of at least 20 characters.');
  await c.query('CREATE USER IF NOT EXISTS ?@? IDENTIFIED BY ?',[user,'127.0.0.1',password]);
  await c.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON \`${name}\`.* TO ?@?`,[user,'127.0.0.1']);
  console.log('Database schema and application user are ready.');
} finally { await c.end(); }
