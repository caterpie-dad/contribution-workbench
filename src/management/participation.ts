export function assignedRepositories(person:any,period?:any):string[]{
  return [...new Set((person.repository_assignments||[]).filter((a:any)=>!period||(!a.valid_from||Date.parse(a.valid_from)<Date.parse(period.end_exclusive))&&(!a.valid_until_exclusive||Date.parse(a.valid_until_exclusive)>Date.parse(period.start_inclusive))).map((a:any)=>a.repository_id))] as string[];
}
