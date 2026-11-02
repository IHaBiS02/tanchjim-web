# LUNA Control

TANCHJIM LUNA AT DAC를 브라우저에서 설정하는 **비공식** 웹 컨트롤러입니다.
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

## 지원 기기

현재는 **LUNA AT**(`2fc6:f0f0`, 제품명 `TANCHJIM-LUNA AT`)만 지원합니다.
같은 칩을 쓰는 다른 TANCHJIM 제품이 같은 VID/PID를 쓸 수 있어서 USB 제품명까지 확인하며,
다른 기기로 확인되면 명령을 하나도 보내지 않고 연결을 닫습니다.

## 지원 환경

| OS | 연결 방식 | 기능 | 상태 |
|---|---|---|---|
| Linux | WebUSB | 읽기 + 쓰기 | ✅ 확인 (udev 규칙 필요) |
| macOS · ChromeOS · Android | WebUSB | 읽기 + 쓰기 | 미검증 |
| Windows | WebHID | 쓰기 전용 | 미검증 |

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
js/protocol.js      명령 생성과 응답 해석
js/transport.js     WebUSB(읽기/쓰기) · WebHID(쓰기 전용) 전송 계층
js/app.js           상태 관리와 UI 연결
linux/              udev 규칙
PROTOCOL.md         프로토콜 분석 노트
```

## 프로토콜

명령은 `C1 A5 <cmd> <값> 00 00 00` 형태의 7바이트이고, 응답은 `A1 A5 <cmd> ...` 8바이트입니다.
WebUSB에서는 EP0 벤더 컨트롤 전송(`0x43/0xA0`, `0xC3/0xA1`, wIndex `0x09A0`)을 쓰고,
WebHID에서는 같은 7바이트를 Output 리포트로 보냅니다. 자세한 내용은 [PROTOCOL.md](PROTOCOL.md)를 참고하세요.
