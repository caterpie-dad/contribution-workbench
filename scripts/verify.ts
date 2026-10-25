import fs from 'node:fs/promises';
import {db,one} from '../src/db.js';

// Preserve the original audit for reports created before functional evaluation.
try {
  const manifest=JSON.parse(await fs.readFile('runtime/verification/demo-run.json','utf8'));
  const run=await one('SELECT summary FROM evaluation_runs WHERE id=$1',[process.env.EVALUATION_ID||manifest.evaluation_id]);
  if(run.summary.evaluation_contract?.management_revision) await import('./verify-management.js');
  else await import('./verify-legacy.js');
} catch(error) { await db.end(); throw error; }
