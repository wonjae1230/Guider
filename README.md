# Guider

웹 페이지 사용법을 AI가 안내해주는 크롬 익스텐션입니다.  
사용자가 질문을 입력하면 현재 페이지의 DOM을 분석해 클릭해야 할 요소를 찾아 하이라이트로 안내합니다.

---

## 문서

| 문서 | 링크 |
|---|---|
| 요구사항 정의서 | [📄 요구사항 정의서.xlsx](https://hongik-my.sharepoint.com/:x:/r/personal/sojoongyi_mail_hongik_ac_kr/Documents/%E1%84%8B%E1%85%AD%E1%84%80%E1%85%AE%E1%84%89%E1%85%A1%E1%84%92%E1%85%A1%E1%86%BC_%E1%84%8C%E1%85%A5%E1%86%BC%E1%84%8B%E1%85%B4%E1%84%89%E1%85%A5.xlsx?d=we3cbdf7a83224c9e9ed93f8d0fce3645&csf=1&web=1&e=CcOmOD) |

---

## 아키텍처

```
Chrome Extension (content script + widget UI)
        │  질문 + DOM 요소 목록
        ▼
  Backend Server (Express)          ← API 키 보호, Redis 캐시
        │  프롬프트 조립
        ▼
  Anthropic Claude API              ← JSON 응답 (navigate / found / notfound)
        │
        ▼
  Extension (highlight + step UI)
```

| 구성 요소 | 역할 |
|---|---|
| `extension/` | 크롬 익스텐션 본체. 위젯 UI(React), content script, service worker |
| `server/` | Claude API 프록시. API 키 보호, Redis 캐싱, 프롬프트 조립 |

---

## 폴더 구조

```
Guider/
├── extension/
│   ├── manifest.json              # 익스텐션 설정
│   ├── background/background.js   # Service Worker
│   ├── widget/                    # 플로팅 위젯 (React, content script로 주입)
│   │   ├── main.jsx               # Shadow DOM 진입점
│   │   ├── ChatWidget.jsx         # 메인 UI 컴포넌트
│   │   ├── aiHelper.js            # DOM 추출, AI 호출, 하이라이트
│   │   └── widget.css             # 위젯 스타일
│   ├── sidepanel/                 # 사이드패널 HTML (현재 미사용)
│   ├── assets/icons/              # 익스텐션 아이콘
│   ├── vite.config.js             # sidepanel 번들 설정
│   └── vite.widget.config.js      # widget IIFE 번들 설정
├── server/
│   ├── index.js                   # Express 서버 (Claude 프록시)
│   ├── cache.js                   # Redis 캐시 유틸
│   └── .env.example               # 환경변수 예시
└── README.md
```

---

## 사전 요구사항

| 항목 | 버전 | 용도 |
|---|---|---|
| **Node.js** | 18 이상 | 서버 및 익스텐션 빌드 |
| **npm** | 9 이상 | 패키지 관리 (Node.js에 포함) |
| **Google Chrome** | 최신 버전 | 익스텐션 실행 |
| **Anthropic API 키** | — | Claude 모델 호출 ([발급](https://console.anthropic.com)) |
| **Redis** | 7 이상 | 응답 캐시 (없어도 동작, 선택사항) |

> Redis가 없으면 캐시 없이 매 요청마다 Claude API를 호출합니다.

---

## 설치 및 실행

### 1. 저장소 클론

```bash
git clone https://github.com/wonjae1230/Guider.git
cd Guider
```

---

### 2. 백엔드 서버 설정

#### 2-1. 패키지 설치

```bash
cd server
npm install
```

#### 2-2. 환경변수 설정

```bash
cp .env.example .env
```

`.env` 파일을 열어 API 키를 입력합니다.

```env
# Anthropic API 키 (필수)
ANTHROPIC_API_KEY=sk-ant-여기에키입력

# Redis 서버 주소 (선택, 기본값: redis://localhost:6379)
REDIS_URL=redis://localhost:6379

# 서버 포트 (선택, 기본값: 3000)
PORT=3000
```

#### 2-3. 서버 실행

```bash
node index.js
```

정상 실행 시 다음 메시지가 출력됩니다.

```
Guider 서버 실행 중 → http://localhost:3000
```

> **Redis 없이 실행하는 경우**: `[Redis] 연결 실패` 경고가 출력되지만 서버는 정상 동작합니다.

---

### 3. 익스텐션 빌드

새 터미널에서 실행합니다.

#### 3-1. 패키지 설치

```bash
cd extension
npm install
```

#### 3-2. 빌드

```bash
npm run build
```

빌드가 완료되면 `extension/dist/` 폴더가 생성됩니다.

```
extension/dist/
├── manifest.json
├── background/background.js
├── content/widget.js          ← 플로팅 위젯 번들 (IIFE)
├── assets/icons/
└── ...
```

> `build` 명령은 내부적으로 두 단계를 순서대로 실행합니다.  
> 1. `vite build` — sidepanel HTML/JS 번들  
> 2. `vite build --config vite.widget.config.js` — content script 위젯 IIFE 번들

---

### 4. 크롬에 익스텐션 로드

1. Chrome 주소창에 `chrome://extensions` 입력
2. 우측 상단 **개발자 모드** 토글 활성화
3. 좌측 상단 **압축해제된 확장 프로그램을 로드합니다** 클릭
4. 빌드 결과물인 **`extension/dist/`** 폴더 선택
5. 아래와 같이 **Guider 0.0.1** 카드가 목록에 나타나면 로드 완료

   ```
   Guider  0.0.1
   웹 페이지 사용법을 AI가 안내해주는 크롬 익스텐션
   ID: cjpmeilcjnbaacnofkaplhhdmbniofj
   ```

> 로드 후 카드 오른쪽 토글이 파란색(활성화) 상태인지 확인하세요.  
> "서비스 워커 (비활성성)" 링크가 보여도 정상입니다 — 위젯을 처음 열 때 워커가 깨어납니다.

---

### 5. 사용 방법

1. 백엔드 서버가 `http://localhost:3000`에서 실행 중인지 확인
2. Chrome에서 원하는 웹 페이지 접속
3. 단축키 **`Cmd+Shift+Y`** (Mac) / **`Ctrl+Shift+Y`** (Windows/Linux) 로 위젯 열기
4. 찾고 싶은 기능을 자연어로 입력 (예: "성적 확인하려면 어디로 가야해?")
5. AI가 해당 요소를 찾아 하이라이트하고 단계별로 안내

---

## 개발 모드

코드 수정 후 빌드 없이 바로 확인하려면:

```bash
# extension/ 디렉토리에서
npm run build
```

빌드 완료 후 `chrome://extensions` 페이지에서 Guider 카드의 **새로고침 버튼(↺)** 을 클릭합니다.

> Hot reload는 지원되지 않습니다. 코드 수정 시마다 빌드 → 익스텐션 새로고침이 필요합니다.

---

## 환경변수 전체 목록

| 변수명 | 필수 | 기본값 | 설명 |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | 필수 | — | Anthropic Console에서 발급한 API 키 |
| `REDIS_URL` | 선택 | `redis://localhost:6379` | Redis 연결 주소 |
| `PORT` | 선택 | `3000` | 서버 포트 |

---

## 브랜치 규칙

| 브랜치 | 용도 |
|---|---|
| `main` | 배포 가능한 안정 버전 |
| `develop` | 통합 개발 브랜치 |
| `feat/[기능명]` | 새로운 기능 개발 |
| `fix/[버그명]` | 버그 수정 |
| `chore/[작업명]` | 빌드, 설정, 기타 잡무 |
| `docs/[문서명]` | 문서 작업 |

- 모든 작업은 `develop` 브랜치에서 분기합니다.
- 브랜치 이름은 소문자와 하이픈(`-`)을 사용합니다. (예: `feat/dom-parser`)
- 작업 완료 후 `develop`으로 PR을 올립니다.
- `main` 브랜치에는 직접 푸시하지 않습니다.

## PR 규칙

- **1명 이상의 승인(Approve)** 을 받아야 머지할 수 있습니다.
- PR 제목 형식: `[feat] DOM 파서 구현`
- PR 본문에 **작업 내용 / 변경 이유 / 테스트 방법** 을 간략히 작성합니다.
- Merge 방식: **Squash and Merge**
