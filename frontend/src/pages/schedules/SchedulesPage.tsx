import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  createCronJob,
  deleteCronJob,
  listCronJobRuns,
  listCronJobs,
  runCronJobNow,
  updateCronJob,
  type CronJob,
  type CronJobInput,
  type CronJobRun,
} from '../../shared/api/cron-jobs';
import {
  IconRefresh,
  IconClose,
  IconClock,
  IconSparkles,
  IconAlertCircle,
  IconRuns,
} from '../../shared/ui/Icons';

function defaultTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function blankDraft(): CronJobInput {
  return {
    name: '',
    prompt: '',
    agent_id: null,
    schedule_type: 'cron',
    cron_expression: '0 9 * * 1-5',
    run_at: null,
    timezone: defaultTimeZone(),
    enabled: true,
    misfire_policy: 'fire_once',
    concurrency_policy: 'forbid',
  };
}

function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function displayTime(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

function describeSchedule(job: CronJob): string {
  if (job.schedule_type === 'once') return `Once · ${displayTime(job.run_at)}`;
  return `${job.cron_expression || '—'} · ${job.timezone}`;
}

export function SchedulesPage() {
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [draft, setDraft] = useState<CronJobInput>(() => blankDraft());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [runs, setRuns] = useState<CronJobRun[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setJobs(await listCronJobs());
    } catch (error) {
      setBanner((error as Error).message || 'Unable to load scheduled runs.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const selectedJob = useMemo(
    () => jobs.find((job) => job.cron_job_id === selectedId) || null,
    [jobs, selectedId],
  );

  function resetForm() {
    setEditingId(null);
    setDraft(blankDraft());
  }

  function editJob(job: CronJob) {
    setEditingId(job.cron_job_id);
    setDraft({
      name: job.name,
      prompt: job.prompt,
      agent_id: job.agent_id,
      schedule_type: job.schedule_type,
      cron_expression: job.cron_expression,
      run_at: toLocalInput(job.run_at),
      timezone: job.timezone,
      enabled: job.enabled,
      misfire_policy: job.misfire_policy,
      concurrency_policy: job.concurrency_policy,
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!draft.name.trim() || !draft.prompt.trim()) {
      setBanner('A name and prompt are required.');
      return;
    }
    if (draft.schedule_type === 'cron' && !draft.cron_expression?.trim()) {
      setBanner('Enter a five-field cron expression.');
      return;
    }
    if (draft.schedule_type === 'once' && !draft.run_at) {
      setBanner('Choose the time for the one-time run.');
      return;
    }
    setSaving(true);
    try {
      const payload: CronJobInput = {
        ...draft,
        name: draft.name.trim(),
        prompt: draft.prompt.trim(),
        agent_id: draft.agent_id?.trim() || null,
        cron_expression: draft.schedule_type === 'cron'
          ? draft.cron_expression?.trim() || null
          : null,
        run_at: draft.schedule_type === 'once' && draft.run_at
          ? new Date(draft.run_at).toISOString()
          : null,
      };
      if (editingId) {
        await updateCronJob(editingId, payload);
        setBanner('Scheduled run updated.');
      } else {
        await createCronJob(payload);
        setBanner('Scheduled run created.');
      }
      resetForm();
      await refresh();
    } catch (error) {
      setBanner((error as Error).message || 'Unable to save scheduled run.');
    } finally {
      setSaving(false);
    }
  }

  async function toggleJob(job: CronJob) {
    setBusyId(job.cron_job_id);
    try {
      await updateCronJob(job.cron_job_id, { enabled: !job.enabled });
      setBanner(job.enabled ? 'Scheduled run paused.' : 'Scheduled run resumed.');
      await refresh();
    } catch (error) {
      setBanner((error as Error).message || 'Unable to update scheduled run.');
    } finally {
      setBusyId(null);
    }
  }

  async function runNow(job: CronJob) {
    setBusyId(job.cron_job_id);
    try {
      const run = await runCronJobNow(job.cron_job_id);
      setBanner(run.run_id ? 'Run queued successfully.' : `Execution ${run.status.toLowerCase()}.`);
      setSelectedId(job.cron_job_id);
      setRuns(await listCronJobRuns(job.cron_job_id));
    } catch (error) {
      setBanner((error as Error).message || 'Unable to start run.');
    } finally {
      setBusyId(null);
    }
  }

  async function remove(job: CronJob) {
    if (!window.confirm(`Delete scheduled run “${job.name}”? Execution history will remain available.`)) return;
    setBusyId(job.cron_job_id);
    try {
      await deleteCronJob(job.cron_job_id);
      if (selectedId === job.cron_job_id) {
        setSelectedId(null);
        setRuns([]);
      }
      if (editingId === job.cron_job_id) resetForm();
      setBanner('Scheduled run deleted.');
      await refresh();
    } catch (error) {
      setBanner((error as Error).message || 'Unable to delete scheduled run.');
    } finally {
      setBusyId(null);
    }
  }

  async function showRuns(job: CronJob) {
    setSelectedId(job.cron_job_id);
    setRunsLoading(true);
    try {
      setRuns(await listCronJobRuns(job.cron_job_id));
    } catch (error) {
      setBanner((error as Error).message || 'Unable to load execution history.');
      setRuns([]);
    } finally {
      setRunsLoading(false);
    }
  }

  return (
    <div className="mgmt-page schedules-page">
      <header className="mgmt-header">
        <div>
          <h2 className="mgmt-title">Scheduled Runs</h2>
          <p className="mgmt-subtitle">
            Configure durable, server-side schedules. Each occurrence triggers an autonomous Agent run.
          </p>
        </div>
        <button type="button" className="mgmt-btn" onClick={() => void refresh()} disabled={loading}>
          <IconRefresh size={14} className={loading ? 'icon-spin' : ''} />
          <span>{loading ? 'Refreshing…' : 'Refresh'}</span>
        </button>
      </header>

      {banner ? (
        <div className="mgmt-banner" role="status">
          <IconAlertCircle size={15} />
          <span>{banner}</span>
          <button
            type="button"
            className="mgmt-banner-close"
            aria-label="Dismiss notification"
            title="Dismiss notification"
            onClick={() => setBanner(null)}
          >
            <IconClose size={13} />
          </button>
        </div>
      ) : null}

      <form className="mgmt-schedule-form" onSubmit={(event) => void submit(event)}>
        <div className="mgmt-detail-head">
          <div className="mgmt-form-title-row">
            <IconClock size={16} />
            <h3>{editingId ? 'Edit Scheduled Run' : 'Create New Scheduled Run'}</h3>
          </div>
          {editingId ? <button type="button" className="mgmt-btn sm secondary" onClick={resetForm}>Cancel edit</button> : null}
        </div>
        <div className="mgmt-field-row">
          <label className="mgmt-field">
            <span>Name</span>
            <input value={draft.name} maxLength={255} placeholder="Daily Risk Report" onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </label>
          <label className="mgmt-field">
            <span>Schedule Type</span>
            <select value={draft.schedule_type} onChange={(e) => setDraft({ ...draft, schedule_type: e.target.value as 'cron' | 'once' })}>
              <option value="cron">Recurring Cron Expression</option>
              <option value="once">Run Once At Time</option>
            </select>
          </label>
          <label className="mgmt-field">
            <span>Timezone</span>
            <input value={draft.timezone} maxLength={64} placeholder="Asia/Shanghai" onChange={(e) => setDraft({ ...draft, timezone: e.target.value })} />
          </label>
        </div>
        <label className="mgmt-field mgmt-field-wide">
          <span>Execution Prompt</span>
          <textarea value={draft.prompt} maxLength={50000} placeholder="Generate yesterday's risk report and publish the findings." onChange={(e) => setDraft({ ...draft, prompt: e.target.value })} />
        </label>
        <div className="mgmt-field-row">
          {draft.schedule_type === 'cron' ? (
            <label className="mgmt-field mgmt-field-wide">
              <span>Cron Expression</span>
              <input value={draft.cron_expression || ''} placeholder="0 9 * * 1-5" onChange={(e) => setDraft({ ...draft, cron_expression: e.target.value })} />
              <small>Standard 5-field expression: minute hour day-of-month month day-of-week.</small>
            </label>
          ) : (
            <label className="mgmt-field">
              <span>Run At</span>
              <input type="datetime-local" value={draft.run_at || ''} onChange={(e) => setDraft({ ...draft, run_at: e.target.value })} />
            </label>
          )}
          <label className="mgmt-field">
            <span>Missed Schedule Policy</span>
            <select value={draft.misfire_policy} onChange={(e) => setDraft({ ...draft, misfire_policy: e.target.value as 'skip' | 'fire_once' })}>
              <option value="fire_once">Run once after recovery</option>
              <option value="skip">Skip missed run</option>
            </select>
          </label>
          <label className="mgmt-field">
            <span>Concurrency Policy</span>
            <select value={draft.concurrency_policy} onChange={(e) => setDraft({ ...draft, concurrency_policy: e.target.value as 'forbid' | 'allow' })}>
              <option value="forbid">Skip while previous run is active</option>
              <option value="allow">Allow parallel runs</option>
            </select>
          </label>
          <label className="mgmt-field">
            <span>Agent ID (Optional)</span>
            <input value={draft.agent_id || ''} placeholder="Default tenant agent" onChange={(e) => setDraft({ ...draft, agent_id: e.target.value || null })} />
          </label>
        </div>
        <div className="mgmt-form-actions">
          <button type="submit" className="mgmt-btn" disabled={saving}>
            {saving ? 'Saving…' : editingId ? 'Save changes' : 'Create Schedule'}
          </button>
          {!editingId ? <button type="button" className="mgmt-btn secondary" onClick={resetForm}>Clear</button> : null}
        </div>
      </form>

      <section className="mgmt-section" aria-label="Configured scheduled runs">
        <h3 className="mgmt-section-title">Configured Schedules</h3>
        {loading && jobs.length === 0 ? <div className="mgmt-empty"><IconSparkles size={24} className="icon-pulse" /><p>Loading scheduled runs…</p></div> : null}
        {!loading && jobs.length === 0 ? <div className="mgmt-empty"><p className="mgmt-empty-title">No scheduled runs</p><p className="mgmt-empty-body">Create a Cron or one-time schedule above. The server will keep running it in the background.</p></div> : null}
        {jobs.length > 0 ? (
          <div className="mgmt-table-wrap">
            <table className="mgmt-table">
              <thead><tr><th>Name</th><th>Schedule</th><th>Next run</th><th>Status</th><th>Actions</th></tr></thead>
              <tbody>{jobs.map((job) => (
                <tr key={job.cron_job_id} className={selectedId === job.cron_job_id ? 'selected' : ''}>
                  <td><strong>{job.name}</strong><div className="mgmt-muted mgmt-prompt-preview">{job.prompt}</div></td>
                  <td className="mgmt-muted">{describeSchedule(job)}</td>
                  <td>{displayTime(job.next_run_at)}</td>
                  <td><span className={`mgmt-status status-${job.enabled ? 'enabled' : 'disabled'}`}><span className="mgmt-status-dot" />{job.enabled ? 'Enabled' : 'Paused'}</span></td>
                  <td><div className="mgmt-row-actions">
                    <button type="button" className="mgmt-btn sm" disabled={busyId === job.cron_job_id} onClick={() => void runNow(job)}><IconRuns size={12} /> Run now</button>
                    <button type="button" className="mgmt-btn sm secondary" disabled={busyId === job.cron_job_id} onClick={() => void toggleJob(job)}>{job.enabled ? 'Pause' : 'Resume'}</button>
                    <button type="button" className="mgmt-btn sm secondary" onClick={() => editJob(job)}>Edit</button>
                    <button type="button" className="mgmt-btn sm secondary" onClick={() => void showRuns(job)}>History</button>
                    <button type="button" className="mgmt-btn sm danger" disabled={busyId === job.cron_job_id} onClick={() => void remove(job)}>Delete</button>
                  </div></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        ) : null}
      </section>

      {selectedJob ? (
        <section className="mgmt-section" aria-label={`Execution history for ${selectedJob.name}`}>
          <div className="mgmt-detail-head"><h3 className="mgmt-section-title">Execution History · {selectedJob.name}</h3><button type="button" className="mgmt-btn sm secondary" onClick={() => { setSelectedId(null); setRuns([]); }}><IconClose size={13} /> Close</button></div>
          {runsLoading ? <div className="mgmt-empty"><IconSparkles size={20} className="icon-pulse" /><p>Loading history…</p></div> : runs.length === 0 ? <div className="mgmt-empty">No executions recorded yet.</div> : (
            <div className="mgmt-table-wrap"><table className="mgmt-table"><thead><tr><th>Scheduled Time</th><th>Result</th><th>Run ID</th><th>Detail</th></tr></thead><tbody>{runs.map((run) => (
              <tr key={run.cron_job_run_id}><td>{displayTime(run.scheduled_at)}</td><td><span className={`mgmt-status status-${run.status.toLowerCase()}`}><span className="mgmt-status-dot" />{run.run_status || run.status}</span></td><td>{run.run_id ? <code className="mgmt-id-code">{run.run_id.slice(0, 12)}…</code> : '—'}</td><td className="mgmt-muted">{run.error_message || '—'}</td></tr>
            ))}</tbody></table></div>
          )}
        </section>
      ) : null}
    </div>
  );
}
