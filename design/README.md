# 설정 예시 읽는 방법

이 디렉터리는 [시스템 설계 v0.3](../system-architecture-v0.3.md)의 설정·이벤트 예시다. 실제 서버·worker·수집·평가·대시보드의 설치와 검증 상태는 [프로젝트 README](../README.md)와 [검증 기록](../verification-report.md)을 따른다.

기존 Confluence MCP와 대상 페이지 URL을 사용할 수 있는 사내 PC의 우선 연결 방식은 [호스트 연동 보완안 v0.4](../host-mcp-integration-v0.4.md)를 따른다. 루트 URL을 입력하고 기능별로 MCP·API·인증된 HTTP·브라우저 중 실제로 사용할 수 있는 경로를 선택한다.

- [connections.example.json](../config/connections.example.json): 시스템 URL·토큰, 선택 가능한 사내 모델 목록·기본 모델을 관리할 연결 파일의 빈 템플릿. 실제 파일 경로와 로더 계약은 [연결 설정 안내](../config/README.md)를 따른다.
- `team-config.example.json`: 구현할 업무 애플리케이션의 범위·팀원·레포·평가와 연결 참조. OpenCode 자체 설정이 아니다.
- `opencode.example.json`: OpenCode 1.x 문서 형식의 사내 Chat Completions 호환 provider 연결 예시.
- `opencode.v2.example.json`: OpenCode 2.x의 native provider 연결 형식 예시. 서버 연결에는 `@opencode/client`를 사용하며, 프로세스 내 `@opencode/sdk`와 구분한다.
- `correction.example.json`: 역할 귀속을 교정하는 제안 이벤트. 근거 ID·작성자·사례는 모두 가상이다.
- `evaluation-run.example.json`: 실행 화면에서 기본 모델 대신 다른 모델을 선택한 업무 API 요청 예시. `request`만 제안 API의 요청 본문이며 모델·실행 ID는 가상 값이다.
- `host-connection-profile.example.json`: 사용자가 확인한 사내 PC·MCP·URL을 사용하는 호스트 실행 프로필. 실제 수집 경로는 항목별로 선택하며 MCP를 선택할 때만 MCP 이름·도구 매핑이 필요하다.

OpenCode major version을 먼저 확인한다. 1.x와 2.x의 API·클라이언트·플러그인을 혼용하지 않는다. 두 provider 예시 모두 실제 모델·인증·권한·네트워크·보조 호출 동작을 설치 버전에서 확인해야 한다.

Confluence 설정의 `candidate_backends`는 후보 목록이며 고정 재시도 순서가 아니다. 본문·하위 목록·버전·댓글에 서로 다른 경로를 적용할 수 있다. 페이지 본문만 읽거나 로그인 화면이 반환된 것을 하위 전체·기간 이력 수집 완료로 처리하지 않는다. 같은 페이지·버전을 여러 경로로 읽어도 기여를 중복 계산하지 않는다.

실제 URL·토큰은 Git에서 제외한 `config/connections.local.json`에 저장한다. OpenCode 실행기는 이 파일에서 `CORP_LLM_BASE_URL`·`CORP_LLM_TOKEN`을 자식 프로세스에 주입하고 provider·모델 목록·기본 모델을 생성하도록 구현한다. 두 OpenCode 예시는 그 생성 형식의 참고 자료이며 값을 중복 관리하는 설정 원본이 아니다. 실행별 모델 선택은 요청으로 전달하고 실행 도중에는 변경하지 않는다. 토큰 원문은 공유 예시·생성 설정·로그·프롬프트에 기록하지 않는다. `update` 등 전역 설정으로 적용해야 하는 항목은 선택 버전의 적용 위치를 확인한다. 호스트 프로필은 팀 설정의 연결 파일 참조를 상속한다.

JSON 구문, 설정 간 모델·레포·팀원 참조, 가중치 합, 문서의 로컬 링크를 검사했다. 사내 endpoint·SDK 호출·실제 수집은 시험하지 않았다. 공식 원격 JSON Schema의 자동 다운로드 검증은 실행 환경의 HTTP 403 응답으로 완료하지 못했으며, 예시는 공식 버전별 문서와 대조했다.
