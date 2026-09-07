/*
 * trAIMer — Windows native mouse capture helper.
 *
 * Reads PHYSICAL raw mouse deltas via the documented Win32 Raw Input API
 * (RegisterRawInputDevices / WM_INPUT / GetRawInputData) and streams them as
 * versioned JSON frames to a single local client over a minimal loopback
 * WebSocket (RFC 6455, 127.0.0.1 only).
 *
 * STRICT SAFETY BOUNDARY — this program:
 *   - does NOT inject into any process, including games,
 *   - does NOT read or write any other process's memory,
 *   - does NOT hook or synthesize input for other applications,
 *   - does NOT modify game files or interact with anti-cheat software,
 *   - does NOT send input anywhere; it only OBSERVES physical mouse events
 *     destined for the desktop (RIDEV_INPUTSINK), like any accessibility or
 *     input-statistics tool would,
 *   - binds ONLY to loopback and serves exactly ONE authenticated local
 *     client at a time; there is no network exposure, no cloud, no telemetry.
 *
 * Wire protocol (see docs/NATIVE-CAPTURE.md):
 *   client → helper : {"type":"hello","protocolVersion":1,"sessionToken":"...","appVersion":"..."}
 *   helper → client : {"type":"welcome","protocolVersion":1,"sourceKind":"native",
 *                      "deviceId":"...","deviceDescription":"...",
 *                      "nominalRateHz":N,"timeOriginNote":"...","helperVersion":"1.0.0"}
 *                   | {"type":"reject","reason":"..."}
 *   helper → client : {"type":"frame","sequence":Q,"tMonotonicMs":T,
 *                      "events":[{"kind":"pointer-sample"|"button", ...}]}
 *                   | {"type":"lifecycle","phase":"started"|"stopping"|"reconnecting","detail":"..."}
 *                   | {"type":"ping"}          (client answers "pong")
 *
 * Frames preserve RAW mouse counts (no interpolation, no smoothing, no
 * fabricated samples). Timestamps are high-resolution monotonic milliseconds
 * from helper start via QueryPerformanceCounter.
 *
 * Build (see native/windows/BUILD.md): cl /O2 /W4 traimer_capture_helper.c
 *   or: gcc -O2 -o traimer_capture_helper.exe traimer_capture_helper.c -lws2_32
 */

#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <hidusage.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

#define HELPER_VERSION            "helper-1.0.0"

/* Reported by --version so the release pipeline can assert the shipped
   binary really is the 64-bit build (constant folded, not a runtime test:
   MSVC /W4 /WX rejects constant conditional expressions). */
#if defined(_WIN64) || defined(_M_X64) || defined(__x86_64__)
#define HELPER_ARCH               "x64"
#else
#define HELPER_ARCH               "x86"
#endif
#define PROTOCOL_VERSION          1
#define DEFAULT_PORT              48765
#define MAX_TOKEN_LEN             128
#define WS_RX_BUF_SIZE            8192
#define WS_TX_BUF_SIZE            4096

/* ------------------------------------------------------------------ */
/* Small bounded string copy                                           */
/* ------------------------------------------------------------------ */

/*
 * Always-NUL-terminating bounded copy.
 *
 * Used instead of strncpy, which MSVC reports as C4996 ("may be unsafe") and
 * which /WX turns into an error. Silencing the warning with
 * _CRT_SECURE_NO_WARNINGS would hide the whole deprecation class, so the
 * copy is written out instead.
 */
static void copy_bounded(char *dst, size_t dstSize, const char *src)
{
    size_t i = 0;
    if (dst == NULL || dstSize == 0) return;
    if (src != NULL) {
        for (; i + 1 < dstSize && src[i] != '\0'; i++) dst[i] = src[i];
    }
    dst[i] = '\0';
}

/* ------------------------------------------------------------------ */
/* Monotonic high-resolution clock                                     */
/* ------------------------------------------------------------------ */

static LARGE_INTEGER g_qpcFrequency;
static LARGE_INTEGER g_qpcStart;
static double g_firstEventMs = -1.0;

static double qpc_to_ms(LARGE_INTEGER v)
{
    return (double)(v.QuadPart - g_qpcStart.QuadPart) * 1000.0 /
           (double)g_qpcFrequency.QuadPart;
}

/* ------------------------------------------------------------------ */
/* Device registry (raw device handle → name/id)                       */
/* ------------------------------------------------------------------ */

#define MAX_TRACKED_DEVICES 16

typedef struct {
    HANDLE  handle;
    wchar_t name[256];
    char    id[64];
    int     known;
} TrackedDevice;

static TrackedDevice g_devices[MAX_TRACKED_DEVICES];
static int g_deviceCount = 0;

static const char *device_id_for(HANDLE hDevice)
{
    for (int i = 0; i < g_deviceCount; i++) {
        if (g_devices[i].handle == hDevice) return g_devices[i].id;
    }
    if (g_deviceCount >= MAX_TRACKED_DEVICES) return "device-many";
    TrackedDevice *d = &g_devices[g_deviceCount++];
    d->handle = hDevice;
    d->known = 0;
    UINT size = (UINT)sizeof(d->name);
    if (GetRawInputDeviceInfoW(hDevice, RIDI_DEVICENAME, d->name, &size) ==
        (UINT)-1) {
        lstrcpynW(d->name, L"(unavailable)", 256);
    }
    /* Stable short id: hash of the interface path. */
    unsigned long h = 2166136261ul;
    for (wchar_t *p = d->name; *p; p++) {
        h ^= (unsigned long)(*p & 0xFF);
        h *= 16777619ul;
        h ^= (unsigned long)((*p >> 8) & 0xFF);
        h *= 16777619ul;
    }
    snprintf(d->id, sizeof(d->id), "mouse-%08lx", h);
    if (g_deviceCount == 1) {
        /* First-seen device becomes the primary id used in `welcome`. */
    }
    return d->id;
}

static const wchar_t *primary_device_name(void)
{
    if (g_deviceCount > 0) return g_devices[g_deviceCount - 1].name;
    return L"(none yet)";
}

/* ------------------------------------------------------------------ */
/* Minimal JSON writer                                                 */
/* ------------------------------------------------------------------ */

typedef struct {
    char buf[WS_TX_BUF_SIZE];
    int  len;
} JsonBuf;

static void jb_reset(JsonBuf *b) { b->len = 0; b->buf[0] = '\0'; }

static void jb_raw(JsonBuf *b, const char *s)
{
    while (*s && b->len < (int)sizeof(b->buf) - 1) b->buf[b->len++] = *s++;
    b->buf[b->len] = '\0';
}

static void jb_int(JsonBuf *b, long long v)
{
    char tmp[32];
    _snprintf_s(tmp, sizeof(tmp), _TRUNCATE, "%lld", v);
    jb_raw(b, tmp);
}

static void jb_double(JsonBuf *b, double v)
{
    char tmp[48];
    _snprintf_s(tmp, sizeof(tmp), _TRUNCATE, "%.3f", v);
    jb_raw(b, tmp);
}

static void jb_string(JsonBuf *b, const char *s)
{
    jb_raw(b, "\"");
    for (const char *p = s; *p && b->len < (int)sizeof(b->buf) - 3; p++) {
        if (*p == '"' || *p == '\\') {
            char esc[3] = { '\\', *p, '\0' };
            jb_raw(b, esc);
        } else if ((unsigned char)*p < 0x20) {
            char esc[8];
            _snprintf_s(esc, sizeof(esc), _TRUNCATE, "\\u%04x", *p);
            jb_raw(b, esc);
        } else {
            char one[2] = { *p, '\0' };
            jb_raw(b, one);
        }
    }
    jb_raw(b, "\"");
}

static void send_text(SOCKET sock, const char *data);

static void jb_send(JsonBuf *b, SOCKET sock)
{
    send_text(sock, b->buf);
}

/* ------------------------------------------------------------------ */
/* WebSocket server (loopback only)                                    */
/* ------------------------------------------------------------------ */

static SOCKET g_listenSocket = INVALID_SOCKET;
static SOCKET g_clientSocket = INVALID_SOCKET;
static char   g_expectedToken[MAX_TOKEN_LEN] = { 0 };
static volatile LONG g_clientAccepted = 0;

/*
 * Shutdown flag and parent-process watchdog.
 *
 * The desktop shell that spawns this helper stops it explicitly when the app
 * quits. The watchdog covers the case the shell CANNOT cover: if the shell is
 * killed hard (Task Manager "End task", a crash, a power-management kill), a
 * helper left running would hold the loopback port and shadow the next
 * launch. Waiting on the parent's process handle makes an orphaned helper
 * impossible, and gives the accept loop a real exit — without one, the
 * WSACleanup() at the end of main() was literally unreachable (MSVC C4702).
 */
static volatile LONG g_shuttingDown = 0;

static int shutting_down(void)
{
    return InterlockedCompareExchange(&g_shuttingDown, 0, 0) != 0;
}

static int ws_send_all(SOCKET sock, const char *data, int len)
{
    int sent = 0;
    while (sent < len) {
        int n = send(sock, data + sent, len - sent, 0);
        if (n <= 0) return 0;
        sent += n;
    }
    return 1;
}

/* Server→client text frame: FIN|opcode=0x81, no mask. */
static void send_text(SOCKET sock, const char *data)
{
    if (sock == INVALID_SOCKET || !g_clientAccepted) return;
    size_t len = strlen(data);
    unsigned char header[10];
    int hdrLen = 0;
    header[hdrLen++] = 0x81;
    if (len < 126) {
        header[hdrLen++] = (unsigned char)len;
    } else if (len < 65536) {
        header[hdrLen++] = 126;
        header[hdrLen++] = (unsigned char)((len >> 8) & 0xFF);
        header[hdrLen++] = (unsigned char)(len & 0xFF);
    } else {
        /* Our messages never exceed 64 KiB. */
        return;
    }
    if (!ws_send_all(sock, (const char *)header, hdrLen)) return;
    ws_send_all(sock, data, (int)len);
}

/* SHA-1 (public-domain style compact implementation). */
typedef struct {
    uint32_t state[5];
    uint64_t bitlen;
    unsigned char data[64];
    size_t datalen;
} Sha1;

static uint32_t rol32(uint32_t v, int n) { return (v << n) | (v >> (32 - n)); }

static void sha1_transform(Sha1 *s, const unsigned char block[64])
{
    uint32_t w[80];
    for (int i = 0; i < 16; i++) {
        w[i] = ((uint32_t)block[i * 4] << 24) |
               ((uint32_t)block[i * 4 + 1] << 16) |
               ((uint32_t)block[i * 4 + 2] << 8) |
                (uint32_t)block[i * 4 + 3];
    }
    for (int i = 16; i < 80; i++) {
        w[i] = rol32(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    }
    uint32_t a = s->state[0], b = s->state[1], c = s->state[2],
             d = s->state[3], e = s->state[4];
    for (int i = 0; i < 80; i++) {
        uint32_t f, k;
        if (i < 20)      { f = (b & c) | ((~b) & d);          k = 0x5A827999; }
        else if (i < 40) { f = b ^ c ^ d;                     k = 0x6ED9EBA1; }
        else if (i < 60) { f = (b & c) | (b & d) | (c & d);   k = 0x8F1BBCDC; }
        else             { f = b ^ c ^ d;                     k = 0xCA62C1D6; }
        uint32_t t = rol32(a, 5) + f + e + k + w[i];
        e = d; d = c; c = rol32(b, 30); b = a; a = t;
    }
    s->state[0] += a; s->state[1] += b; s->state[2] += c;
    s->state[3] += d; s->state[4] += e;
}

static void sha1_init(Sha1 *s)
{
    s->datalen = 0;
    s->bitlen = 0;
    s->state[0] = 0x67452301;
    s->state[1] = 0xEFCDAB89;
    s->state[2] = 0x98BADCFE;
    s->state[3] = 0x10325476;
    s->state[4] = 0xC3D2E1F0;
}

static void sha1_update(Sha1 *s, const unsigned char *data, size_t len)
{
    for (size_t i = 0; i < len; i++) {
        s->data[s->datalen++] = data[i];
        s->bitlen += 8;
        if (s->datalen == 64) {
            sha1_transform(s, s->data);
            s->datalen = 0;
        }
    }
}

static void sha1_final(Sha1 *s, unsigned char out[20])
{
    size_t i = s->datalen;
    if (i < 56) {
        s->data[i++] = 0x80;
        while (i < 56) s->data[i++] = 0x00;
    } else {
        s->data[i++] = 0x80;
        while (i < 64) s->data[i++] = 0x00;
        sha1_transform(s, s->data);
        memset(s->data, 0, 56);
    }
    uint64_t bits = s->bitlen;
    for (int j = 7; j >= 0; j--) s->data[56 + (7 - j)] = (unsigned char)((bits >> (j * 8)) & 0xFF);
    sha1_transform(s, s->data);
    for (int j = 0; j < 5; j++) {
        out[j * 4]     = (unsigned char)((s->state[j] >> 24) & 0xFF);
        out[j * 4 + 1] = (unsigned char)((s->state[j] >> 16) & 0xFF);
        out[j * 4 + 2] = (unsigned char)((s->state[j] >> 8) & 0xFF);
        out[j * 4 + 3] = (unsigned char)(s->state[j] & 0xFF);
    }
}

static void base64(const unsigned char *in, size_t len, char *out)
{
    static const char tbl[] =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    size_t o = 0;
    for (size_t i = 0; i + 2 < len; i += 3) {
        uint32_t v = (in[i] << 16) | (in[i + 1] << 8) | in[i + 2];
        out[o++] = tbl[(v >> 18) & 63];
        out[o++] = tbl[(v >> 12) & 63];
        out[o++] = tbl[(v >> 6) & 63];
        out[o++] = tbl[v & 63];
    }
    size_t rem = len % 3;
    if (rem == 1) {
        uint32_t v = (in[len - 1] << 16);
        out[o++] = tbl[(v >> 18) & 63];
        out[o++] = tbl[(v >> 12) & 63];
        out[o++] = '=';
        out[o++] = '=';
    } else if (rem == 2) {
        uint32_t v = (in[len - 2] << 16) | (in[len - 1] << 8);
        out[o++] = tbl[(v >> 18) & 63];
        out[o++] = tbl[(v >> 12) & 63];
        out[o++] = tbl[(v >> 6) & 63];
        out[o++] = '=';
    }
    out[o] = '\0';
}

/* Case-insensitive substring find. */
static const char *ci_strstr(const char *hay, const char *needle)
{
    size_t nlen = strlen(needle);
    for (; *hay; hay++) {
        size_t i = 0;
        while (i < nlen && hay[i] &&
               tolower((unsigned char)hay[i]) == tolower((unsigned char)needle[i])) i++;
        if (i == nlen) return hay;
    }
    return NULL;
}

/* Performs RFC 6455 handshake on an accepted TCP socket.
   Returns 1 on success, 0 on failure (socket closed either way). */
static int ws_handshake(SOCKET sock)
{
    char req[4096];
    int total = 0;
    /* Read until end of HTTP headers. */
    while (total < (int)sizeof(req) - 1) {
        int n = recv(sock, req + total, (int)sizeof(req) - 1 - total, 0);
        if (n <= 0) return 0;
        total += n;
        req[total] = '\0';
        if (strstr(req, "\r\n\r\n")) break;
    }
    req[total] = '\0';

    if (!ci_strstr(req, "upgrade: websocket")) return 0;
    const char *keyHdr = ci_strstr(req, "sec-websocket-key:");
    if (!keyHdr) return 0;
    keyHdr += strlen("sec-websocket-key:");
    while (*keyHdr == ' ') keyHdr++;
    char key[128];
    size_t k = 0;
    while (keyHdr[k] && keyHdr[k] != '\r' && keyHdr[k] != '\n' &&
           k < sizeof(key) - 1) {
        key[k] = keyHdr[k];
        k++;
    }
    key[k] = '\0';
    /* Trim trailing spaces. */
    while (k > 0 && key[k - 1] == ' ') key[--k] = '\0';

    char acceptInput[256];
    snprintf(acceptInput, sizeof(acceptInput),
             "%s258EAFA5-E914-47DA-95CA-C5AB0DC85B11", key);
    Sha1 sha;
    sha1_init(&sha);
    sha1_update(&sha, (const unsigned char *)acceptInput, strlen(acceptInput));
    unsigned char digest[20];
    sha1_final(&sha, digest);
    char accept[64];
    base64(digest, 20, accept);

    char response[256];
    snprintf(response, sizeof(response),
             "HTTP/1.1 101 Switching Protocols\r\n"
             "Upgrade: websocket\r\n"
             "Connection: Upgrade\r\n"
             "Sec-WebSocket-Accept: %s\r\n\r\n",
             accept);
    return ws_send_all(sock, response, (int)strlen(response));
}

/* Parses one masked client text frame from the wire buffer.
   Returns payload length (>=0) and advances *offset past the frame, or -1. */
static int ws_parse_client_frame(const unsigned char *buf, size_t bufLen,
                                 size_t *offset, char *outPayload,
                                 size_t outCap, unsigned char *outOpcode)
{
    if (*offset + 2 > bufLen) return -1;
    const unsigned char *p = buf + *offset;
    unsigned char opcode = p[0] & 0x0F;
    int masked = (p[1] & 0x80) != 0;
    uint64_t len = p[1] & 0x7F;
    size_t pos = 2;
    if (len == 126) {
        if (*offset + 4 > bufLen) return -1;
        len = ((uint64_t)p[2] << 8) | p[3];
        pos += 2;
    } else if (len == 127) {
        return -1; /* we never receive such huge frames */
    }
    unsigned char mask[4] = { 0, 0, 0, 0 };
    if (masked) {
        if (*offset + pos + 4 > bufLen) return -1;
        memcpy(mask, p + pos, 4);
        pos += 4;
    }
    if (*offset + pos + len > bufLen) return -1;
    if (len + 1 > outCap) return -1;
    for (uint64_t i = 0; i < len; i++) {
        outPayload[i] = (char)(p[pos + i] ^ mask[i % 4]);
    }
    outPayload[len] = '\0';
    *offset += pos + (size_t)len;
    *outOpcode = opcode;
    return (int)len;
}

/* ------------------------------------------------------------------ */
/* Raw input handling                                                  */
/* ------------------------------------------------------------------ */

static long long g_sequenceCounter = 0;
static double g_lastEventMs = -1.0;
static long long g_eventsSent = 0;

/* Emits one frame per raw event. Sequence numbers are continuous per
   connection epoch; the client resets continuity on each welcome. */
static void emit_frame_header(JsonBuf *b)
{
    jb_reset(b);
    jb_raw(b, "{\"type\":\"frame\",\"sequence\":");
    jb_int(b, g_sequenceCounter++);
    jb_raw(b, ",\"tMonotonicMs\":");
    LARGE_INTEGER now;
    QueryPerformanceCounter(&now);
    double ms = qpc_to_ms(now);
    if (g_firstEventMs < 0) g_firstEventMs = ms;
    jb_double(b, ms);
    g_lastEventMs = ms;
    jb_raw(b, ",\"events\":[");
}

static void emit_pointer_sample(JsonBuf *b, SOCKET sock, double tMs,
                                long dx, long dy)
{
    emit_frame_header(b);
    jb_raw(b, "{\"kind\":\"pointer-sample\",\"tMs\":");
    jb_double(b, tMs);
    jb_raw(b, ",\"dx\":");
    jb_int(b, dx);
    jb_raw(b, ",\"dy\":");
    jb_int(b, dy);
    jb_raw(b, "}]}");
    jb_send(b, sock);
    g_eventsSent++;
}

static void emit_button(JsonBuf *b, SOCKET sock, double tMs, int press)
{
    emit_frame_header(b);
    jb_raw(b, "{\"kind\":\"button\",\"tMs\":");
    jb_double(b, tMs);
    jb_raw(b, ",\"action\":");
    jb_raw(b, press ? "\"press\"" : "\"release\"");
    jb_raw(b, "}]}");
    jb_send(b, sock);
    g_eventsSent++;
}

static void emit_lifecycle(SOCKET sock, const char *phase, const char *detail)
{
    JsonBuf b;
    jb_reset(&b);
    jb_raw(&b, "{\"type\":\"lifecycle\",\"phase\":");
    jb_string(&b, phase);
    jb_raw(&b, ",\"detail\":");
    jb_string(&b, detail);
    jb_raw(&b, "}");
    jb_send(&b, sock);
}

static void handle_wm_input(HRAWINPUT hRawInput, SOCKET sock)
{
    UINT size = 0;
    GetRawInputData(hRawInput, RID_INPUT, NULL, &size, sizeof(RAWINPUTHEADER));
    if (size == 0 || size > 1024) return;
    BYTE buffer[1024];
    if (GetRawInputData(hRawInput, RID_INPUT, buffer, &size,
                        sizeof(RAWINPUTHEADER)) == (UINT)-1) {
        return;
    }
    RAWINPUT *raw = (RAWINPUT *)buffer;
    if (raw->header.dwType != RIM_TYPEMOUSE) return;

    const RAWMOUSE *rm = &raw->data.mouse;
    LARGE_INTEGER now;
    QueryPerformanceCounter(&now);
    double tMs = qpc_to_ms(now);
    if (g_firstEventMs < 0) g_firstEventMs = tMs;

    device_id_for(raw->header.hDevice);

    /* Movement: relative counts only. Absolute devices (rare mice in absolute
       mode) are skipped rather than misreported. */
    if (!(rm->usFlags & MOUSE_MOVE_ABSOLUTE)) {
        long dx = rm->lLastX;
        long dy = rm->lLastY;
        if (dx != 0 || dy != 0) {
            JsonBuf frame;
            emit_pointer_sample(&frame, sock, tMs, dx, dy);
        }
    }

    USHORT f = rm->usButtonFlags;
    if (f & RI_MOUSE_BUTTON_1_DOWN) {
        JsonBuf frame;
        emit_button(&frame, sock, tMs, 1);
    }
    if (f & RI_MOUSE_BUTTON_1_UP) {
        JsonBuf frame;
        emit_button(&frame, sock, tMs, 0);
    }
    if (f & RI_MOUSE_RIGHT_BUTTON_DOWN) {
        JsonBuf frame;
        emit_button(&frame, sock, tMs, 1);
    }
    if (f & RI_MOUSE_RIGHT_BUTTON_UP) {
        JsonBuf frame;
        emit_button(&frame, sock, tMs, 0);
    }
    if (f & RI_MOUSE_MIDDLE_BUTTON_DOWN) {
        JsonBuf frame;
        emit_button(&frame, sock, tMs, 1);
    }
    if (f & RI_MOUSE_MIDDLE_BUTTON_UP) {
        JsonBuf frame;
        emit_button(&frame, sock, tMs, 0);
    }
}

/* ------------------------------------------------------------------ */
/* Hello / welcome                                                     */
/* ------------------------------------------------------------------ */

static void send_welcome(SOCKET sock)
{
    JsonBuf b;
    jb_reset(&b);
    jb_raw(&b, "{\"type\":\"welcome\",\"protocolVersion\":");
    jb_int(&b, PROTOCOL_VERSION);
    jb_raw(&b, ",\"sourceKind\":\"native\",\"deviceId\":");
    jb_string(&b, g_deviceCount > 0 ? g_devices[g_deviceCount - 1].id : "mouse-pending");
    jb_raw(&b, ",\"deviceDescription\":");
    char desc[512];
    const wchar_t *wname = primary_device_name();
    WideCharToMultiByte(CP_UTF8, 0, wname, -1, desc, (int)sizeof(desc), NULL, NULL);
    jb_string(&b, desc);
    jb_raw(&b, ",\"nominalRateHz\":1000,\"timeOriginNote\":\"monotonic ms from helper process start (QueryPerformanceCounter)\",\"helperVersion\":");
    jb_string(&b, HELPER_VERSION);
    jb_raw(&b, "}");
    jb_send(&b, sock);
}

static void send_reject(SOCKET sock, const char *reason)
{
    JsonBuf b;
    jb_reset(&b);
    jb_raw(&b, "{\"type\":\"reject\",\"reason\":");
    jb_string(&b, reason);
    jb_raw(&b, "}");
    jb_send(&b, sock);
}

/* Extracts a top-level string field from a flat JSON object (sufficient for
   hello messages). Returns 0 when absent. */
static int json_find_string(const char *json, const char *field,
                            char *out, size_t cap)
{
    char pattern[64];
    snprintf(pattern, sizeof(pattern), "\"%s\"", field);
    const char *hit = strstr(json, pattern);
    if (!hit) return 0;
    hit += strlen(pattern);
    while (*hit == ' ' || *hit == ':') hit++;
    if (*hit != '"') return 0;
    hit++;
    size_t o = 0;
    while (*hit && *hit != '"' && o + 1 < cap) out[o++] = *hit++;
    out[o] = '\0';
    return 1;
}

/* ------------------------------------------------------------------ */
/* Main loop                                                           */
/* ------------------------------------------------------------------ */

static void print_usage(void)
{
    printf("traimer_capture_helper [--port N] [--token TOKEN]\n");
    printf("                    [--parent-pid PID] [--version]\n");
    printf("  Local-only Raw Input mouse telemetry for trAIMer.\n");
    printf("  Binds 127.0.0.1 exclusively; serves one authenticated client.\n");
}

/*
 * --version: prove-it-runs probe.
 *
 * The Windows release pipeline executes the freshly compiled binary with this
 * flag and requires exit code 0 plus this exact machine-readable line. That is
 * how CI proves the shipped file is a real, runnable Windows x64 PE and not,
 * say, a source file that was copied over the .exe name (the rc.1 defect).
 * It registers no devices, opens no sockets, and creates no windows.
 */
static void print_version(void)
{
    printf("traimer_capture_helper version=%s protocol=%d arch=%s\n",
           HELPER_VERSION, PROTOCOL_VERSION, HELPER_ARCH);
}

/* Waits for the launching process to exit, then unblocks accept(). */
static DWORD WINAPI parent_watch_thread(LPVOID param)
{
    HANDLE parent = (HANDLE)param;
    WaitForSingleObject(parent, INFINITE);
    InterlockedExchange(&g_shuttingDown, 1);
    /* Closing the listener makes the blocking accept() return immediately. */
    SOCKET listener = g_listenSocket;
    if (listener != INVALID_SOCKET) closesocket(listener);
    return 0;
}

int main(int argc, char **argv)
{
    int port = DEFAULT_PORT;
    int haveToken = 0;
    DWORD parentPid = 0;

    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--version")) {
            print_version();
            return 0;
        } else if (!strcmp(argv[i], "--port") && i + 1 < argc) {
            port = atoi(argv[++i]);
        } else if (!strcmp(argv[i], "--token") && i + 1 < argc) {
            copy_bounded(g_expectedToken, sizeof(g_expectedToken), argv[++i]);
            haveToken = 1;
        } else if (!strcmp(argv[i], "--parent-pid") && i + 1 < argc) {
            parentPid = (DWORD)strtoul(argv[++i], NULL, 10);
        } else {
            print_usage();
            return 0;
        }
    }
    if (!haveToken) {
        fprintf(stderr,
                "refusing to run without an explicit --token "
                "(prevents cross-talk between Aim Lab instances)\n");
        return 2;
    }

    WSADATA wsa;
    if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) {
        fprintf(stderr, "WSAStartup failed\n");
        return 1;
    }
    QueryPerformanceFrequency(&g_qpcFrequency);
    QueryPerformanceCounter(&g_qpcStart);

    /* ---- register for raw mouse input on a message-only window ---- */
    WNDCLASSA wc = { 0 };
    wc.lpfnWndProc = DefWindowProcA;
    wc.lpszClassName = "AldoCaptureHelperWnd";
    wc.hInstance = GetModuleHandleA(NULL);
    if (!RegisterClassA(&wc)) {
        fprintf(stderr, "RegisterClass failed\n");
        return 1;
    }
    /* A real (invisible) window is required as the raw-input target so the
       helper never needs focus (RIDEV_INPUTSINK). */
    HWND hwnd = CreateWindowExA(0, "AldoCaptureHelperWnd", "Aldo Capture Helper",
                                0, 0, 0, 0, 0, HWND_MESSAGE, NULL,
                                wc.hInstance, NULL);
    if (!hwnd) {
        fprintf(stderr, "CreateWindow failed\n");
        return 1;
    }

    RAWINPUTDEVICE rid;
    rid.usUsagePage = HID_USAGE_PAGE_GENERIC;
    rid.usUsage = HID_USAGE_GENERIC_MOUSE;
    rid.dwFlags = RIDEV_INPUTSINK | RIDEV_DEVNOTIFY;
    rid.hwndTarget = hwnd;
    if (!RegisterRawInputDevices(&rid, 1, sizeof(RAWINPUTDEVICE))) {
        fprintf(stderr, "RegisterRawInputDevices failed (%lu)\n",
                (unsigned long)GetLastError());
        return 1;
    }
    /* Enumerate currently attached mice so metadata is available immediately. */
    UINT devCount = 0;
    if (GetRawInputDeviceList(NULL, &devCount, sizeof(RAWINPUTDEVICELIST)) ==
            (UINT)-1) {
        devCount = 0;
    }
    if (devCount > 0) {
        RAWINPUTDEVICELIST *list =
            (RAWINPUTDEVICELIST *)malloc(sizeof(RAWINPUTDEVICELIST) * devCount);
        if (list && GetRawInputDeviceList(list, &devCount,
                                          sizeof(RAWINPUTDEVICELIST)) !=
                        (UINT)-1) {
            for (UINT i = 0; i < devCount; i++) {
                if (list[i].dwType == RIM_TYPEMOUSE) {
                    device_id_for((HANDLE)(uintptr_t)list[i].hDevice);
                }
            }
        }
        free(list);
    }

    printf("%s listening on 127.0.0.1:%d\n", HELPER_VERSION, port);
    fflush(stdout);

    /* ---- listen (loopback ONLY) ---- */
    g_listenSocket = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (g_listenSocket == INVALID_SOCKET) {
        fprintf(stderr, "socket() failed\n");
        return 1;
    }
    BOOL reuse = TRUE;
    setsockopt(g_listenSocket, SOL_SOCKET, SO_REUSEADDR, (const char *)&reuse,
               sizeof(reuse));
    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port = htons((u_short)port);
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK); /* 127.0.0.1 only */
    if (bind(g_listenSocket, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
        fprintf(stderr, "bind failed (%d)\n", WSAGetLastError());
        return 1;
    }
    if (listen(g_listenSocket, 1) != 0) {
        fprintf(stderr, "listen failed\n");
        return 1;
    }

    if (parentPid != 0) {
        HANDLE parent = OpenProcess(SYNCHRONIZE, FALSE, parentPid);
        if (parent != NULL) {
            HANDLE watcher = CreateThread(NULL, 0, parent_watch_thread, parent,
                                          0, NULL);
            if (watcher != NULL) {
                CloseHandle(watcher);
            } else {
                CloseHandle(parent);
            }
        }
    }

    while (!shutting_down()) {
        SOCKET client = accept(g_listenSocket, NULL, NULL);
        if (shutting_down()) {
            if (client != INVALID_SOCKET) closesocket(client);
            break;
        }
        if (client == INVALID_SOCKET) continue;

        /* One client at a time. */
        if (InterlockedCompareExchange(&g_clientAccepted, 1, 0) != 0) {
            send_reject(client, "another client is already connected");
            closesocket(client);
            continue;
        }

        if (!ws_handshake(client)) {
            closesocket(client);
            InterlockedExchange(&g_clientAccepted, 0);
            continue;
        }
        g_clientSocket = client;
        g_sequenceCounter = 0;
        g_lastEventMs = -1.0;
        g_firstEventMs = -1.0;
        g_eventsSent = 0;

        /* Wait for a valid hello before streaming anything. */
        char rx[WS_RX_BUF_SIZE];
        int rxLen = 0;
        int handshakedOk = 0;
        for (;;) {
            int n = recv(client, rx + rxLen, (int)sizeof(rx) - 1 - rxLen, 0);
            if (n <= 0) break;
            rxLen += n;
            rx[rxLen] = '\0';

            unsigned char opcode = 0;
            size_t offset = 0;
            char payload[2048];
            int plen = ws_parse_client_frame(
                (const unsigned char *)rx, (size_t)rxLen, &offset, payload,
                sizeof(payload), &opcode);
            if (plen < 0) continue; /* need more bytes */
            if (opcode == 0x8) { /* close */ break; }
            if (opcode == 0x9) { /* ping → pong */ send_text(client, "\x8A\x00"); }

            char type[32] = { 0 }, token[MAX_TOKEN_LEN] = { 0 };
            json_find_string(payload, "type", type, sizeof(type));
            json_find_string(payload, "sessionToken", token, sizeof(token));
            if (!strcmp(type, "hello")) {
                int protocolOk = strstr(payload, "\"protocolVersion\":1") != NULL;
                if (!protocolOk) {
                    send_reject(client, "unsupported protocolVersion");
                    break;
                }
                if (strcmp(token, g_expectedToken) != 0) {
                    send_reject(client,
                                "session token mismatch (cross-talk protection)");
                    break;
                }
                send_welcome(client);
                emit_lifecycle(client, "started", "raw input stream opened");
                handshakedOk = 1;
                break;
            }
            /* Compact remaining bytes. */
            memmove(rx, rx + offset, (size_t)(rxLen - (int)offset));
            rxLen -= (int)offset;
            rx[rxLen] = '\0';
        }

        if (!handshakedOk) {
            closesocket(client);
            g_clientSocket = INVALID_SOCKET;
            InterlockedExchange(&g_clientAccepted, 0);
            continue;
        }

        /* ---- streaming epoch: pump windows messages until disconnect ---- */
        MSG msg;
        while (!shutting_down()) {
            DWORD waitResult = MsgWaitForMultipleObjectsEx(
                0, NULL, 200, QS_ALLINPUT, MWMO_INPUTAVAILABLE);

            /* Check socket liveness cheaply. */
            u_long bytesAvailable = 0;
            if (ioctlsocket(client, FIONREAD, &bytesAvailable) != 0) {
                break; /* disconnected */
            }
            if (bytesAvailable > 0) {
                int n = recv(client, rx + rxLen, (int)sizeof(rx) - 1 - rxLen, 0);
                if (n <= 0) break;
                rxLen += n;
                rx[rxLen] = '\0';
                unsigned char opcode = 0;
                size_t offset = 0;
                char payload[2048];
                int plen = ws_parse_client_frame(
                    (const unsigned char *)rx, (size_t)rxLen, &offset, payload,
                    sizeof(payload), &opcode);
                if (plen >= 0) {
                    if (opcode == 0x8) break; /* close frame */
                    if (opcode == 0x9) send_text(client, "\x8A\x00"); /* pong */
                    memmove(rx, rx + offset, (size_t)(rxLen - (int)offset));
                    rxLen -= (int)offset;
                    rx[rxLen] = '\0';
                } else if (rxLen >= (int)sizeof(rx) - 1) {
                    rxLen = 0; /* overflow guard; drop garbage */
                }
            }
            if (waitResult == WAIT_OBJECT_0) {
                while (PeekMessageA(&msg, hwnd, 0, 0, PM_REMOVE)) {
                    if (msg.message == WM_INPUT) {
                        handle_wm_input((HRAWINPUT)msg.lParam, client);
                    } else if (msg.message == WM_INPUT_DEVICE_CHANGE) {
                        if (msg.wParam == GIDC_ARRIVAL) {
                            emit_lifecycle(client, "reconnecting",
                                           "mouse device attached");
                            device_id_for((HANDLE)msg.lParam);
                        } else if (msg.wParam == GIDC_REMOVAL) {
                            emit_lifecycle(client, "reconnecting",
                                           "mouse device removed");
                        }
                    } else if (msg.message == WM_DESTROY) {
                        PostQuitMessage(0);
                    }
                }
            }
        }

        emit_lifecycle(client, "stopping", "client disconnected");
        closesocket(client);
        g_clientSocket = INVALID_SOCKET;
        InterlockedExchange(&g_clientAccepted, 0);
        printf("client disconnected after %lld frames; awaiting reconnect...\n",
               g_sequenceCounter);
        fflush(stdout);
    }

    if (g_listenSocket != INVALID_SOCKET) {
        closesocket(g_listenSocket);
        g_listenSocket = INVALID_SOCKET;
    }
    WSACleanup();
    return 0;
}
