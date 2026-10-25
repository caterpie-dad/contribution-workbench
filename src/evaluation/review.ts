export type ReviewFlag={code:string;message:string;rule_version:'artifact-review-v1'};
export function reviewAssessment(evidence:{kind:string;body:string},assessment:any):ReviewFlag[]{
  if(evidence.kind!=='commit'||!assessment?.parts?.length)return [];
  const flags:ReviewFlag[]=[];
  const flag=(code:string,message:string)=>flags.push({code,message,rule_version:'artifact-review-v1'});
  if(/^Binary files .+ differ$/m.test(evidence.body))flag('binary_content_unobserved','바이너리 파일의 변경 표시만 있습니다. 이미지·바이너리 내용의 정확성·완결성을 직접 확인한 판정인지 검토하세요.');
  const changes:string[]=[];let inHunk=false;
  for(const line of evidence.body.split('\n')){
    if(line.startsWith('diff --git'))inHunk=false;
    if(line.startsWith('@@')){inHunk=true;continue;}
    if(inHunk&&/^[+-]/.test(line))changes.push(line.slice(1));
  }
  if(changes.length&&changes.every(line=>!line.trim()))flag('blank_line_change_only','diff에서 관찰한 변경은 빈 줄 추가·삭제입니다. 주변의 기존 테스트를 새 검증 기여로 해석하거나 품질 효과를 과장하지 않았는지 검토하세요.');
  const substantive=changes.filter(line=>line.trim().length>=8);
  const quotes=assessment.parts.flatMap((part:any)=>(part.citations||[]).map((citation:any)=>citation.quote as string));
  if(substantive.length&&quotes.length&&!quotes.some((quote:string)=>substantive.some(line=>quote.includes(line)||line.includes(quote))))flag('changed_lines_not_cited','선택된 인용에서 실제 추가·삭제된 줄을 확인하지 못했습니다. 인용이 변경 의도·효과를 지지하는지 원문 diff와 대조하세요.');
  return flags;
}
