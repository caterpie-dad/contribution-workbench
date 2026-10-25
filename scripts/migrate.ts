import {migrate,db} from '../src/db.js';
await migrate();await db.end();console.log('Database schema ready');
