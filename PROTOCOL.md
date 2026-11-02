# TANCHJIM LUNA AT 제어 프로토콜 (분석 노트)

출처: Android 앱 `com.tanchjim.android` (jadx 디컴파일)
- `com/tanchjim/android/device/typec/luna/LUNACommand.java` — 명령/응답 정의
- `com/tanchjim/lib_device_connect/provider/UsbConnectProvider.java` — USB 전송 계층
- `com/tanchjim/android/device/DeviceCommunicateHelper.java` — 송수신 흐름
- `assets/tail_volume.json` — 볼륨 레벨 테이블

## 장치

- VID:PID `2fc6:f0f0` (Comtrue), Product 문자열 `TANCHJIM-LUNA AT`
  - 앱은 PID가 아니라 **제품명 문자열**로 기종을 구분 (`LUNA`, `LUNA AT` 모두 같은 LUNACommand 사용)
- IF0 Audio Control (UAC2, Feature Unit: Mute/Volume만), IF1 Audio Streaming, IF2 HID (EP5 OUT / EP6 IN, 8B)

## 전송 계층 (Android 기준)

Android 앱은 HID 인터페이스(IF2)를 `claimInterface`만 하고, 실제 데이터는 **EP0 벤더 컨트롤 전송**으로 보냄
(`length <= 8`이면 control, 그보다 크면 bulk/interrupt 엔드포인트 — LUNA 명령은 항상 7바이트라 control만 사용).

| 방향 | bmRequestType | bRequest | wValue | wIndex | 길이 |
|---|---|---|---|---|---|
| 쓰기 (명령) | `0x43` (H→D, Vendor, Recipient=Other) | `0xA0` | `0x0000` | `0x09A0` | 7 |
| 읽기 (응답) | `0xC3` (D→H, Vendor, Recipient=Other) | `0xA1` | `0x0000` | `0x09A0` | 8 (EP IN maxPacket) |

- 명령 하나 보낼 때마다 쓰기 → 곧바로 읽기 (timeout 5000ms)
- 명령 간 간격 `UNIFIED_DELAY_TIME = 400ms`

> ⚠ 이 경로는 WebHID로 불가능. Windows 앱이 HID(Output report)로 같은 페이로드를 보내는지 확인 필요.

## 명령 포맷

7바이트: `C1 A5 <cmd> <p1> <p2> <p3> <p4>`

### 쓰기 명령

| cmd | 기능 | 파라미터 |
|---|---|---|
| `01` | 필터 | p1: `00` 저지연, `01` Fast-Steep(快速陡峭), `02` Slow-Rolloff(缓慢下降), `03` Slow-Steep, `04` NOS |
| `02` | 게인 | p1: `00` Low, `01` High |
| `04` | 볼륨 | p1: 감쇠량, 0.5dB 단위 (`00`=0dB … `FF`=-127.5dB). 앱은 61단계 테이블 사용(아래) |
| `05` | 좌우 밸런스 | p1 = R 감쇠, p2 = L 감쇠 (0.5dB 단위, `abs(value*2)`). 한쪽만 0이 아님 |
| `06` | LED | p1: `00` 켜기, `02` 끄기 |
| `07` | 하드웨어 DEPOP | p1: `01` on / `00` off (앱 UI에서 호출되지 않음) |
| `08` | DAC 출력 모드 | p1: `00` Class AB, `01` Class H |
| `09` | DRE | p1: `00` 켜기, `01` 끄기 (펌웨어 ≥ 7에서만) |

### 읽기 명령

| 명령 | 응답 | 응답 해석 (공백 split 인덱스) |
|---|---|---|
| `C1 A5 A0 00 00 00 00` | `A1 A5 A0 ..` | [3] 펌웨어 버전 (hex) |
| `C1 A5 A1 00 00 00 00` | `A1 A5 A1 ..` | [3] 샘플레이트 (아래 표) |
| `C1 A5 A2 00 00 00 00` | `A1 A5 A2 ..` | [4] 볼륨, [5] L 밸런스, [6] R 밸런스 |
| `C1 A5 A3 00 00 00 00` | `A1 A5 A3 ..` | [3] 필터, [4] 게인, [5] LED |
| `C1 A5 A4 00 00 00 00` | `A1 A5 A4 ..` | [3] DAC 모드, [4] DRE (`00`=on) |

- 쓰기 명령 응답: `A1 A5 04 <vol>` (볼륨 확인), `A1 A5 05 ...` (밸런스 확인; [4], [5] 사용)
- 응답이 `C1`로 시작하면(에코) 실패로 보고 앱이 나중에 재전송함
- 밸런스 해석: `f = -[R]/2`, `[R]==0`이면 `f = [L]/2` (dB). 인덱스가 명령과 응답에서 서로 다르니 실기기 검증 필요

### 샘플레이트 코드 (`A1 A5 A1` [3])

`00` 재생 안 함 · `10` 44.1k · `11` 48k · `12` 88.2k · `13` 96k · `14` 176.4k · `15` 192k · `16` 352.8k · `17` 384k · `18` 705.6k · `19` 768k
`20`~`23` DoP64/128/256/512 · `40`~`43` Native DSD64/128/256/512

### 볼륨 테이블 (`tail_volume.json`, level:byte)

```
0:FF 1:DC 2:C8 3:BE 4:B6 5:AE 6:A6 7:9E 8:96 9:90 10:8A 11:84 12:7E 13:78 14:72 15:6E
16:6C 17:6A 18:68 19:66 20:64 21:63 22:62 23:61 24:60 25:5F 26:5E 27:5D 28:5C 29:5B 30:5A
31:59 32:58 33:57 34:56 35:55 36:54 37:53 38:52 39:51 40:50 41:4E 42:4C 43:4A 44:48 45:46
46:44 47:40 48:3C 49:38 50:34 51:30 52:2C 53:28 54:24 55:1E 56:18 57:12 58:0C 59:06 60:00
```

## 앱 초기화 순서 (`getBaseInfo`)

400ms 간격으로 `A0`(펌웨어) → `A2`(볼륨) → `A1`(샘플레이트) → `A3`(필터/게인/LED) → `A4`(DAC/DRE)

## Windows 앱 (TanchjimSoftware.exe v1.0.2.3, Qt5 x64)

추출 방법: innoextract(1.10-dev 포함)는 6.4.3 헤더 파싱 실패 → 설치 파일 오프셋 `827392`의 `zlb\x1a` 뒤
LZMA2 solid 청크를 Python `lzma`로 직접 해제 → MZ 헤더 기준으로 PE 분할 → Inno의 E8/E9 call 주소 변환 역적용.
(분석용 스크립트는 저장소에 포함하지 않음)

- Luna 제어는 **libusb-win32 (`libusb0.dll` + `libusb0.sys` 필터 드라이버)** 의 `usb_control_msg` 사용 — Android와 동일한 전송
  - 쓰기: `usb_control_msg(h, 0x43, 0xA0, 0, 0x09A0, buf, 7, timeout)` (0x14005bc10)
  - `Sleep(50)`
  - 읽기: `usb_control_msg(h, 0xC3, 0xA1, 0, 0x09A0, buf, 7, 2000)` (0x14005bc57) — 읽기 길이 7
  - `usb_control_msg` 호출 지점 17곳, 모두 같은 패턴
- 지원 VID:PID 등록 (0x1400738a5~): `2fc6:f070`, `2fc6:f072`, `2fc6:f0f0`(Luna AT), `0666:0888` 외
- `hidapi`(`hid_write`/`hid_read_timeout`, 64B/513B 리포트)는 VID `0x0666` 계열 등 다른 제품용. Luna는 HID 경로를 쓰지 않음
- 설치 시 libusb0 필터 드라이버를 붙이고 `CM_Disable/Enable_DevNode`로 장치를 재시작함 (`TANCHJIM DRIVER_setup_WHQL.exe` 동봉)

## 웹 구현 관점 결론

- 공식 앱 두 개 모두 **EP0 벤더 컨트롤 전송**만 사용 → WebHID로 같은 방식은 불가
- HID Output 리포트(7B)는 펌웨어가 받아줄 가능성만 남아 있음 (앱은 미사용) → 읽기 명령(`C1 A5 A0`)으로 실험 필요
- WebUSB: Linux/macOS/Android Chrome에서 recipient=Other 컨트롤 전송이 허용되는지 실험 필요. Windows는 WinUSB 드라이버가 필요해서 사실상 불가

## 실기기 실험 결과 (2026-11-02, Linux, 펌웨어 7)

Python 표준 라이브러리로 usbfs `USBDEVFS_CONTROL` ioctl과 hidraw를 직접 호출해 확인 (읽기 명령만 사용)

1. **usbfs 벤더 컨트롤 전송**: 정상 동작. 커널 드라이버(snd-usb-audio, usbhid) 분리 없이 EP0 사용 가능
   ```
   C1 A5 A0 → A1 A5 A0 07 00 00 00 ..   펌웨어 7
   C1 A5 A1 → A1 A5 A1 13 00 00 00 ..   PCM 96k
   C1 A5 A2 → A1 A5 A2 00 5D 00 00 ..   볼륨 0x5D(-46.5dB), 밸런스 0/0
   C1 A5 A3 → A1 A5 A3 01 01 02 00 ..   Fast-Steep / High gain / LED off
   C1 A5 A4 → A1 A5 A4 00 01 00 00 ..   Class AB / DRE off
   ```
   - 응답은 장치 내부의 "마지막 응답" 버퍼: 다시 읽어도 같은 값이 나옴
   - 8번째 바이트는 0x00이 아닐 때도 있음 (`AC`, `E8`, `91` …) — 의미 미상, 무시해도 됨
2. **HID Output 리포트(Report ID 없이 7B)로도 명령이 처리됨** (HID로 `A3`만 보낸 뒤 벤더 채널로 `A3` 응답 확인)
3. 응답은 HID **interrupt IN으로는 오지 않음**
4. HID **GET_REPORT(Input·Feature 둘 다)** 로 응답 읽기 가능: `00 A1 A5 A1 13 00 00 00 91` (앞의 `00`은 Report ID)
   - 단, 디스크립터에 Feature 리포트가 없으므로 WebHID `receiveFeatureReport`가 막힐 수 있음 → 브라우저 테스트(`test.html`)로 확인

## 브라우저 실험 결과 (Chromium 156, Linux)

| 경로 | 쓰기 | 읽기 |
|---|---|---|
| WebHID `sendReport(0, 7B)` | ✅ | — |
| WebHID `receiveFeatureReport(0)` | — | ❌ `NotAllowedError` (디스크립터에 Feature 리포트 없음) |
| WebHID `inputreport` | — | ❌ 응답이 오지 않음 |
| WebUSB `controlTransferOut/In` (vendor, recipient `other`, 0xA0/0xA1, index 0x09A0) | ✅ | ✅ |

→ **WebUSB: 읽기/쓰기 모두 가능** (Linux 확인, macOS·ChromeOS·Android Chrome도 가능할 것으로 예상)
→ **WebHID: 쓰기만 가능** — Windows용 대체 경로 (Windows 실기기 미확인)

## 미확인 / TODO

- [ ] Windows에서 WebHID `sendReport`로 설정 변경이 되는지 (Consumer Control 컬렉션)

- [x] Windows 앱 분석: HID 미사용, libusb0 control 전송 확인
- [ ] Linux usbfs로 control 전송 재현 (커널 드라이버 분리 없이 EP0 사용 가능)
- [ ] hidraw로 7바이트 Output 리포트 `C1 A5 A0 ..` 보내서 Input 리포트로 응답 오는지 실험
- [ ] Chrome WebUSB로 `controlTransferOut({requestType:'vendor', recipient:'other', request:0xA0, value:0, index:0x09A0})` 가능 여부
