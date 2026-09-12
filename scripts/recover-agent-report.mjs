#!/usr/bin/env node
/** Explicit report-only recovery. Never imports a payment executor or signer. */
import {readFile} from 'node:fs/promises';import {resolve,join} from 'node:path';import {DatabaseSync} from 'node:sqlite';
import {AgentStore} from '../packages/gateway/src/agent-store.ts';import {VertexAgentModel} from '../packages/gateway/src/agent-model.ts';import {recoverAgentReport} from '../packages/gateway/src/agent-report-recovery.ts';
const id=process.argv[2];if(!id||!/^[A-Za-z0-9_-]{8,128}$/.test(id))throw new Error('Usage: npm run agents:recover-report -- EXISTING_RUN_ID');
const folder=resolve(process.env.MANDATE_OPERATOR_STATE??'state/agents/operator'),config=JSON.parse(await readFile(join(folder,'agent-runtime.json'),'utf8'));
const db=new DatabaseSync(join(folder,'workspace.sqlite'));db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
try{const result=await recoverAgentReport(new AgentStore(db),new VertexAgentModel(config.vertex),id,AbortSignal.timeout(125000),{reviewClaims:process.argv.includes("--review-claims"),requireObservedReport:process.argv.includes("--require-observed-report")});console.log(JSON.stringify(result,null,2));}
finally{db.close();}
