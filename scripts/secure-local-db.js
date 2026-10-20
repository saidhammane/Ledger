import mysql from 'mysql2/promise';
import {randomBytes} from 'node:crypto';
import {writeFile,access} from 'node:fs/promises';
const path = new URL('../.runtime/admin.env',import.meta.url);
try { await access(path); console.log('Admin credentials already exist; leaving them intact.'); process.exit(0); } catch {}
const password = randomBytes(32).toString('hex');
const c = await mysql.createConnection({host:'127.0.0.1',port:3307,user:'root',password:''});
try {
  await writeFile(path,`DB_ADMIN_USER=root\nDB_ADMIN_PASSWORD=${password}\n`,{flag:'wx'});
  await c.query('ALTER USER ?@? IDENTIFIED BY ?',['root','localhost',password]);
  console.log('Local MySQL root secured. Admin credentials stored in .runtime/admin.env.');
} finally { await c.end(); }
