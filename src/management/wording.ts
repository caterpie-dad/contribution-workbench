// Only vocabulary changes. Keep the original model response in storage.
// Main contribution narratives still pass the stricter domain-text validator.
export function readableObservation(text:string){
  return text.replace(/existing_system_context|existing_context/g,'기존 코드·문서의 맥락')
    .replace(/source_catalog/g,'수집된 원문')
    .replace(/case_changes/g,'변경 전후 자료')
    .replace(/partial_feature_reports/g,'부분 범위의 분석')
    .replace(/recorded_roles/g,'작성·편집 등의 역할 기록')
    .replace(/dimension_gates/g,'평가 항목의 근거 조건')
    .replace(/span_id/g,'인용 구간 번호');
}
