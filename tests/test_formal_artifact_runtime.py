from __future__ import annotations

import json
from dataclasses import replace

import pytest
from fastapi import HTTPException

from sandbox.app.domain.internal_artifact_contract import InternalArtifactContractError, parse_and_bind_internal_artifact
from sandbox.app.domain.tool_request_hash import compute_tool_request_hash_v1
from sandbox.app.domain.types import SANDBOX_EXECUTION_STATUS_RUNNING, SANDBOX_EXECUTION_STATUS_SUCCESS, ExecutionRecord
from sandbox.models import ArtifactResponse
from sandbox.services.formal_artifact_runtime import FormalArtifactRuntime
from sandbox.services.internal_execution_supervisor import InternalExecutionSupervisor

ORG="01K0G2PAV8FPMVC9QHJG7JPN4Z"; USER="01K0G2PAV8FPMVC9QHJG7JPN50"; CONV="01K0G2PAV8FPMVC9QHJG7JPN51"; AGENT="01K0G2PAV8FPMVC9QHJG7JPN52"; RUN="01K0G2PAV8FPMVC9QHJG7JPN53"; SBX="01K0G2PAV8FPMVC9QHJG7JPN54"; TOOL="01K0G2PAV8FPMVC9QHJG7JPN55"; EXEC="01K0G2PAV8FPMVC9QHJG7JPN56"; WS="01K0G2PAV8FPMVC9QHJG7JPN57"; ART="01K0G2PAV8FPMVC9QHJG7JPN58"; TRACE="0123456789abcdef0123456789abcdef"


def request():
    args={"path":"/home/sandbox/workspace/out/report.pdf","displayName":"report.pdf"}
    rh=compute_tool_request_hash_v1(tool_name="submit_artifact",args=args)["requestHash"]
    identity={"orgId":ORG,"userId":USER,"conversationId":CONV,"agentSessionId":AGENT,"runId":RUN,"sandboxSessionId":SBX,"traceId":TRACE,"executionFenceToken":9}
    body={**args,"identity":identity,"toolExecutionId":TOOL,"toolCallId":"call-artifact-1","requestHash":rh,"requestHashVersion":1}
    claims={"scope":["sandbox.artifacts.submit"],"tool_name":"submit_artifact","org_id":ORG,"user_id":USER,"conversation_id":CONV,"agent_session_id":AGENT,"run_id":RUN,"sandbox_session_id":SBX,"trace_id":TRACE,"execution_fence_token":9,"tool_execution_id":TOOL,"tool_call_id":"call-artifact-1","request_hash":rh,"request_hash_version":1}
    return json.dumps(body,separators=(",",":")).encode(),claims


def record(status=SANDBOX_EXECUTION_STATUS_RUNNING,result=None):
    return ExecutionRecord(execution_id=EXEC,org_id=ORG,user_id=USER,sandbox_session_id=SBX,run_id=RUN,agent_session_id=AGENT,kind="submit_artifact",status=status,created_at="2026-01-01",result_json=result,tool_execution_id=TOOL,tool_call_id="call-artifact-1",request_hash=request()[1]["request_hash"],request_hash_version=1,execution_fence_token=9,trace_id=TRACE)


class Validator:
    def __init__(self,created=True,finalize_error=None,unknown_error=None): self.created=created; self.record=record(); self.finalize_error=finalize_error; self.unknown_error=unknown_error; self.finalized=[]; self.unknown=[]
    def claim(self,value): return {"created":self.created,"execution":self.record,"workspace_id":WS}
    def finalize(self,value):
        if self.finalize_error: raise self.finalize_error
        self.finalized.append(value); self.record=replace(self.record,status=value["status"],result_json=value["result_json"])
    def mark_unknown_for_crash_recovery(self,value):
        if self.unknown_error: raise self.unknown_error
        self.unknown.append(value)


class Manager:
    def __init__(self): self.calls=[]
    def submit(self,**kwargs):
        self.calls.append(kwargs)
        return ArtifactResponse(artifact_id=ART,name="report.pdf",path="out/report.pdf",mime_type="application/pdf",size=4,sha256="a"*64,run_id=RUN,status="ready")


def test_contract_binds_claims_and_rejects_tamper():
    body,claims=request(); cmd=parse_and_bind_internal_artifact(body,claims)
    assert cmd.path=="/home/sandbox/workspace/out/report.pdf" and cmd.run_id==RUN
    bad={**claims,"user_id":ORG}
    with pytest.raises(InternalArtifactContractError): parse_and_bind_internal_artifact(body,bad)


def test_contract_allows_bounded_utf8_display_name():
    body,claims=request(); decoded=json.loads(body); decoded["displayName"]="风险分析报告.pdf"
    args={"path":decoded["path"],"displayName":decoded["displayName"]}; rh=compute_tool_request_hash_v1(tool_name="submit_artifact",args=args)["requestHash"]
    decoded["requestHash"]=rh; claims={**claims,"request_hash":rh}
    assert parse_and_bind_internal_artifact(json.dumps(decoded,ensure_ascii=False).encode(),claims).display_name==decoded["displayName"]


@pytest.mark.asyncio
async def test_claim_submit_finalize_and_replay(monkeypatch,tmp_path):
    monkeypatch.setattr("sandbox.services.formal_artifact_runtime.workspace_manager.init_workspace",lambda _:(tmp_path/"ws"))
    monkeypatch.setattr("sandbox.services.formal_artifact_runtime.workspace_manager.init_temp",lambda _:(tmp_path/"tmp"))
    (tmp_path/"ws").mkdir(); (tmp_path/"tmp").mkdir()
    validator=Validator(); manager=Manager(); runtime=FormalArtifactRuntime(claim_validator=validator,supervisor=InternalExecutionSupervisor(),id_factory=lambda:EXEC,manager=manager)
    body,claims=request(); response=await runtime.handle(claims=claims,raw_body=body)
    assert response.status_code==200 and json.loads(response.body)["artifactId"]==ART
    assert len(manager.calls)==1 and validator.finalized[0]["status"]==SANDBOX_EXECUTION_STATUS_SUCCESS
    validator.created=False; replay=await runtime.handle(claims=claims,raw_body=body)
    assert json.loads(replay.body)["artifactId"]==ART and len(manager.calls)==1


@pytest.mark.asyncio
async def test_finalize_failure_unknown_and_reconcile(monkeypatch,tmp_path):
    monkeypatch.setattr("sandbox.services.formal_artifact_runtime.workspace_manager.init_workspace",lambda _:(tmp_path/"ws"))
    monkeypatch.setattr("sandbox.services.formal_artifact_runtime.workspace_manager.init_temp",lambda _:(tmp_path/"tmp"))
    (tmp_path/"ws").mkdir(); (tmp_path/"tmp").mkdir()
    validator=Validator(finalize_error=RuntimeError("db"),unknown_error=RuntimeError("db")); runtime=FormalArtifactRuntime(claim_validator=validator,supervisor=InternalExecutionSupervisor(),id_factory=lambda:EXEC,manager=Manager())
    body,claims=request()
    with pytest.raises(HTTPException) as caught: await runtime.handle(claims=claims,raw_body=body)
    assert caught.value.status_code==503 and EXEC in runtime._inflight
    validator.unknown_error=None
    assert runtime.reconcile_inflight_as_unknown()==1 and runtime._inflight=={}
