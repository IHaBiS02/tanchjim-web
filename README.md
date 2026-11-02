# LUNA Control

TANCHJIM LUNA · SPACE 시리즈 DAC를 브라우저에서 설정하는 **비공식** 웹 컨트롤러입니다.
실기기로 검증한 것은 **LUNA AT**뿐이고, 나머지 기기는 공식 앱 분석만으로 만든 **미검증** 모드입니다.
공식 앱이 없는 Linux를 포함해, 설치 없이 Chromium 계열 브라우저만으로 쓸 수 있도록 만들었습니다.

> TANCHJIM과 무관한 개인 프로젝트입니다. 사용에 따른 책임은 사용자에게 있습니다.

## 기능

- 하드웨어 볼륨 (공식 앱과 같은 61단계, -127.5 ~ 0 dB)
- 좌우 밸런스 (±20 dB, 0.5 dB 단위)
- 디지털 필터 5종 (저지연/위상 보상 × 빠른/느린 롤오프, NOS)
- 게인 Low 2 Vrms / High 4 Vrms
- DAC 출력 모드 Class AB / Class H
- DRE on/off (펌웨어 7 이상)
- 펌웨어 버전, 재생 중인 샘플레이트 표시 (WebUSB 연결 시)
- SPACE: LED on/off · SPACE II: 마이크 게인 (-60 ~ +12 dB) — 미검증

## 지원 기기와 모드

| 모드 | USB 제품명 | 명령 체계 | 상태 | 화면 차이 |
|---|---|---|---|---|
| LUNA AT | `TANCHJIM-LUNA AT` | LUNA (7바이트) | ✅ 실기기 검증 | — |
| LUNA | `TANCHJIM-LUNA` | LUNA (7바이트) | 미검증 | LUNA AT와 같음 |
| SPACE | `TANCHJIM-SPACE` | LUNA (7바이트) | 미검증 | LED 있음, 재생 포맷·DAC 모드 없음, DRE는 펌웨어 9 이상 |
| SPACE II | `TANCHJIM-SPACE II` | 64바이트 HID (`4B ..`) | 미검증 | 볼륨 0–60단계, 마이크 게인, 재생 포맷 없음. WebHID 전용 |

- 장치 선택 창에는 TANCHJIM 제품이 쓰는 VID(`2fc6`, `31b2`, `3302`, `0666:0888`)의 장치가 모두 나옵니다.
- 모드는 공식 앱처럼 **USB 제품명**으로 자동 선택됩니다. 제품명을 알아보지 못하면 아무 명령도 보내지 않고, 사용자가 직접 모드를 고를 때까지 기다립니다.
- 모드를 직접 바꿀 수 있지만 경고 확인을 거칩니다. 이 선택은 장치별로 브라우저에 저장됩니다.
- 설정을 보내기 전에 먼저 그 모드의 **읽기 명령**(LUNA: `C1 A5 A0`, SPACE II: `4B 80 0C`)을 보내 올바른 응답이 오는지 확인하고, 아니면 쓰기를 막습니다.
  WebHID로 연결한 LUNA 계열은 응답을 읽을 수 없어 확인이 불가능하므로, 제품명과 다른 모드를 고르면 한 번 더 묻습니다.
- 플래시 저장(SPACE II `4B 01 04` 등)처럼 되돌리기 어려운 명령은 보내지 않습니다.
- SPACE PRO / SPACE PRO AT은 공식 앱에서 다른 명령 체계를 쓰므로 지원하지 않습니다.

## 지원 환경

| OS | 연결 방식 | 기능 | 상태 |
|---|---|---|---|
| Linux | WebUSB | 읽기 + 쓰기 | ✅ 확인 (udev 규칙 필요) |
| macOS · ChromeOS · Android | WebUSB | 읽기 + 쓰기 | 미검증 |
| Windows | WebHID | LUNA 계열 쓰기 전용 · SPACE II 읽기 + 쓰기 | 미검증 |

- Chrome, Edge 등 **Chromium 계열** 브라우저가 필요합니다. Firefox와 Safari는 WebUSB/WebHID를 지원하지 않습니다.
- Windows에서는 오디오 장치를 WebUSB로 열 수 없어 WebHID로 연결합니다. 이때는 장치의 현재 상태를 읽을 수 없어,
  화면에는 그 브라우저에서 마지막으로 보낸 값이 표시됩니다.

## Linux 설정 (최초 1회)

브라우저가 장치에 접근할 수 있도록 udev 규칙을 설치합니다.

```sh
sudo cp linux/70-tanchjim.rules /etc/udev/rules.d/
sudo udevadm control --reload && sudo udevadm trigger
```

로그인한 사용자에게만 이 장치의 권한을 열어 줍니다 (`TAG+="uaccess"`).

## 로컬에서 실행

빌드 과정이 없는 정적 파일입니다. WebUSB/WebHID는 보안 컨텍스트(HTTPS 또는 localhost)에서만 동작하므로
`file://`로 열지 말고 로컬 서버를 띄워 주세요.

```sh
python3 -m http.server 8000 --bind 127.0.0.1
# http://127.0.0.1:8000 접속
```

## 구조

```
index.html          UI
css/style.css       스타일 (라이트/다크)
js/devices.js       지원 VID, 모드 정의, 제품명으로 모드 판별
js/protocol.js      LUNA 계열 명령 생성과 응답 해석
js/space2.js        SPACE II 명령 생성과 응답 해석 (미검증)
js/drivers.js       모드별 드라이버 (응답 확인, 읽기, 설정 적용)
js/transport.js     WebUSB(EP0 컨트롤) · WebHID(Output/Input 리포트) 전송 계층
js/app.js           상태 관리와 UI 연결
linux/              udev 규칙
PROTOCOL.md         프로토콜 분석 노트
```

## 프로토콜

명령은 `C1 A5 <cmd> <값> 00 00 00` 형태의 7바이트이고, 응답은 `A1 A5 <cmd> ...` 8바이트입니다.
WebUSB에서는 EP0 벤더 컨트롤 전송(`0x43/0xA0`, `0xC3/0xA1`, wIndex `0x09A0`)을 쓰고,
WebHID에서는 같은 7바이트를 Output 리포트로 보냅니다.
SPACE II는 `4B 80 <reg>`(읽기) / `4B 01 <reg> <len> <값>`(쓰기) 형태의 64바이트 HID 리포트를 씁니다. 자세한 내용은 [PROTOCOL.md](PROTOCOL.md)를 참고하세요.
