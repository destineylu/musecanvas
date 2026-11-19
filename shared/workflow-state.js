// Terminal workflow snapshots must not overwrite a later manual retry or history restore.
export function obsoleteWorkflowStep(run, node, step) {
  if (!['failed','completed','stopped'].includes(run?.status)) return false;
  return !!((node.jobId && node.jobId !== step.jobId)
    || (node.mediaUrl && node.mediaUrl !== step.mediaUrl));
}
