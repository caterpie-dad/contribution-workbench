# 시스템 연결 설정

각 시스템의 URL과 토큰은 `config/connections.local.json` 한 파일에서 관리한다. [connections.example.json](connections.example.json)은 빈 토큰과 가상 주소만 담은 템플릿이다. `npx tsx scripts/init.ts`는 실제 파일이 없을 때 템플릿을 복사하고 관리자 암호·세션 비밀을 무작위로 생성한다. 실제 URL·토큰·모델은 이 로컬 파일에 입력한다. 현재 테스트의 실제 연결 파일은 Git·Docker build에서 제외한다.

| 파일 | 관리할 내용 | Git 관리 |
| --- | --- | --- |
| `config/connections.example.json` | 연결 구조, 가상 URL, 빈 토큰 | 포함 |
| `config/connections.local.json` | 실제 시스템 URL·토큰·사내 모델 | 제외 |
| [team-config.example.json](../design/team-config.example.json) | 루트 페이지 URL, 팀원별 레포 URL, 계정 매핑, 기간·평가 기준 | 예시 포함. 실제 인사 설정의 공유 범위는 별도 제한 |
| [host-connection-profile.example.json](../design/host-connection-profile.example.json) | 호스트 실행, MCP 도구 매핑, 수집 경로 선택 | 예시 포함 |

Confluence 루트 페이지와 GitHub 레포의 URL은 평가 대상을 가리키므로 팀 설정에 둔다. 시스템 접속 주소·인증 값은 연결 파일에만 둔다. `connection_ref`는 연결 파일의 `systems` 아래 키를 참조한다. 예를 들어 `github`는 `systems.github`를 뜻한다.

특정 시스템의 요구사항·설계 루트라면 루트 설정에 `"repository_ids": ["repo-platform"]`처럼 연결한다. 그 하위 문서를 시스템 맥락과 기능 기여에 연결할 때 사용한다. 연결하지 않은 공통 자료는 본문의 명시적 레포 URL 또는 공통 기술지식으로 분류하며 작성자의 담당 레포라는 이유만으로 강제 귀속하지 않는다. `repositories[].context_paths`에는 README와 요구사항·설계 문서 경로를 지정한다. 여러 루트가 겹치면 합집합을 수집하며 어느 한 루트 설정에서 제외한 본문도 다른 루트가 포함하면 수집한다.

기본 URL이 `https://wiki.example.internal/confluence`이면 pagination의 `/rest/api/...` 링크에도 `/confluence`를 보존한다. 이미 context path가 들어간 링크에는 중복으로 붙이지 않으며 다른 호스트의 다음 페이지·첨부 링크는 거부한다. 이는 [Atlassian의 Data Center pagination 응답](https://developer.atlassian.com/server/confluence/pagination-in-the-rest-api/)에 나타나는 base/next 형식을 포함한다. URL 해석과 실제 인증 성공은 별개이므로 회사에서는 루트 페이지 연결 시험을 실행한다.

Confluence HTML 본문과 이전 버전은 그대로 보존하고, 편집자의 새 변경은 HTML 단어·태그 단위 diff로 분리한다. 한 줄로 저장된 긴 페이지에서 문장 하나를 고쳐도 전체 페이지를 새 분석 성과로 귀속하지 않는다. 이전 버전이 없으면 마지막 편집자를 전체 내용의 작성자로 간주하지 않고 변경 범위 판정을 보류한다.

| 연결 항목 | 의미 |
| --- | --- |
| `systems.confluence.url`, `auth` | Confluence 기본 주소와 토큰. context path가 있으면 주소에 포함. 예시는 Data Center의 bearer 방식이며 설치 환경에 맞게 인증 방식·필요한 사용자 이름을 지정 |
| `systems.github.url`, `auth.token` | GitHub 기본 주소와 접근 토큰. API·Git 호출에 맞는 인증 형식은 adapter에서 적용 |
| `systems.opencode.server_url`, `server_auth` | worker가 접속할 OpenCode 서버 주소·인증. 실제 설치 버전의 인증 방식 사용. 인증 없는 로컬 서버의 예시 값은 `none` |
| `systems.opencode.llm` | OpenCode가 호출할 사내 LLM의 endpoint·provider·프로토콜·토큰 |
| `systems.opencode.llm.models` | 선택할 수 있는 모델 ID·표시 이름·사용 허용 여부·확인된 문맥 한도. 예시 모델명은 실제 제공 모델을 보장하지 않음 |
| `systems.opencode.llm.default_model_id` | 실행에서 모델을 지정하지 않았을 때 사용할 기본 모델. 사용 허용된 `models` 항목을 참조 |
| `systems.opencode.llm.models[].reasoning_effort`, `max_output_tokens` | 선택적 추론량·응답 토큰 상한. 모델이 지원하는 값만 입력하며 실행 snapshot에 고정. 사내 API 미지원 시 생략 |
| `systems.opencode.llm.strict_tools` | 구조화 도구의 strict 모드. OpenAI는 기본 true, 사내 호환 API는 지원 여부에 맞춰 명시 |
| `systems.opencode.manage_process`, `transport` | 기본값 true·sdk. 평가용 로컬 OpenCode를 관리하거나 기존 서버에 연결. CLI도 선택 가능 |
| `application` | 관리자 계정·암호, 쿠키 서명 비밀, DB URL. 대시보드로 export하지 않음 |

사용자가 말한 ‘OpenCode 토큰’이 사내 모델 호출용 개인 토큰이면 `systems.opencode.llm.token`에 저장한다. OpenCode 서버 접속에도 별도 인증이 있다면 `server_auth`에 저장한다. 두 인증 값을 자동으로 같은 값으로 취급하지 않는다.

GitHub CI는 연결한 PR head의 check-run 응답을 보존한다. 실행 관찰은 저장소·head SHA·완료 시각이 평가 경계와 맞는 결과에 한정하고, 원본으로 이동할 수 있게 한다. 개인 토큰의 조회 권한은 [GitHub Checks API 문서](https://docs.github.com/en/rest/checks/runs#list-check-runs-for-a-git-reference)를 따른다. 현재 조회 결과를 전체 workflow 실행 이력으로 간주하지 않으며 API 권한·보존 범위 밖의 결과는 미관찰로 남긴다.

대시보드의 평가 실행 화면에서 모델을 선택할 수 있어야 한다. 연결 파일은 모델 목록과 기본값을 관리하고, 실행 요청에는 선택한 `provider_id`·`model_id`만 넣는다. [실행 요청 예시](../design/evaluation-run.example.json)는 기본 모델 A 대신 모델 B를 선택하는 예시다. 선택한 모델은 실행 생성 시 확정하며, 기본값 변경은 이미 생성된 실행에 영향을 주지 않는다.

`enabled`는 사용 허용 여부이며 실제 호출 가능 여부와 구분한다. OpenCode의 실제 모델 목록·접속 권한·구조화 응답 호환성을 확인해 선택 상태와 실패 사유를 표시한다. 목록 조회에 실패했다고 설정 모델을 곧바로 삭제하거나 다른 모델을 자동 선택하지 않는다. 설치 버전에 따라 지원되는 명시적 모델 확인·시험 호출을 사용할 수 있다. 문맥 한도를 알 수 없으면 `null`로 유지하고 다른 모델의 한도를 재사용하지 않는다.

현재 구현은 설정의 허용 목록을 읽고 **실제 호출 확인** 버튼으로 명시적 시험을 수행한다. provider의 모델 자동 탐색은 하지 않는다. 시험 결과·시각은 `model_checks`에 보존하며 최근 평가의 응답 검증 상태와 구분한다. endpoint·프로토콜·문맥 한도·strict 설정이 바뀌면 이전 시험 결과를 새 설정의 확인 결과로 재사용하지 않는다. 이 확인은 OpenCode 응답의 provider/model ID와 구조화 출력을 확인하며, 사내 모델 별칭 뒤의 실제 가중치·배포 revision까지 증명하지는 않는다.

기존 MCP가 자체 OAuth·SSO 인증을 사용하는 경우 그 인증 저장소를 이 파일로 복사하지 않는다. 지원되는 기존 인증 경로를 재사용한다. Confluence 토큰을 사용하는 API·MCP 경로는 이 연결 파일에서 필요한 값을 전달받도록 구성한다. 실제 선택 경로에 불필요한 토큰은 요구하지 않는다.

로더는 [config.ts](../src/config.ts), OpenCode 실행기는 [opencode.ts](../src/evaluation/opencode.ts)에 구현했다. 설치·실행은 [프로젝트 안내](../README.md)를 따른다. 구현 계약은 다음과 같다.

1. 기본 경로는 애플리케이션 루트 기준 `config/connections.local.json`이다. `CONTRIB_CONNECTIONS_FILE`은 다른 연결 파일의 경로만 지정하며 상대 경로도 애플리케이션 루트에서 해석한다. 토큰별 환경변수를 사람이 따로 관리하지 않는다.
2. 파일을 읽고 선택한 연결 경로에 필요한 URL·인증·모델 필드와 `connection_ref`를 검증한다. `example_only: true`인 파일과 필요한 토큰의 빈 값은 실연결에 사용하지 않는다. 실패 메시지는 설정 키와 사유만 표시한다. URL에 토큰·사용자 이름·암호를 넣는 방식은 허용하지 않는다.
3. 수집 adapter에는 해당 소스의 인증만 전달한다. OpenCode 실행기에는 사내 LLM 인증과 필요한 서버 인증만 전달한다. 연결 파일 전체를 OpenCode 작업 디렉터리에 복사하거나 평가 모델의 입력으로 보내지 않는다.
4. 실행기는 고정한 OpenCode 1.19.4 설정을 생성한다. provider 키는 `llm.provider_id`, 모델 정의는 사용 허용된 `llm.models`, 기본 모델은 `llm.default_model_id`에서 생성한다. 관리형 실행에서는 로컬 gateway가 `llm.url`·실제 토큰을 사용하고 OpenCode에는 로컬 gateway URL·일회성 인증만 `CORP_LLM_BASE_URL`·`CORP_LLM_TOKEN`으로 전달한다. gateway는 선택 모델·구조화 도구 strict 설정을 적용하고 응답을 그대로 중계한다. AI 평가를 대체하지 않는다. 각 평가 요청에도 확정 모델을 명시한다. 사람이 같은 값을 여러 파일에 입력하지 않는다.
5. 생성 설정은 `runtime/opencode/`에 두며 토큰 원문 대신 환경변수 참조를 사용한다. `{file:config/connections.local.json}`을 API key에 지정하면 JSON 전체가 들어가므로 사용하지 않는다. OpenCode의 환경변수 치환 형식은 [1.x 설정 문서](https://opencode.ai/docs/config/#env-vars)와 [2.x 설정 문서](https://opencode.ai/v2/docs/config/#env-vars)를 따른다. 기존 서버를 재사용할 때도 그 서버가 지원하는 방식으로 연결하며, worker의 환경변수가 이미 실행 중인 서버에 전달된다고 가정하지 않는다.
6. 설정 전체·환경 전체를 로그·오류·DB·설정 export·백업에 자동 포함하지 않는다. 대시보드는 허용한 URL·연결 상태·인증 설정 여부만 반환한다. 토큰·암호 필드는 브라우저 응답에서 제외한다. 명령행 인자나 URL에도 토큰을 넣지 않는다.
7. 시작 시 검증한 연결 설정을 실행에 고정한다. 변경 사항은 재시작·명시적 재연결 시 반영한다. 인증 만료는 수집·평가 작업의 실패·재개 상태로 남긴다. 토큰만 바꾸는 것은 인증 갱신이며, 소스 설치 환경·모델 변경은 새 실행에 반영한다. 이전 근거·평가를 덮어쓰지 않는다.

같은 실행의 자료 평가·사례 해석·개인 종합에는 같은 모델을 적용한다. 재시도·재개·사실 교정도 원 실행의 모델을 유지한다. 해당 모델을 더 이상 호출할 수 없으면 중단 상태를 남기고, 관리자가 다른 모델로 비교 대상 전체의 새 평가 실행을 시작한다. 모델 변경 때문에 원본 수집을 반복할 필요는 없으며 기존 근거 스냅샷을 선택할 수 있다. 실행 이력에는 요청 모델과 응답에서 확인된 실제 모델·배포 revision·OpenCode 버전을 구분해 기록하고, 실제 모델이 확인되지 않으면 그 상태를 표시한다.

호출 직전 허용 목록과 실행 snapshot의 endpoint·프로토콜·strict·문맥 한도를 다시 대조한다. 기본값만 바꾸는 것은 이미 선택한 모델에 영향을 주지 않는다. 토큰 갱신은 모델 변경과 구분하며 관리형 인스턴스의 인증 연결을 새로 만든다. 토큰이나 인증 fingerprint는 평가 trace·모델 시험 결과에 저장하지 않는다.

보조 호출은 선택 모델을 사용하거나 비활성화한다. 1.x 생성 예시의 `small_model`도 실행에서 선택한 모델에 맞춘다. 공유 서버에서 이를 분리할 수 없으면 모델별 전용 평가 인스턴스를 사용하며 전역 기본값을 실행마다 바꿔 다른 작업에 영향을 주지 않는다.

관리형 실행은 SDK·OpenCode 버전을 1.19.4로 함께 고정했다. 2.x 예시는 향후 adapter용 참고이며 native 2.x가 현재 구현된 것처럼 취급하지 않는다. 기존 1.x 서버(`manage_process: false`)는 사내 provider·도구 제한·보조 모델 정책을 서버 측에 동일하게 구성해야 한다.

Confluence MCP는 아래 `mcp` 블록을 `systems.confluence`에 추가하고 `transport`를 `mcp`로 지정한다. 도구명은 실제 MCP 목록에 맞춰 바꾸며 인수에는 `{{page_id}}`, `{{version}}`, `{{cursor}}`, `{{attachment_id}}`, `{{url}}`을 사용할 수 있다. 로컬 stdio는 `command`·`args`, 원격 서버는 `url`을 지정한다.

인수 값 전체가 placeholder면 원래 JSON 자료형을 유지한다. 예를 들어 `{{version}}`은 숫자로 전달하며, 아직 없는 선택 인수는 생략한다. 문자열 안에 포함한 placeholder는 문자열 치환이다.

```json
{
  "command": "/path/to/wiki-mcp",
  "args": [],
  "bindings": {
    "page": {"tool": "get_page", "arguments": {"page_id": "{{page_id}}", "version": "{{version}}"}},
    "children": {"tool": "list_children", "arguments": {"page_id": "{{page_id}}", "cursor": "{{cursor}}"}},
    "versions": {"tool": "list_versions", "arguments": {"page_id": "{{page_id}}", "cursor": "{{cursor}}"}},
    "comments": {"tool": "list_comments", "arguments": {"page_id": "{{page_id}}", "cursor": "{{cursor}}"}},
    "attachments": {"tool": "list_attachments", "arguments": {"page_id": "{{page_id}}", "cursor": "{{cursor}}"}}
  }
}
```

`page` 응답은 `{id,title,body,version,date,actor,url}`이며 `body`는 문자열, `version`은 실제 버전 번호다. 목록 응답은 `{items: [...], next: null 또는 cursor}`다. 원본이 다른 envelope에 있으면 binding의 `result_path`로 하위 객체를 선택한다. 임의 Markdown 요약만 반환하는 MCP는 이 원본 계약을 충족하지 않으므로 REST를 사용하거나 해당 도구의 adapter를 연결한다. 미지원 기능은 결손으로 남기며 요약을 원본으로 오인하지 않는다. `attachment` binding은 `{base64,mime,filename}`을 반환할 때 바이너리 원본 보존에 사용할 수 있다.

`npm run doctor`는 DB·버전·비밀을 제외한 설정만 점검한다. `npm run doctor -- --live`는 실제 GitHub·모델·등록 Confluence 루트를 조회한다. OpenAI 잔액·인증 오류는 재시도 성공으로 숨기지 않는다. 상태를 복구한 뒤 대시보드의 작업 재개 또는 `npm run resume`으로 저장된 실행을 이어간다.

[.gitignore](../.gitignore)는 실제 연결 파일과 생성한 `runtime/`을 제외한다. 실제 연결 파일은 실행 계정만 읽도록 설정한다. Linux는 파일 권한 `600`, Windows는 해당 계정의 ACL로 제한한다. 연결 설정을 별도 백업할 때도 같은 접근 제한을 적용한다. 평가 이력에는 토큰을 제거한 허용 필드와 별도 설정 revision만 남기며, 토큰 자체나 토큰에서 만든 해시는 저장하지 않는다.
