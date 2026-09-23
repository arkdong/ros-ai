import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Separate DB holds an OS-backed exclusive lock; process death releases it automatically. */
export function acquireDataLock(dataDir:string):()=>void {
  mkdirSync(dataDir,{recursive:true,mode:0o700});
  const database=new DatabaseSync(resolve(dataDir,'process-lock.sqlite'),{timeout:0});
  try { database.exec('BEGIN EXCLUSIVE'); }
  catch { database.close(); throw new Error('This data directory is already open in ros.ai. Stop that server or choose ROS_DATA_DIR.'); }
  let closed=false;
  return ()=>{if(!closed){closed=true;database.exec('ROLLBACK');database.close();}};
}
