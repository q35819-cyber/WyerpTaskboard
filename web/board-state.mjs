export function resolveProjectId(projects, currentProjectId, savedProjectId) {
  const items=Array.isArray(projects)?projects:[];
  const ids=new Set(items.map(project=>String(project?.id||"").trim()).filter(Boolean));
  if(currentProjectId&&ids.has(currentProjectId))return currentProjectId;
  if(savedProjectId&&ids.has(savedProjectId))return savedProjectId;
  return items.map(project=>String(project?.id||"").trim()).find(id=>id&&ids.has(id))||null;
}

export function tasksForColumn(tasks, statuses) {
  const allowed=new Set(Array.isArray(statuses)?statuses:[]);
  return (Array.isArray(tasks)?tasks:[]).filter(task=>allowed.has(task?.status));
}

export function paginateColumn(tasks, requestedPage, pageSize=3) {
  const items=Array.isArray(tasks)?tasks:[];
  const size=Number.isInteger(pageSize)&&pageSize>0?pageSize:3;
  const totalPages=Math.max(1,Math.ceil(items.length/size));
  const parsed=Number(requestedPage);
  const page=Number.isFinite(parsed)?Math.min(Math.max(1,Math.trunc(parsed)),totalPages):1;
  return {page,totalPages,visible:items.slice((page-1)*size,page*size)};
}
