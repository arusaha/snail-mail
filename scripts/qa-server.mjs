import { createStore } from '../server/store.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
const dir=resolve('data/qa-synthetic');mkdirSync(dir,{recursive:true});
writeFileSync(join(dir,'config.json'),JSON.stringify({port:4319}));
const store=createStore(dir);
store.importDigest({sourceId:'eeeeeeeeeeee',date:'2026-10-05',subject:'Synthetic browser QA',advertisedCount:2,packages:[],items:[{key:'1',sender:'QA utility envelope',category:'inbox',priority:'important',summary:'Synthetic sample for interaction testing.',evidence:'No real mail is in this test mailbox.',confidence:'high',image:null,imageKind:'unavailable'},{key:'2',sender:'QA coupon bundle',category:'spam',priority:'normal',summary:'Synthetic advertising sample.',evidence:'No real mail is in this test mailbox.',confidence:'high',image:null,imageKind:'unavailable',units:2}]});store.close();
process.env.SNAIL_DATA_DIR=dir;process.env.PORT='4319';
await import('../server/index.mjs');
