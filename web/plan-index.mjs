function escapeRegex(value){
  return String(value).replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
}

export function exactTaskRegex(taskId){
  const id=String(taskId||"").trim();
  if(!id)return null;
  return new RegExp("(^|[^A-Za-z0-9_-])"+escapeRegex(id)+"($|[^A-Za-z0-9_-])","i");
}

export function buildPlanIndex(content,taskId=""){
  const lines=String(content??"").split(/\r?\n/);
  const taskPattern=exactTaskRegex(taskId);
  const entries=[];
  const taskMatches=[];
  for(let i=0;i<lines.length;i++){
    const text=lines[i];
    const heading=text.match(/^(#{1,6})\s+(.+?)\s*$/);
    const taskMatch=Boolean(taskPattern&&taskPattern.test(text));
    if(taskMatch)taskMatches.push({lineNumber:i+1,heading:Boolean(heading)});
    if(heading||taskMatch){
      const lineNumber=i+1;
      const label=heading
        ? heading[2].trim()
        : (String(taskId)+" · "+text.trim().replace(/\s+/g," ").slice(0,90));
      const existing=entries.find((entry)=>entry.lineNumber===lineNumber);
      if(existing){
        if(taskMatch)existing.taskMatch=true;
      }else{
        entries.push({
          lineNumber,
          label,
          level:heading?heading[1].length:null,
          kind:heading?"heading":"task",
          taskMatch
        });
      }
    }
  }
  const primary=taskMatches.find((match)=>match.heading)||taskMatches[0]||null;
  return {
    lines,
    entries,
    targetLine:primary?.lineNumber??null,
    foundTask:Boolean(primary)
  };
}
