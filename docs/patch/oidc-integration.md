# Staff 로그인 OIDC 연동 계획

이 문서는 현재 코드 구조를 기준으로 한 구현 계획이다. 아래의 신규 파일,
타입, 함수, 설정 및 응답 필드는 앞으로 추가할 계약이며, 이미 구현된 기능을
뜻하지 않는다. 상위 설계와 파일·함수 단위의 수정 내용을 함께 정리한다.

## 1. 목표와 정책

표준 OIDC 제공자에서 인증한 사용자의 `email` claim으로 기존 Ghost staff를
찾고, 기존 Admin 세션 서비스를 통해 로그인시킨다.

| 항목           | 정책                                                         |
| -------------- | ------------------------------------------------------------ |
| 제공자         | Discovery를 지원하는 표준 OIDC 제공자 1개                    |
| 로그인 방식    | OIDC 활성화 시 staff 브라우저 로그인은 OIDC 전용             |
| 계정 조회      | 검증한 `email`과 기존 staff 이메일을 대소문자 구분 없이 비교 |
| 계정 자격      | 사이트 setup이 완료되어 있고 `User.isActive()`가 참인 staff  |
| 계정 생성      | OIDC 콜백은 기존 계정 조회만 수행                            |
| 권한           | Ghost에 저장된 staff 역할과 권한 사용                        |
| 추가 인증      | IdP에 위임하며 Ghost 이메일 코드 인증은 생략                 |
| 계정 연결 저장 | 로그인마다 이메일로 조회                                     |
| 로그아웃       | Ghost 세션 종료. 이후 IdP 인증은 IdP의 세션 정책에 따름      |

추가 설계 결정은 다음과 같다.

- `email_verified === true`인 이메일만 신뢰한다. 누락, `false`, 문자열
  `"true"`는 거절한다. IdP는 `openid email` scope에 필요한 claim을 제공해야 한다.
- `sub`는 ID Token과 UserInfo의 동일 사용자 여부를 검증하는 데 사용한다.
  Ghost 계정 연결 키는 `email`이다.
- 이메일 변경을 자동 동기화하지 않는다. IdP의 이메일이 변경되면 다음 로그인은
  변경된 이메일에 해당하는 기존 staff를 찾는다.
- `inactive`, `locked`, 미수락 초대, 초기 setup용 Owner는 로그인 대상이 아니다.
  현재 모델의 활성 상태에는 `warn-1`부터 `warn-4`도 포함되므로
  `status === 'active'`라는 별도 판정을 만들지 않는다.
- 이 정책의 적용 대상은 브라우저용 staff 세션 인증이다. Staff Access Token과
  Integration API key에는 각각의 기존 인증·인가 정책이 적용된다.

## 2. 상위 설계

```text
Admin 로그인 화면
  → GET /ghost/auth/oidc/start/
  → 임시 인증 트랜잭션 쿠키 발급
  → IdP Authorization Endpoint
  → GET /ghost/auth/oidc/callback/
  → state / PKCE / nonce / ID Token 검증
  → 검증된 email로 활성 staff 조회
  → 기존 Admin 세션 ID 회전 및 인증 완료 상태 저장
  → 원래 접근하려던 Admin hash route로 이동
```

설계의 책임 경계는 다음과 같이 나눈다.

1. `server/auth/oidc/`: 설정, OIDC 클라이언트, claim 검증, 임시 트랜잭션.
2. `server/web/admin/oidc/`: 브라우저 리다이렉트와 HTTP 요청·응답 처리.
3. `server/auth/session/`: 최종 Admin 세션 발급, 인증 방식 확인, 로그아웃.
4. Admin API: 공개 로그인 기능 정보 제공, 비밀번호 인증 경로의 서버 측 차단.
5. React Admin: 로그인 버튼, 오류 표시, 복귀 위치 및 계정 관련 화면 연동.

OIDC 클라이언트는 boot에서 구성한다. 기존 인증 하위 시스템의 위치에 맞춰
`server/auth/` 안에 두고, HTTP 라우트와 프로토콜 처리를 분리한다.

## 3. 현재 코드에서 확인한 제약

| 현재 위치                                                              | 현재 동작                                            | 구현에 미치는 영향                                   |
| ---------------------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------- |
| `ghost/core/server/api/endpoints/session.js`의 `add()`                 | 비밀번호 확인 후 `auth.session.createSession()` 호출 | OIDC 전용 모드에서 서버 측 차단 필요                 |
| `ghost/core/server/auth/session/session-service.js`                    | 세션 회전, 사용자별 verification, Admin Origin 검사  | 쿠키를 직접 발급하지 않고 이 계층에 OIDC 진입점 추가 |
| `ghost/core/server/auth/session/index.js`의 `createSessionFromToken()` | legacy SSO adapter로 verified 세션 생성              | OIDC 전용 모드에서 legacy SSO 진입 차단 필요         |
| `ghost/core/server/web/parent/backend.js`                              | `/ghost`에 SSO와 Admin 앱을 순서대로 mount           | OIDC 라우트를 그보다 먼저 mount                      |
| `ghost/core/server/web/admin/middleware/redirect-admin-urls.js`        | 일반 Admin 경로를 `#/...`로 전환                     | OIDC 콜백이 이 미들웨어에 도달하기 전에 처리         |
| `ghost/core/server/web/parent/middleware/filter-query-parameters.ts`   | 공개 경로의 미등록 query 제거                        | OIDC 시작·콜백 경로에 한정된 예외 필요               |
| `ghost/core/server/api/endpoints/authentication.js`의 `resetPassword`  | 비밀번호 재설정 후 verified 세션 발급                | 로그인 폼 제거만으로는 OIDC 전용이 되지 않음         |
| `ghost/core/server/models/session.js`와 `data/schema/schema.js`        | `sessions.user_id` 필수, `session_data` 최대 2000자  | 로그인 전 임시값은 별도 쿠키에 저장                  |
| `apps/admin/src/auth/signup.tsx`                                       | 초대 수락 뒤 비밀번호 자동 로그인                    | OIDC 모드에서는 수락 후 OIDC 로그인으로 연결         |
| `ghost/core/server/auth/reset-authentication.ts`                       | 전체 인증 초기화에서 모든 staff를 `locked`로 변경    | OIDC 모드에서는 계정 잠금 없이 API key·세션을 초기화 |

기존 구조의 설명은 [인증 가이드](../codebase/authentication.md),
[인증 하위 시스템 README](../../ghost/core/server/auth/README.md),
[설정 스키마 가이드](../../ghost/core/shared/config/SCHEMA.md)를 참고한다.

## 4. 설정 및 외부 계약

### 4.1 서버 설정

설정 위치는 `admin.auth`로 통일한다. 기본값은 `mode: 'password'`이며,
OIDC 적용 사이트는 명시적으로 `mode: 'oidc'`를 설정한다.

```json
{
  "admin": {
    "auth": {
      "mode": "oidc",
      "oidc": {
        "issuer": "https://idp.example.com/realms/staff",
        "clientId": "ghost-admin",
        "displayName": "Company SSO",
        "tokenEndpointAuthMethod": "client_secret_basic"
      }
    }
  }
}
```

`clientSecret`은 `admin.auth.oidc.clientSecret`으로 읽는다. 예를 들어 기존
secret-file 로더를 통해 `admin__auth__oidc__clientSecret_FILE`로 공급할 수 있다.

- `mode`: `password | oidc`.
- `issuer`: query와 fragment가 없는 HTTPS issuer URL.
- `clientId`, `clientSecret`: 비어 있지 않은 문자열.
- `displayName`: 기본값 `SSO`.
- `tokenEndpointAuthMethod`: `client_secret_basic | client_secret_post`,
  기본값 `client_secret_basic`. Discovery의 지원 목록과 일치해야 한다.
- scope: `openid email`.
- 응답 방식: `response_type=code`, `response_mode=query`.
- callback URL: 설정된 Admin URL에 `auth/oidc/callback/`을 결합해 서버가 계산.

정적 설정 검증과 Discovery는 boot에서 수행한다. OIDC 설정 오류나 Discovery
실패는 관리자 인증을 `unavailable`로 만들며 비밀번호 인증을 허용하지 않는다.
공개 사이트는 계속 서비스하고, 실패 원인은 비밀정보 없는 오류 코드로 기록한다.
boot에서의 Discovery 실패를 복구하는 첫 버전의 재시도 경계는 프로세스 재시작이다.
요청이 클라이언트를 초기화하지 않는다.

### 4.2 HTTP 라우트

설치 하위 경로가 있으면 아래 경로 앞에 해당 하위 경로가 붙는다.

| Method | 경로                         | 입력                                               | 결과                        |
| ------ | ---------------------------- | -------------------------------------------------- | --------------------------- |
| GET    | `/ghost/auth/oidc/start/`    | 선택적 `returnTo`                                  | 임시 쿠키 설정 후 IdP로 302 |
| GET    | `/ghost/auth/oidc/callback/` | `code`, `state`, 선택적 `iss`, 또는 OIDC 오류 응답 | 검증 후 Admin으로 303       |

- 시작 요청마다 새 `state`, `nonce`, PKCE verifier를 만든다.
- `returnTo`는 `/posts?...`와 같은 Admin 내부 hash route이며, 완성된 외부 URL이 아니다.
- `returnTo`는 최대 1024자로 제한하고, `//`, 역슬래시, 제어 문자,
  외부 origin 및 auth route를 거절한다. 잘못된 값은 `/`로 정규화한다.
- 콜백 URL은 고정된 callback URL에 실제 query만 결합해 구성한다.
  요청의 `Host`, `Origin`, `Referer`를 redirect URI 결정에 사용하지 않는다.
- query parameter가 배열·객체이거나 `code`, `state` 등 주요 값이 중복되면 거절한다.
- 양쪽 라우트에 `Cache-Control: no-store`, `Referrer-Policy: no-referrer`를 설정한다.

### 4.3 공개 로그인 기능 정보

기존 `/ghost/api/admin/site/` 응답의 `site`에 선택적 `staff_authentication`을 추가한다.

```ts
type StaffAuthentication =
  | {mode: 'password'}
  | {
      mode: 'oidc';
      status: 'ready' | 'unavailable';
      provider_name: string;
      start_url: string;
    }
  | {mode: 'unavailable'};
```

`start_url`은 canonical Admin origin의 절대 URL이다. secret, issuer metadata,
token, staff 이메일 목록은 이 응답에 포함하지 않는다. `mode: 'unavailable'`은
알 수 없는 mode 등 정책 설정 자체가 유효하지 않을 때 사용한다.

새 Admin은 필드가 없는 backend를 기존 비밀번호 인증 서버로 취급한다.
OIDC 모드의 backend에 구버전 Admin이 연결되더라도 비밀번호 API는 서버에서 거절된다.
실제 OIDC 모드 활성화는 새 Admin 배포 뒤에 수행한다.

## 5. OIDC 및 세션 상세 설계

### 5.1 프로토콜 클라이언트

`openid-client` 6.x API를 기준으로, 구현 시 Node 22 호환 안정 버전을 카탈로그에
고정한다. 아래 API를 명시적으로 사용한다.

- boot: `discovery()`로 issuer와 클라이언트를 구성한다.
- boot: `enableNonRepudiationChecks()`를 활성화해 ID Token JWS 서명을 검증한다.
  이 라이브러리는 TLS token endpoint 응답이라는 이유로 기본 설정만으로는
  해당 서명 검증을 수행하지 않을 수 있다.
- 시작: `randomState()`, `randomNonce()`, `randomPKCECodeVerifier()`,
  `calculatePKCECodeChallenge()`, `buildAuthorizationUrl()`.
- 콜백: `authorizationCodeGrant()`에 `expectedState`, `expectedNonce`,
  `pkceCodeVerifier`, `idTokenExpected: true`를 모두 전달한다.
- UserInfo가 필요하면 `fetchUserInfo()`에 검증된 ID Token의 `sub`를 전달한다.

issuer, audience/client ID, 서명, 만료, nonce, state 검증을 통과해야 한다.
Discovery·token·JWKS·UserInfo 요청에는 각각 10초 timeout을 적용한다.
인증 코드 교환은 자동 재시도하지 않는다. ID Token과 access token은 콜백 처리
중에만 사용하며 장기 저장하지 않는다.

### 5.2 이메일 claim 결정

1. 검증된 ID Token에 유효한 `email`과 boolean `email_verified`가 있으면 사용한다.
2. 필요한 claim이 빠졌으면 UserInfo에서 이메일 claim 집합을 얻는다.
3. UserInfo의 `sub`는 ID Token의 `sub`와 같아야 한다. 양쪽에 이메일이 있으면
   대소문자를 무시한 비교에서도 서로 일치해야 한다.
4. 명시적으로 미검증인 이메일을 다른 응답으로 덮어써 허용하지 않는다.
5. 최종 `email_verified === true`와 이메일 형식을 확인한다.
6. `models.User.getByEmail(email)`로 조회하고 `user.isActive()`를 확인한다.
7. `locked` 또는 `inactive` 사용자를 로그인 과정에서 활성화하지 않는다.

사용자 없음과 비활성 계정은 브라우저에 동일한 로그인 거절 메시지로 전달한다.

### 5.3 임시 인증 트랜잭션 쿠키

기존 `sessions` 테이블은 익명 세션을 저장하기에 적합하지 않다. 따라서 로그인
완료 전에는 기존 Admin 세션을 저장하지 않고, 짧은 수명의 전용 쿠키를 사용한다.

- 이름: `ghost-admin-oidc-transaction`.
- payload: `state`, `nonce`, `codeVerifier`, `returnTo`, `providerKey`, `iat`, `exp`.
- 수명: 5분.
- `HttpOnly`, `SameSite=Lax`, HTTPS에서 `Secure`, host-only.
- Path: 설치 하위 경로를 포함한 `/ghost/auth/oidc`.
- 기존 `jose` 의존성의 JWE(`alg: dir`, `enc: A256GCM`)로 암호화·인증한다.
- 키는 `admin_session_secret`에서 HKDF-SHA256과 OIDC 전용 context로 파생한다.
- `providerKey`는 issuer, client ID, canonical callback URL을 묶은 SHA-256 값이다.
  설정이 바뀌면 이전 트랜잭션을 거절한다.
- 쿠키 값은 3800바이트 이하로 제한한다. 초과하면 인증 시작을 거절한다.
- 쿠키 중복, 복호화 실패, schema 오류, 만료, provider 불일치는 거절한다.
- 새 로그인 시작은 이전 트랜잭션을 덮어쓴다. 한 브라우저의 병렬 로그인은
  가장 최근에 시작한 흐름을 기준으로 처리한다.
- 콜백 처리와 로그아웃에서 동일한 Path·속성으로 쿠키를 삭제한다.

인증 코드의 일회성은 IdP token endpoint의 코드 재사용 거절로 보장하고,
브라우저의 트랜잭션은 콜백 응답에서 쿠키를 삭제해 종료한다. 서버 측 state 소비
레지스트리를 두는 설계는 아니므로, 쿠키 삭제를 원자적인 서버 저장소 소비라고
취급하지 않는다. 메모리 저장소나 프로세스 간 sticky session에 의존하지 않는다.

### 5.4 최종 Admin 세션

세션 서비스에 `createOidcSessionForUser(req, res, user, context)`를 추가한다.

```ts
type OidcSessionContext = {
  providerKey: string;
};

type StaffSessionAuthentication = {
  method: 'oidc';
  providerKey: string;
  userId: string;
};
```

이 진입점은 검증이 끝난 OIDC 콜백에서만 호출한다.

1. 기존 Express session을 로드하고 기존 세션 ID를 회전한다.
2. 기존 사용자 할당 로직에 **설정된 canonical Admin origin**을 명시적으로 전달한다.
   IdP의 Referer를 일반 로그인 Origin으로 취급하지 않는다.
3. `user_id`, `origin`, user agent, IP를 기존 세션 규칙으로 기록한다.
4. `verified = true`, `verified_user_id = user.id`를 기록하고 이메일 challenge를 지운다.
5. `session.authentication`에 위 인증 방식을 기록한다.
6. `req.session.save()` 완료 후에만 성공 리다이렉트를 보낸다.

기존 `assignUserToSession()`의 canonical Admin origin 검사는 유지한다.
일반 로그인에서 사용하는 `getOriginOfRequest()`와 전역 CSRF 보호를 완화하거나,
요청 body에 있는 인증 방식·verification 값을 신뢰하지 않는다.

`getUserForSession()`은 OIDC 모드에서 다음 조건을 모두 확인한다.

- 기존 Origin/CSRF 검사 및 활성 staff 조회.
- `session.authentication.method === 'oidc'`.
- 현재 설정과 같은 `providerKey`.
- `session.authentication.userId === session.user_id`.
- 기존 verification의 `verified_user_id === session.user_id`.

따라서 모드 전환 전의 비밀번호·legacy SSO 세션은 다음 요청에서 인증되지 않는다.
OIDC 발급 정보는 기존 `session_data`에 짧게 저장하고, 토큰·Discovery 응답은 넣지 않는다.

## 6. 정확한 파일별 수정 계획

이 절의 파일 경로는 저장소 루트 기준이다. `신규` 표시는 앞으로 만들 파일이다.

### 6.1 의존성과 기본 설정

| 파일                                     | 수정 내용                                                                            |
| ---------------------------------------- | ------------------------------------------------------------------------------------ |
| `pnpm-workspace.yaml`                    | `openid-client`의 고정 버전을 catalog에 추가                                         |
| `ghost/package.json`                     | `openid-client: catalog:` 의존성 추가. `jose`, `cookies`, `zod`는 현재 의존성 재사용 |
| `pnpm-lock.yaml`                         | pnpm으로 의존성을 갱신한 결과 반영                                                   |
| `ghost/core/shared/config/defaults.json` | `admin.auth.mode: 'password'` 기본값 추가                                            |

OIDC 전용 schema는 아래 기능 소유 파일에 둔다. 중앙 config schema나 settings
테이블에 OIDC 설정을 추가하는 방식은 사용하지 않는다.

### 6.2 인증 정책과 OIDC 모듈

| 파일                                                 | 추가할 책임·함수                                                                                                       |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `ghost/core/server/auth/oidc/config.ts` — 신규       | `readStaffAuthConfiguration()`으로 `admin:auth`를 한 곳에서 읽고 Zod 검증. 유효 설정 또는 명시적 unavailable 상태 반환 |
| `ghost/core/server/auth/oidc/client.ts` — 신규       | `createOidcClient()`, `buildLoginUrl()`, `validateAuthorizationResponse()` 구현. 위 프로토콜 API와 timeout 설정 집중   |
| `ghost/core/server/auth/oidc/identity.ts` — 신규     | `resolveVerifiedEmail()`과 `resolveActiveStaff()` 구현. claim 검증과 `getByEmail()`·`isActive()` 호출                  |
| `ghost/core/server/auth/oidc/transaction.ts` — 신규  | `createTransaction()`, `writeTransactionCookie()`, `readTransactionCookie()`, `clearTransactionCookie()` 구현          |
| `ghost/core/server/auth/oidc/redirect.ts` — 신규     | `normalizeReturnTo()`, `getOidcUrls()`, `getProviderKey()` 구현. Admin URL·하위 경로 처리 집중                         |
| `ghost/core/server/auth/oidc/index.ts` — 신규        | `defineService()` 기반 default export. boot에서 policy·client·cookie key를 구성하고 `.service`로 접근                  |
| `ghost/core/server/auth/staff-auth-policy.ts` — 신규 | 초기화된 OIDC root의 policy를 읽는 `getStaffAuthPolicy()`, `assertPasswordAuthenticationAllowed()` 제공                |

`index.ts`는 비밀번호 모드에서도 policy를 제공한다. 정상 OIDC 상태, OIDC 사용
불가 상태, 잘못된 정책 상태를 명시적으로 구분한다. Discovery 실패도 준비된
`unavailable` 상태로 표현해 공개 사이트 boot를 계속할 수 있게 한다.

`staff-auth-policy.ts`는 OIDC root를 초기화하지 않는다. root 구성 과정에서
이 getter를 다시 호출하는 순환 의존성도 만들지 않는다. 모델·설정·세션 서비스
의존성은 root에서 구성하고 구현 함수에 전달한다. 기존 session 모듈에는 정책과
provider 조회 함수를 주입하고, 모듈을 로드하는 시점에는 `.service`를 읽지 않는다.

### 6.3 boot와 라우팅

| 파일                                                                 | 수정 내용                                                                                 |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `ghost/core/boot.js`                                                 | `initCore()`의 settings·i18n 초기화 뒤, Express 앱 구성 전에 OIDC root의 `init()`을 await |
| `ghost/core/server/web/admin/oidc/router.ts` — 신규                  | `createOidcRouter()`로 `/start/`, `/callback/` 처리 및 오류→로그인 화면 redirect 구현     |
| `ghost/core/server/web/parent/backend.js`                            | `/ghost/auth/oidc` router를 기존 `/ghost` SSO/Admin mount 앞에 등록                       |
| `ghost/core/server/web/parent/middleware/filter-query-parameters.ts` | OIDC start·callback 경로에 한정한 query 보존 예외 추가                                    |

OIDC router 안에서 필요한 Admin HTTPS·host 정규화를 먼저 적용한다. 이후 시작
라우트는 설정 상태·setup 완료 여부를 확인하고 전역 요청 제한을 적용한 뒤
트랜잭션과 IdP URL을 만든다. 콜백은 query와 쿠키를 읽고, 즉시 쿠키 삭제 응답을
예약한 뒤 프로토콜 검증·계정 조회·세션 발급을 수행한다.

query 필터 예외는 `/ghost/auth/oidc/start/`와 `/ghost/auth/oidc/callback/`의
대소문자 및 trailing slash 변형까지 라우터와 같은 기준으로 처리한다.
일반 공개 경로의 allowlist에 `code`, `state`를 전역 추가하지 않는다.
외부 query 필터가 있는 배포에서도 이 두 경로의 query를 보존해야 한다.

`web/admin/app.js`의 일반 SPA 경로 전환에 OIDC 콜백을 통과시키지 않는다.
따라서 `redirect-admin-urls.js` 자체를 OIDC 예외로 확장할 필요가 없다.

### 6.4 기존 세션 서비스

| 파일                                                | 수정할 함수·내용                                                                                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `ghost/core/server/auth/session/session-service.js` | 세션 회전 부분을 내부 helper로 추출하고 `createOidcSessionForUser()` 추가. OIDC는 이전 verification·이메일 challenge를 승계하지 않음        |
| 같은 파일의 `getUserForSession()`                   | OIDC provenance·현재 provider·사용자 바인딩 검사 추가                                                                                       |
| 같은 파일의 `removeUserForSession()`                | 사용자 정보 해제 시 `session.authentication`도 제거                                                                                         |
| `ghost/core/server/auth/session/index.js`           | 정책·provider key 의존성을 session service에 전달. `createSessionFromToken()`은 OIDC 모드에서 adapter 조회 없이 no-op middleware 반환       |
| `ghost/core/server/auth/session/express-session.js` | 현재 쿠키 옵션을 내부 helper로 묶고 `destroySession(req, res)` 추가. 세션 destroy를 await한 뒤 같은 이름·Path·보안 속성으로 쿠키를 만료시킴 |
| `ghost/core/server/auth/session/middleware.js`      | OIDC 모드의 logout은 session service를 통해 `destroySession()`까지 await하고 임시 OIDC 쿠키도 삭제                                          |

최종 Admin 쿠키는 기존 `express-session.js`의 이름·경로·저장소·보안 속성을
사용한다. 임시 OIDC 쿠키는 이 쿠키와 목적 및 수명이 다른 별도 쿠키다.
`destroySession()`도 기존 `getSession`처럼 session service에 의존성으로 전달해
endpoint나 OIDC router가 Admin 쿠키 옵션을 중복 구현하지 않게 한다.

### 6.5 비밀번호 인증 진입점 차단

`assertPasswordAuthenticationAllowed()`는 허용되지 않은 모드에서
`NoPermissionError`와 `STAFF_PASSWORD_AUTH_DISABLED` 코드를 반환한다.
설정이 unavailable인 경우에도 비밀번호 인증은 거절한다.

| 파일                                                  | 정확한 수정 지점                                                                                                            |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `ghost/core/server/api/endpoints/session.js`          | `add()` 시작에서 정책 검사. `sendVerification()`·`verify()`에도 적용해 과거 이메일 challenge 사용 차단                      |
| `ghost/core/server/api/endpoints/authentication.js`   | `generateResetToken.query()`, `resetPassword.query()`, `updateSetup.query()` 시작에 검사 추가                               |
| `ghost/core/server/api/endpoints/users.js`            | `changePassword.query()`에서 모델 변경과 `rotateSessionForSelfPasswordChange()` 실행 전에 검사                              |
| `ghost/core/server/web/api/endpoints/admin/routes.js` | password reset 완료 라우트의 `auth.session.initSession` 앞에 정책 middleware 적용해 차단된 요청의 불필요한 세션 초기화 방지 |

정책의 본체는 endpoint/controller 내부에 둬서 직접 controller를 호출하는
경로에서도 적용한다. 라우트의 검사는 초기 세션 생성 방지를 위한 선행 검사다.
과거에 발급한 password-reset token으로도 OIDC 세션을 만들 수 없어야 한다.

`authentication.setup.query()`는 OIDC 모드에서 생성 작업 전에 거절하고,
`isSetup`은 계속 조회할 수 있게 한다. 처음 적용하는 대상은 Owner setup이
완료된 사이트다. 새 사이트는 기존 setup을 완료한 뒤 OIDC 모드를 활성화한다.

### 6.6 staff 초대와 전체 인증 초기화

초대 수락은 관리자가 발행한 초대에 근거한 별도의 계정 생성 절차다. 초대 토큰을
수락해 staff가 생성된 다음, OIDC 콜백에서 동일한 이메일의 활성 staff를 조회한다.

| 파일                                                                    | 수정 내용                                                                                                                                          |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ghost/core/server/api/endpoints/utils/validators/input/invitations.js` | `acceptInvitation()`에서 OIDC 모드에 한해 비밀번호 필수 검사를 생략. token·name 검증 유지                                                          |
| `ghost/core/server/api/endpoints/authentication.js`                     | `acceptInvitation.query()`에서 OIDC 모드라면 클라이언트 비밀번호 대신 기존 `generatePassword('')` helper로 생성한 값을 기존 invites service에 전달 |
| `ghost/core/server/auth/reset-authentication.ts`                        | 서버 내부 인자 `lockStaffUsers` 추가. 기본값은 `true`, OIDC 모드 호출은 `false`. `false`일 때 `lockAll()` 생략 및 `usersLocked: 0` 반환            |
| `ghost/core/server/api/endpoints/authentication.js`                     | `reset.query()`에서 현재 정책으로 `lockStaffUsers` 결정. API key 회전·세션 삭제·요청 세션 destroy는 수행                                           |

초대 수락 endpoint 자체는 로그인 세션을 발급하지 않는다. 실제 이메일과 역할은
현재 `services/invites/accept.ts`처럼 검증한 초대 레코드에서 읽는다. 생성한
비밀번호는 기존 모델을 통해 hash로 저장되며 응답이나 로그로 반환하지 않는다.

전체 인증 초기화의 기존 `security_action` 응답 형식은 유지하고 OIDC 모드에서는
`users_locked`가 0이다. 계정 잠금 없이 세션을 무효화하므로 다음 로그인은 OIDC로
가능하다. 이 동작은 IdP의 세션·자격 증명을 초기화하는 기능은 아니다.

### 6.7 공개 API와 Admin Framework

| 파일                                                              | 수정 내용                                                                                |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `ghost/core/server/api/endpoints/utils/public-config/site.js`     | `getSiteProperties()`에 `staff_authentication` 추가. OIDC root의 공개 descriptor만 사용  |
| `apps/admin-x-framework/src/api/site.ts`                          | `StaffAuthentication` 타입과 `SiteData.staff_authentication?` 추가                       |
| `apps/admin-x-framework/src/api/authentication.ts`                | `AcceptInvitationPayload.password`를 선택적으로 변경. OIDC가 감지된 서버에만 생략해 전송 |
| `apps/admin-x-framework/src/utils/staff-authentication.ts` — 신규 | `getStaffAuthentication()`·`isOidcOnlyAuthentication()`·`buildOidcStartUrl()` 제공       |
| `apps/admin-x-framework/src/helpers.ts`                           | 위 helper export 추가                                                                    |

공개 API의 기능 정보가 Admin의 유일한 기능 감지 기준이다. Labs flag로 backend
지원 여부를 추측하지 않는다. `mode: 'oidc'`에서 `status: 'unavailable'`이면
비밀번호 폼을 보이는 대신 로그인 불가 상태를 표시한다.

`buildOidcStartUrl()`은 서버가 제공한 canonical start URL을 검증한 뒤
`returnTo`를 URLSearchParams로 추가한다. 브라우저가 issuer나 callback을 구성하지 않는다.

### 6.8 React Admin 로그인과 관련 화면

| 파일                                                    | 수정 내용                                                                                                                               |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/admin/src/auth/client/auth-client.ts`             | `signIn.oidc({returnTo})` 계약 추가. `invitation.accept()`의 password를 선택적으로 변경                                                 |
| `apps/admin/src/auth/client/ghost-auth-client.ts`       | `useBrowseSite()`의 descriptor와 Framework helper로 OIDC URL을 만들고 `window.location.assign()` 실행                                   |
| `apps/admin/src/auth/signin-redirect.ts`                | `peekSigninRedirect()`와 `clearSigninRedirect()` 추가. 기존 `takeSigninRedirect()`는 조회·삭제에 같은 검증 함수 사용                    |
| `apps/admin/src/auth/api.ts`                            | 앱에서 사용할 `clearSigninRedirect()` export 추가                                                                                       |
| `apps/admin/src/app.tsx`                                | `useCurrentUser()`로 로그인 완료를 확인한 뒤 effect에서 `clearSigninRedirect()` 호출                                                    |
| `apps/admin/src/auth/signin.tsx`                        | 기능 정보 로딩·실패·사용 불가·OIDC·기존 로그인 상태를 구분. OIDC 모드에서는 provider 버튼과 오류만 표시                                 |
| `apps/admin/src/auth/auth-route.tsx`                    | OIDC 모드에서 `/reset/:token`, `/signin/verify`는 `/signin`으로 이동. setup 미완료는 지원 시작 조건을 설명하고 setup 폼을 노출하지 않음 |
| `apps/admin/src/auth/signup.tsx`                        | OIDC 모드에서는 password 입력·검증 생략. 초대 수락 후 비밀번호 로그인 대신 OIDC 시작                                                    |
| `apps/admin/src/settings/general/users/profile-tab.tsx` | OIDC 모드에서 `ChangePasswordForm` 대신 IdP에서 인증 정보를 관리한다는 안내 표시. 이메일 설명에 OIDC 매칭 용도 반영                     |
| `apps/admin/src/settings/general/users.tsx`             | OIDC 모드에서는 `require_email_mfa` 토글 대신 MFA를 IdP에서 관리한다는 안내 표시                                                        |
| `apps/admin/src/settings/advanced/danger-zone.tsx`      | OIDC 모드의 전체 인증 초기화 설명·확인 문구·성공 메시지를 세션 종료와 IdP 재로그인 기준으로 변경                                        |

새 AuthClient 메서드의 계약은 다음과 같이 둔다.

```ts
signIn: {
  email(body: {email: string; password: string}): Promise<AuthResult<SignInData>>;
  oidc(body: {returnTo: string}): void;
}
```

실패한 OIDC 로그인에서 원래 위치를 잃지 않도록 시작 시 `peekSigninRedirect()`를
사용한다. 서버는 암호화한 `returnTo`로 성공 redirect를 구성한다. 성공 시에는
해당 hash route에서 signed-in 앱이 새로 로드되므로 별도 콜백 React 화면이 필요 없다.
signed-in 앱이 로그인 완료를 확인하면 sessionStorage의 복귀 위치를 지운다.
실패 시에는 복귀 위치가 남아 다시 로그인할 때 사용할 수 있다.

로그인 상태 정보를 가져오지 못한 경우에는 재시도 화면을 표시한다. 응답을 받기
전의 상태를 구버전 서버로 오인해 비밀번호 폼을 먼저 표시하지 않는다.

UI는 기존 Shade 컴포넌트·semantic token·layout primitive를 사용한다. 제품 문구는
`ghost` namespace와 저장소 번역 추출 절차를 따른다.

### 6.9 오류 처리와 비밀정보 제거

브라우저에 전달할 오류는 아래처럼 제한된 값으로 매핑한다.

| 코드                    | 표시 의미                                      |
| ----------------------- | ---------------------------------------------- |
| `oidc_cancelled`        | IdP에서 인증 취소                              |
| `oidc_invalid_response` | 쿠키·state·nonce·token 검증 실패               |
| `oidc_access_denied`    | 이메일 검증 실패 또는 로그인 가능한 staff 없음 |
| `oidc_unavailable`      | 설정·Discovery·IdP 연결 사용 불가              |

실패는 canonical Admin의 `#/signin?error=<code>`로 보낸다. `signin.tsx`는
알려진 코드만 자체 문구에 매핑한다. IdP의 `error_description`, token endpoint
응답, 원본 exception을 사용자 메시지로 사용하지 않는다.

| 파일                                                     | 수정 내용                                                                                                                                                  |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ghost/core/server/web/parent/middleware/log-request.js` | OIDC start·callback은 query·요청 쿠키·응답 Set-Cookie를 제거하고 Location query를 가린 로깅용 req/res 사본 사용. 실제 프로토콜 처리용 객체는 변경하지 않음 |
| `ghost/core/shared/sentry.js`                            | `beforeSend()`에서 OIDC 관련 request URL·query·쿠키를 제거하고 token·secret이 든 원본 OIDC 오류를 event extra에 첨부하지 않음                              |

콜백 처리에서 라이브러리 오류를 안전한 Ghost 오류 코드로 변환한다. 성공 로그에는
요청 ID·staff ID·결과만 남긴다. 리다이렉트 응답의 `Location`에 포함될 authorization
URL도 state·nonce 등의 query 값을 제거한 형태로만 기록한다.

## 7. 구현 순서

1. **설정·정책 기반 구성**
   - 의존성 catalog와 `admin.auth` 기본값을 추가한다.
   - 설정 parser, 정책 getter, 공개 descriptor 타입을 확정한다.
2. **OIDC 인증 경로 구현**
   - boot 초기화, 프로토콜 클라이언트, claim 검증, 임시 쿠키를 추가한다.
   - backend mount 순서와 query 필터 예외를 적용한다.
3. **기존 세션 및 전용 모드 적용**
   - 세션 서비스에 OIDC 발급 진입점과 provenance 검사를 추가한다.
   - 비밀번호·reset·verification·legacy SSO 경로에 정책을 적용한다.
   - 전체 인증 초기화에서 OIDC 계정 잠금을 제거한다.
4. **Admin 연동**
   - 공개 `/site` 필드와 Framework 타입·helper를 추가한다.
   - 로그인 버튼, 복귀 경로, 오류, 초대 수락, 프로필·보안 문구를 연결한다.
5. **배포 전환**
   - 기본 비밀번호 모드로 backend와 Admin을 배포한다.
   - setup이 완료된 Owner와 staff의 이메일이 IdP claim과 일치하도록 준비한다.
   - canonical callback을 IdP에 등록하고 필요한 이메일 claim·MFA 정책을 설정한다.
   - `admin.auth.mode = 'oidc'`를 설정하고 재시작한다.

모드 전환은 서버 설정에 의해 결정되며 브라우저의 우회 옵션을 제공하지 않는다.
복구를 위한 모드 변경도 운영자가 서버 설정을 명시적으로 수정하고 재시작하는
경계로 둔다. OIDC 인증이 실패했다는 이유만으로 비밀번호 모드를 활성화하지 않는다.

## 8. 완료 상태의 동작 기준

- 검증된 이메일이 활성 staff에 일치할 때만 새로운 Admin 세션이 생성된다.
- OIDC 로그인은 Ghost 이메일 인증 코드를 추가로 요구하지 않는다.
- OIDC 모드에서 비밀번호 로그인·재설정·과거 verification으로 세션을 만들 수 없다.
- 이전 비밀번호·legacy SSO 세션은 OIDC 모드의 인증 수단으로 인정되지 않는다.
- 로그인 성공은 기존 쿠키와 세션 저장소를 사용하고 세션 ID를 회전한다.
- 초대 수락 뒤에는 OIDC로 인증하며, 로그인 자체가 staff를 자동 생성하지 않는다.
- 전체 인증 초기화 후에도 활성 staff는 OIDC로 재로그인할 수 있다.
- 별도 Admin 도메인과 설치 하위 경로가 callback·쿠키·복귀 URL에 반영된다.
- 설정 오류·IdP 장애는 로그인 불가 상태로 표현되며 비밀번호 인증을 열지 않는다.
- DB 변경 없이 구현하고 OIDC 토큰을 장기 보관하지 않는다.
