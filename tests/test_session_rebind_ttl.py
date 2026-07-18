"""PR-07A: multi-turn rebind must renew TTL (SQLite repository path)."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sandbox.config import settings
from sandbox.database import Database
from sandbox.models import SessionStatus
from sandbox.services.session_manager import SessionManager
from tests.conftest import formal_id


def test_rebind_renews_ttl_sqlite_repository(tmp_path, monkeypatch):
    """Repository path: past-TTL RUNNING / COMPLETED / EXPIRED rebind renews TTL."""
    monkeypatch.setattr(settings, "session_ttl_minutes", 30)
    db = Database(f"sqlite:///{tmp_path / 'rebind_ttl.db'}")
    db.initialize()
    mgr = SessionManager(database=db)

    agent = formal_id("AGT")
    wsp = formal_id("WSP")
    s1 = mgr.create(agent_session_id=agent, workspace_id=wsp, caller_id="a")
    sid = s1.session_id

    past = (datetime.now(timezone.utc) - timedelta(hours=3)).isoformat()
    # Force expired TTL while still RUNNING
    with db.connect() as conn:
        conn.execute(
            "UPDATE sessions SET ttl_until = ? WHERE session_id = ?",
            (past, sid),
        )
        conn.commit()

    s2 = mgr.create(agent_session_id=agent, workspace_id=wsp, caller_id="a")
    assert s2.session_id == sid
    assert s2.status == SessionStatus.RUNNING
    with db.connect() as conn:
        row = conn.execute(
            "SELECT status, ttl_until FROM sessions WHERE session_id = ?",
            (sid,),
        ).fetchone()
    assert row["status"] == SessionStatus.RUNNING.value
    ttl = datetime.fromisoformat(row["ttl_until"])
    if ttl.tzinfo is None:
        ttl = ttl.replace(tzinfo=timezone.utc)
    assert ttl > datetime.now(timezone.utc)
    assert mgr.cleanup_expired() == 0
    assert mgr.get(sid).status == SessionStatus.RUNNING

    # COMPLETED → rebind
    mgr.update_status(sid, SessionStatus.COMPLETED)
    with db.connect() as conn:
        conn.execute(
            "UPDATE sessions SET ttl_until = ? WHERE session_id = ?",
            (past, sid),
        )
        conn.commit()
    s3 = mgr.create(agent_session_id=agent, workspace_id=wsp, caller_id="b")
    assert s3.status == SessionStatus.RUNNING
    assert mgr.cleanup_expired() == 0
    assert mgr.get(sid).status == SessionStatus.RUNNING

    # EXPIRED → rebind
    mgr.update_status(sid, SessionStatus.EXPIRED)
    s4 = mgr.create(agent_session_id=agent, workspace_id=wsp, caller_id="c")
    assert s4.status == SessionStatus.RUNNING
    assert mgr.cleanup_expired() == 0
    assert mgr.get(sid).status == SessionStatus.RUNNING

    # update_status alone does not renew TTL
    with db.connect() as conn:
        conn.execute(
            "UPDATE sessions SET ttl_until = ? WHERE session_id = ?",
            (past, sid),
        )
        conn.commit()
    mgr.update_status(sid, SessionStatus.COMPLETED)
    with db.connect() as conn:
        row = conn.execute(
            "SELECT ttl_until FROM sessions WHERE session_id = ?", (sid,)
        ).fetchone()
    assert row["ttl_until"] == past
