import type { CronJob } from '../../shared/api/cron-jobs';

export function hasSelectedSchedule(jobs: CronJob[], selectedId: string | null): boolean {
  return selectedId !== null && jobs.some((job) => job.cron_job_id === selectedId);
}
