import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { computeToolRequestHashV1 } from '../../src/domain/tool/tool-request-hash.js';
import { verifyInternalToken } from '../../src/infrastructure/sandbox/internal-hmac.js';
import { ARTIFACT_SUBMIT_HTU, createInternalArtifactSubmitTransport } from '../../src/infrastructure/sandbox/internal-artifact-submit-http.js';

const KEYRING={current:Buffer.from('internal-artifact-test-key-material-32').toString('base64url')};
const identity={orgId:'01K0G2PAV8FPMVC9QHJG7JPN4Z',userId:'01K0G2PAV8FPMVC9QHJG7JPN50',conversationId:'01K0G2PAV8FPMVC9QHJG7JPN51',agentSessionId:'01K0G2PAV8FPMVC9QHJG7JPN52',runId:'01K0G2PAV8FPMVC9QHJG7JPN53',sandboxSessionId:'01K0G2PAV8FPMVC9QHJG7JPN54',traceId:'a'.repeat(32),executionFenceToken:7};
function payload(){const args={path:'/home/sandbox/workspace/out/report.pdf',displayName:'report.pdf'};const h=computeToolRequestHashV1({toolName:'submit_artifact',args});return{...args,identity,toolExecutionId:'01K0G2PAV8FPMVC9QHJG7JPN55',toolCallId:'call-artifact-1',requestHash:h.requestHash,requestHashVersion:1};}

describe('createInternalArtifactSubmitTransport',()=>{
  it('signs exact bytes and validates the artifact response',async()=>{
    let sent;
    const transport=createInternalArtifactSubmitTransport({baseUrl:'http://127.0.0.1:8081',keyring:KEYRING,activeKid:'current',allowInsecureHttp:true,clock:()=>1_800_000_000,randomBytes:()=>new Uint8Array(16).fill(5),fetchImpl:async(url,init)=>{sent={url,init};return{ok:true,status:200,text:async()=>JSON.stringify({artifactId:'01K0G2PAV8FPMVC9QHJG7JPN56',path:'/home/sandbox/workspace/out/report.pdf',name:'report.pdf',displayName:'report.pdf',mimeType:'application/pdf',sha256:'b'.repeat(64),size:12,status:'ready'})};}});
    const result=await transport.submitArtifact(payload());
    assert.equal(result.artifactId,'01K0G2PAV8FPMVC9QHJG7JPN56');
    assert.equal(sent.url,`http://127.0.0.1:8081${ARTIFACT_SUBMIT_HTU}`);
    const claims=verifyInternalToken(sent.init.headers.authorization.slice('Bearer '.length),{keyring:KEYRING,clock:()=>1_800_000_001});
    assert.equal(claims.tool_name,'submit_artifact'); assert.deepEqual(claims.scope,['sandbox.artifacts.submit']); assert.equal(claims.htu,ARTIFACT_SUBMIT_HTU);
    assert.equal(claims.body_sha256,createHash('sha256').update(sent.init.body).digest('hex'));
    assert.equal(sent.init.headers['X-Trace-Id'], identity.traceId);
    assert.match(sent.init.headers.traceparent, new RegExp(`^00-${identity.traceId}-[0-9a-f]{16}-01$`));
  });

  it('marks a post-dispatch network failure unknown',async()=>{
    const transport=createInternalArtifactSubmitTransport({baseUrl:'http://127.0.0.1:8081',keyring:KEYRING,activeKid:'current',allowInsecureHttp:true,fetchImpl:async()=>{throw new Error('reset');}});
    await assert.rejects(()=>transport.submitArtifact(payload()),(error)=>error.code==='TOOL_OUTCOME_UNKNOWN'&&error.outcomeUnknown===true);
  });

  it('rejects request hash tampering before fetch',async()=>{
    let calls=0; const transport=createInternalArtifactSubmitTransport({baseUrl:'http://127.0.0.1:8081',keyring:KEYRING,activeKid:'current',allowInsecureHttp:true,fetchImpl:async()=>{calls+=1;}});
    await assert.rejects(()=>transport.submitArtifact({...payload(),displayName:'other.pdf'}),(error)=>error.code==='ARTIFACT_HASH_INVALID'); assert.equal(calls,0);
  });

  it('allows bounded UTF-8 artifact display metadata', async () => {
    const base = payload();
    const args = { path: base.path, displayName: '风险分析报告.pdf' };
    const hash = computeToolRequestHashV1({ toolName: 'submit_artifact', args });
    const transport = createInternalArtifactSubmitTransport({
      baseUrl: 'http://127.0.0.1:8081', keyring: KEYRING, activeKid: 'current', allowInsecureHttp: true,
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ artifactId: '01K0G2PAV8FPMVC9QHJG7JPN56', path: base.path, name: args.displayName, mimeType: 'application/pdf', sha256: 'b'.repeat(64), size: 1 }) }),
    });
    const result = await transport.submitArtifact({ ...base, ...args, requestHash: hash.requestHash });
    assert.equal(result.name, args.displayName);
  });
});
