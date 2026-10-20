import {pool} from '../server/db.js';
try { await pool.query('SELECT revision FROM app_meta WHERE id=1'); }
catch { process.exitCode=1; }
finally { await pool.end(); }
