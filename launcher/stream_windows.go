//go:build windows

// Live lighting: system audio (WASAPI loopback) and screen colour (GDI),
// streamed to the keyboard via iot_driver sendMsg. Runs inside the launcher,
// so it keeps working while the window is minimised; after the window is closed
// the background process takes over (tray_windows.go).
package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

/* ---------- gRPC-web client to iot_driver ---------- */

func pbVarint(b *bytes.Buffer, v uint64) {
	for v >= 0x80 {
		b.WriteByte(byte(v) | 0x80)
		v >>= 7
	}
	b.WriteByte(byte(v))
}
func pbBytes(b *bytes.Buffer, num int, val []byte) {
	pbVarint(b, uint64(num<<3|2))
	pbVarint(b, uint64(len(val)))
	b.Write(val)
}
func pbVar(b *bytes.Buffer, num int, v uint64) {
	pbVarint(b, uint64(num<<3))
	pbVarint(b, v)
}

type pbField struct {
	num int
	v   uint64
	b   []byte
}

func pbDecode(d []byte) []pbField {
	var out []pbField
	i := 0
	rd := func() (uint64, bool) {
		var v uint64
		var s uint
		for i < len(d) {
			c := d[i]
			i++
			v |= uint64(c&0x7f) << s
			s += 7
			if c < 0x80 {
				return v, true
			}
		}
		return 0, false
	}
	for i < len(d) {
		k, ok := rd()
		if !ok {
			break
		}
		f := pbField{num: int(k >> 3)}
		switch k & 7 {
		case 0:
			f.v, _ = rd()
		case 2:
			l, _ := rd()
			if i+int(l) > len(d) {
				return out
			}
			f.b = d[i : i+int(l)]
			i += int(l)
		case 5:
			i += 4
		case 1:
			i += 8
		default:
			return out
		}
		out = append(out, f)
	}
	return out
}

var grpcHTTP = &http.Client{Timeout: 4 * time.Second}

func grpcCall(method string, body []byte) ([]byte, error) {
	fr := make([]byte, 5+len(body))
	binary.BigEndian.PutUint32(fr[1:5], uint32(len(body)))
	copy(fr[5:], body)
	req, _ := http.NewRequest("POST", "http://"+driverAddr+"/driver.DriverGrpc/"+method, bytes.NewReader(fr))
	req.Header.Set("Content-Type", "application/grpc-web+proto")
	req.Header.Set("X-Grpc-Web", "1")
	req.Header.Set("Accept", "application/grpc-web+proto")
	resp, err := grpcHTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	gs := resp.Header.Get("Grpc-Status")
	if gs != "" && gs != "0" {
		return nil, errors.New("grpc " + gs + " " + resp.Header.Get("Grpc-Message"))
	}
	hdr := make([]byte, 5)
	if _, err := io.ReadFull(resp.Body, hdr); err != nil {
		if gs == "0" && err == io.EOF {
			return nil, nil
		}
		return nil, err
	}
	l := binary.BigEndian.Uint32(hdr[1:5])
	data := make([]byte, l)
	if _, err := io.ReadFull(resp.Body, data); err != nil {
		return nil, err
	}
	if hdr[0]&0x80 != 0 { // trailer only: message was empty
		if strings.Contains(string(data), "grpc-status:0") || strings.Contains(string(data), "grpc-status: 0") {
			return nil, nil
		}
		return nil, errors.New(strings.TrimSpace(string(data)))
	}
	return data, nil
}

func drvSend(path string, msg []byte, cs int, dangle int) error {
	m := make([]byte, 64)
	copy(m, msg)
	var b bytes.Buffer
	pbBytes(&b, 1, []byte(path))
	pbBytes(&b, 2, m)
	pbVar(&b, 3, uint64(cs))
	pbVar(&b, 4, uint64(dangle))
	r, err := grpcCall("sendMsg", b.Bytes())
	if err != nil {
		return err
	}
	for _, f := range pbDecode(r) {
		if f.num == 1 && len(f.b) > 0 {
			return errors.New(string(f.b))
		}
	}
	return nil
}

// drvLightType asks iot_driver to stream itself: 0 = music, 1 = screen, 2 = stop.
func drvLightType(path string, t int, dangle int) error {
	var b bytes.Buffer
	pbBytes(&b, 1, []byte(path))
	if t != 0 {
		pbVar(&b, 2, uint64(t))
	}
	if dangle != 0 {
		pbVar(&b, 4, uint64(dangle))
	}
	_, err := grpcCall("setLightType", b.Bytes())
	return err
}

type drvDev struct {
	id   int64
	path string
}

func drvDevices() ([]drvDev, error) {
	r, err := grpcCall("watchDevList", nil)
	if err != nil {
		return nil, err
	}
	var out []drvDev
	for _, f := range pbDecode(r) {
		if f.num != 1 {
			continue
		}
		for _, g := range pbDecode(f.b) {
			if g.num != 1 {
				continue
			}
			var d drvDev
			for _, h := range pbDecode(g.b) {
				if h.num == 3 {
					d.path = string(h.b)
				}
				if h.num == 4 {
					d.id = int64(h.v)
				}
			}
			out = append(out, d)
		}
	}
	return out, nil
}

/* ---------- COM helpers ---------- */

var (
	ole32            = syscall.NewLazyDLL("ole32.dll")
	procCoInit       = ole32.NewProc("CoInitializeEx")
	procCoUninit     = ole32.NewProc("CoUninitialize")
	procCoCreate     = ole32.NewProc("CoCreateInstance")
	procCoTaskMemFree = ole32.NewProc("CoTaskMemFree")
)

type guid struct {
	D1 uint32
	D2 uint16
	D3 uint16
	D4 [8]byte
}

var (
	clsidMMDeviceEnumerator = guid{0xBCDE0395, 0xE52F, 0x467C, [8]byte{0x8E, 0x3D, 0xC4, 0x57, 0x92, 0x91, 0x69, 0x2E}}
	iidIMMDeviceEnumerator  = guid{0xA95664D2, 0x9614, 0x4F35, [8]byte{0xA7, 0x46, 0xDE, 0x8D, 0xB6, 0x36, 0x17, 0xE6}}
	iidIAudioClient         = guid{0x1CB9AD4C, 0xDBFA, 0x4C32, [8]byte{0xB1, 0x78, 0xC2, 0xF5, 0x68, 0xA7, 0x03, 0xB2}}
	iidIAudioCaptureClient  = guid{0xC8ADBD64, 0xE71E, 0x48A0, [8]byte{0xA4, 0xDE, 0x18, 0x5C, 0x39, 0x5C, 0xD3, 0x17}}
)

// call method #idx of a COM object
func comCall(obj uintptr, idx int, args ...uintptr) uintptr {
	vtbl := *(*uintptr)(unsafe.Pointer(obj))
	fn := *(*uintptr)(unsafe.Pointer(vtbl + uintptr(idx)*unsafe.Sizeof(uintptr(0))))
	r, _, _ := syscall.SyscallN(fn, append([]uintptr{obj}, args...)...)
	return r
}
func comRelease(obj uintptr) {
	if obj != 0 {
		comCall(obj, 2)
	}
}
func hr(r uintptr, what string) error {
	if int32(r) < 0 {
		return fmt.Errorf("%s: 0x%08X", what, uint32(r))
	}
	return nil
}

/* ---------- audio capture (WASAPI loopback) ---------- */

const fftN = 2048

type audioCapture struct {
	mu     sync.Mutex
	ring   [fftN]float32
	w      int
	rate   int
	status string
	lastAt time.Time
}

func (a *audioCapture) push(s []float32) {
	a.mu.Lock()
	for _, v := range s {
		a.ring[a.w] = v
		a.w = (a.w + 1) % fftN
	}
	a.lastAt = time.Now()
	a.mu.Unlock()
}
func (a *audioCapture) snapshot(dst []float64) {
	a.mu.Lock()
	for i := 0; i < fftN; i++ {
		dst[i] = float64(a.ring[(a.w+i)%fftN])
	}
	a.mu.Unlock()
}
func (a *audioCapture) setStatus(s string) {
	a.mu.Lock()
	a.status = s
	a.mu.Unlock()
}

// run captures until stop is closed; reopens the device on errors (e.g. headphones switched).
func (a *audioCapture) run(stop chan struct{}) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	procCoInit.Call(0, 0) // COINIT_MULTITHREADED
	defer procCoUninit.Call()
	for {
		err := a.once(stop)
		select {
		case <-stop:
			return
		default:
		}
		if err != nil {
			a.setStatus(err.Error())
		}
		select {
		case <-stop:
			return
		case <-time.After(time.Second):
		}
	}
}

func (a *audioCapture) once(stop chan struct{}) error {
	var enum, dev, client, capt uintptr
	defer func() { comRelease(capt); comRelease(client); comRelease(dev); comRelease(enum) }()
	r, _, _ := procCoCreate.Call(uintptr(unsafe.Pointer(&clsidMMDeviceEnumerator)), 0, 0x17, uintptr(unsafe.Pointer(&iidIMMDeviceEnumerator)), uintptr(unsafe.Pointer(&enum)))
	if err := hr(r, "MMDeviceEnumerator"); err != nil {
		return err
	}
	if err := hr(comCall(enum, 4, 0, 0, uintptr(unsafe.Pointer(&dev))), "нет устройства вывода звука"); err != nil {
		return err
	}
	if err := hr(comCall(dev, 3, uintptr(unsafe.Pointer(&iidIAudioClient)), 0x17, 0, uintptr(unsafe.Pointer(&client))), "Activate"); err != nil {
		return err
	}
	var pwfx uintptr
	if err := hr(comCall(client, 8, uintptr(unsafe.Pointer(&pwfx))), "GetMixFormat"); err != nil {
		return err
	}
	defer procCoTaskMemFree.Call(pwfx)
	tag := *(*uint16)(unsafe.Pointer(pwfx))
	ch := int(*(*uint16)(unsafe.Pointer(pwfx + 2)))
	rate := int(*(*uint32)(unsafe.Pointer(pwfx + 4)))
	block := int(*(*uint16)(unsafe.Pointer(pwfx + 12)))
	bits := int(*(*uint16)(unsafe.Pointer(pwfx + 14)))
	isFloat := tag == 3
	if tag == 0xFFFE {
		sub := *(*uint32)(unsafe.Pointer(pwfx + 24))
		isFloat = sub == 3
	}
	if err := hr(comCall(client, 3, 0, 0x00020000, 2000000, 0, pwfx, 0), "Initialize loopback"); err != nil {
		return err
	}
	if err := hr(comCall(client, 14, uintptr(unsafe.Pointer(&iidIAudioCaptureClient)), uintptr(unsafe.Pointer(&capt))), "GetService"); err != nil {
		return err
	}
	if err := hr(comCall(client, 10), "Start"); err != nil {
		return err
	}
	defer comCall(client, 11)
	a.mu.Lock()
	a.rate = rate
	a.status = "ok"
	a.mu.Unlock()
	mono := make([]float32, 0, 4096)
	lastData := time.Now()
	for {
		select {
		case <-stop:
			return nil
		case <-time.After(10 * time.Millisecond):
		}
		got := false
		for {
			var n uint32
			if err := hr(comCall(capt, 5, uintptr(unsafe.Pointer(&n))), "GetNextPacketSize"); err != nil {
				return err
			}
			if n == 0 {
				break
			}
			var data uintptr
			var frames, flags uint32
			if err := hr(comCall(capt, 3, uintptr(unsafe.Pointer(&data)), uintptr(unsafe.Pointer(&frames)), uintptr(unsafe.Pointer(&flags)), 0, 0), "GetBuffer"); err != nil {
				return err
			}
			mono = mono[:0]
			for f := 0; f < int(frames); f++ {
				var sum float32
				if flags&2 == 0 && data != 0 {
					base := data + uintptr(f*block)
					for c := 0; c < ch; c++ {
						switch {
						case isFloat && bits == 32:
							sum += *(*float32)(unsafe.Pointer(base + uintptr(c*4)))
						case bits == 16:
							sum += float32(*(*int16)(unsafe.Pointer(base + uintptr(c*2)))) / 32768
						case bits == 32:
							sum += float32(*(*int32)(unsafe.Pointer(base + uintptr(c*4)))) / 2147483648
						}
					}
				}
				if ch > 0 {
					sum /= float32(ch)
				}
				mono = append(mono, sum)
			}
			comCall(capt, 4, uintptr(frames))
			a.push(mono)
			got = true
		}
		if got {
			lastData = time.Now()
		} else if el := time.Since(lastData); el > 50*time.Millisecond {
			// nothing is playing: WASAPI sends no packets, so feed silence
			z := make([]float32, int(el.Seconds()*float64(rate)))
			if len(z) > fftN {
				z = z[:fftN]
			}
			a.push(z)
			lastData = time.Now()
		}
	}
}

/* ---------- spectrum like Web Audio AnalyserNode (fftSize 2048, smoothing 0.4) ---------- */

type analyser struct {
	smooth [fftN / 2]float64
	env    float64 // AGC: slowly decaying peak of the spectrum
	Gain   float64
	buf    []float64
	re, im []float64
	win    []float64
}

func newAnalyser() *analyser {
	a := &analyser{buf: make([]float64, fftN), re: make([]float64, fftN), im: make([]float64, fftN), win: make([]float64, fftN)}
	for i := range a.win {
		x := 2 * math.Pi * float64(i) / fftN
		a.win[i] = 0.42 - 0.5*math.Cos(x) + 0.08*math.Cos(2*x)
	}
	return a
}

func fft(re, im []float64) {
	n := len(re)
	for i, j := 1, 0; i < n; i++ {
		bit := n >> 1
		for ; j&bit != 0; bit >>= 1 {
			j ^= bit
		}
		j ^= bit
		if i < j {
			re[i], re[j] = re[j], re[i]
			im[i], im[j] = im[j], im[i]
		}
	}
	for l := 2; l <= n; l <<= 1 {
		ang := -2 * math.Pi / float64(l)
		wr, wi := math.Cos(ang), math.Sin(ang)
		for i := 0; i < n; i += l {
			cr, ci := 1.0, 0.0
			for k := 0; k < l/2; k++ {
				ar, ai := re[i+k], im[i+k]
				br := re[i+k+l/2]*cr - im[i+k+l/2]*ci
				bi := re[i+k+l/2]*ci + im[i+k+l/2]*cr
				re[i+k], im[i+k] = ar+br, ai+bi
				re[i+k+l/2], im[i+k+l/2] = ar-br, ai-bi
				cr, ci = cr*wr-ci*wi, cr*wi+ci*wr
			}
		}
	}
}

// bytes returns getByteFrequencyData()[0..count)
func (a *analyser) bytes(cap *audioCapture, count int) []int {
	cap.snapshot(a.buf)
	for i := range a.buf {
		a.re[i] = a.buf[i] * a.win[i]
		a.im[i] = 0
	}
	fft(a.re, a.im)
	out := make([]int, count)
	peak := 0.0
	for k := 0; k < fftN/2; k++ {
		mag := math.Hypot(a.re[k], a.im[k]) / fftN
		a.smooth[k] = 0.4*a.smooth[k] + 0.6*mag
		if k >= 27 && k < 59 && a.smooth[k] > peak { // only the bins shown on the keyboard
			peak = a.smooth[k]
		}
	}
	// Automatic gain: the loudest bin of the last few seconds is mapped to -30 dB
	// (top of the AnalyserNode range), so the bars do not depend on the volume knob.
	if peak > a.env {
		a.env = peak
	} else {
		a.env *= 0.997 // ~ -0.4 dB/s at 33 fps
	}
	gain := 1.0
	if a.env > 1e-7 {
		gain = 0.0316 / a.env
	}
	if gain < 1 {
		gain = 1
	}
	if gain > 3000 { // ~70 dB max, so pure noise is not blown up
		gain = 3000
	}
	a.Gain = gain
	for k := 0; k < count; k++ {
		{
			db := -1000.0
			if a.smooth[k] > 0 {
				db = 20 * math.Log10(a.smooth[k]*gain)
			}
			v := int(math.Floor(255 / 70.0 * (db + 100)))
			if v < 0 {
				v = 0
			}
			if v > 255 {
				v = 255
			}
			out[k] = v
		}
	}
	return out
}

// vu keeps state for keyboard bars: log-spaced bands, slow loudness reference, falling peaks.
type vu struct {
	ref   float64 // dB, loudest band of the last ~half minute (never below vuFloor)
	peak  float64 // dB, loudest band of the current frame (debug)
	shown [32]float64
}

const (
	vuFloor = -52.0 // quieter than this is shown proportionally lower (no blow-up of quiet music)
	vuRange = 30.0  // dB between an empty and a full bar
	vuHead  = 22.0  // average loudness sits at ~4.4 of 6; ~8 dB louder (a drop) = full bar
)

func (a *analyser) levels(cap *audioCapture, v *vu) []int {
	a.bytes(cap, 1) // refreshes a.smooth
	const lo, hi = 3.0, 341.0 // ~70 Hz .. 8 kHz at 48 kHz
	db := make([]float64, 32)
	pk := -200.0
	for i := 0; i < 32; i++ {
		k0 := int(lo * math.Pow(hi/lo, float64(i)/32))
		k1 := int(lo * math.Pow(hi/lo, float64(i+1)/32))
		if k1 <= k0 {
			k1 = k0 + 1
		}
		m := 0.0
		for k := k0; k < k1 && k < fftN/2; k++ {
			if a.smooth[k] > m {
				m = a.smooth[k]
			}
		}
		d := 20 * math.Log10(m+1e-12)
		d += 2.5 * math.Log2(float64(k0+k1)/2/lo) // pink-noise tilt, so highs are visible too
		db[i] = d
		if d > pk {
			pk = d
		}
	}
	v.peak = pk
	// ref = average loudness of the last ~8 s (slow both ways), so a drop that is louder
	// than the rest of the track really reaches the top instead of being normalised away
	if pk > -110 {
		v.ref += (pk - v.ref) * 0.004
	}
	low := v.ref - vuHead
	if low < vuFloor-vuRange {
		low = vuFloor - vuRange // quiet music: fixed scale, same as before
	}
	out := make([]int, 32)
	for i := 0; i < 32; i++ {
		t := 6 * (db[i] - low) / vuRange
		if t < 0 {
			t = 0
		}
		if t > 6 {
			t = 6
		}
		if t >= v.shown[i] {
			v.shown[i] = t
		} else {
			v.shown[i] -= 0.18 // bars fall ~6 levels per second
			if v.shown[i] < t {
				v.shown[i] = t
			}
		}
		out[i] = int(math.Round(v.shown[i]))
	}
	return out
}

// musicLevels reproduces the original driver's "music3Delt": 32 levels 0..6
func musicLevels(b []int) []int {
	const mCount = 6
	mn := 255
	for _, v := range b[20:40] {
		if v < mn {
			mn = v
		}
	}
	e := make([]float64, 100)
	mx := 0.0
	for i := 0; i < 100; i++ {
		e[i] = float64(b[i] - mn)
		if i >= 27 && i < 59 && e[i] > mx {
			mx = e[i]
		}
	}
	if mx < 25 {
		mx = 25
	}
	out := make([]int, 32)
	if mx <= 0 {
		return out
	}
	step := mx / mCount
	for i := 0; i < 32; i++ {
		r := int(math.Round(e[27+i] / step))
		if r < 0 {
			r = 0
		}
		if r > mCount {
			r = mCount
		}
		out[i] = r
	}
	return out
}

/* ---------- screen colour (GDI) ---------- */

var (
	gdi32           = syscall.NewLazyDLL("gdi32.dll")
	procGetDC       = user32.NewProc("GetDC")
	procReleaseDC   = user32.NewProc("ReleaseDC")
	procGetSysMet   = user32.NewProc("GetSystemMetrics")
	procCreateCDC   = gdi32.NewProc("CreateCompatibleDC")
	procCreateCBmp  = gdi32.NewProc("CreateCompatibleBitmap")
	procSelectObj   = gdi32.NewProc("SelectObject")
	procDeleteObj   = gdi32.NewProc("DeleteObject")
	procDeleteDC    = gdi32.NewProc("DeleteDC")
	procStretchBlt  = gdi32.NewProc("StretchBlt")
	procSetStretch  = gdi32.NewProc("SetStretchBltMode")
	procSetBrushOrg = gdi32.NewProc("SetBrushOrgEx")
	procGetDIBits   = gdi32.NewProc("GetDIBits")
)

type screenGrab struct {
	sdc, mdc, bmp, old uintptr
	pix                []byte
}

const grabW, grabH = 48, 27

func newScreenGrab() *screenGrab {
	g := &screenGrab{pix: make([]byte, grabW*grabH*4)}
	g.sdc, _, _ = procGetDC.Call(0)
	g.mdc, _, _ = procCreateCDC.Call(g.sdc)
	g.bmp, _, _ = procCreateCBmp.Call(g.sdc, grabW, grabH)
	g.old, _, _ = procSelectObj.Call(g.mdc, g.bmp)
	procSetStretch.Call(g.mdc, 4) // HALFTONE: real averaging
	procSetBrushOrg.Call(g.mdc, 0, 0, 0)
	return g
}
func (g *screenGrab) close() {
	procSelectObj.Call(g.mdc, g.old)
	procDeleteObj.Call(g.bmp)
	procDeleteDC.Call(g.mdc)
	procReleaseDC.Call(0, g.sdc)
}
func (g *screenGrab) color() ([3]int, bool) {
	sw, _, _ := procGetSysMet.Call(0)
	sh, _, _ := procGetSysMet.Call(1)
	r, _, _ := procStretchBlt.Call(g.mdc, 0, 0, grabW, grabH, g.sdc, 0, 0, sw, sh, 0x00CC0020)
	if r == 0 {
		return [3]int{}, false
	}
	type bih struct {
		Size          uint32
		Width, Height int32
		Planes, Bits  uint16
		Compression   uint32
		SizeImage     uint32
		XPels, YPels  int32
		ClrUsed       uint32
		ClrImportant  uint32
	}
	var bi [11]uint32 // BITMAPINFO header + 1 colour (enough room)
	h := (*bih)(unsafe.Pointer(&bi[0]))
	h.Size, h.Width, h.Height, h.Planes, h.Bits = 40, grabW, -grabH, 1, 32
	n, _, _ := procGetDIBits.Call(g.mdc, g.bmp, 0, grabH, uintptr(unsafe.Pointer(&g.pix[0])), uintptr(unsafe.Pointer(&bi[0])), 0)
	if n == 0 {
		return [3]int{}, false
	}
	// colourful, bright pixels count much more than grey/black UI, then the result is
	// brightened so the keyboard shows the screen's hue instead of a dull grey
	var sr, sg, sb, wsum float64
	for i := 0; i < len(g.pix); i += 4 {
		b, gg, r := float64(g.pix[i]), float64(g.pix[i+1]), float64(g.pix[i+2])
		mx := math.Max(r, math.Max(gg, b))
		mn := math.Min(r, math.Min(gg, b))
		sat := 0.0
		if mx > 0 {
			sat = (mx - mn) / mx
		}
		w := 0.05 + sat*sat*(mx/255)*(mx/255)*20
		sr += r * w
		sg += gg * w
		sb += b * w
		wsum += w
	}
	ar, ag, ab := sr/wsum, sg/wsum, sb/wsum
	mx := math.Max(ar, math.Max(ag, ab))
	if mx < 6 {
		return [3]int{0, 0, 0}, true
	}
	// push saturation a bit and normalise brightness to full
	mn := math.Min(ar, math.Min(ag, ab))
	k := 255 / mx
	sat := (mx - mn) / mx
	boost := 1.0
	if sat > 0.08 {
		boost = 1.5
	}
	f := func(v float64) int {
		v = mx - (mx-v)*boost
		if v < 0 {
			v = 0
		}
		x := int(math.Round(v * k))
		if x > 255 {
			x = 255
		}
		return x
	}
	return [3]int{f(ar), f(ag), f(ab)}, true
}

/* ---------- stream controller + HTTP API ---------- */

type streamCfg struct {
	Mode   string `json:"mode"` // "music" | "screen" | ""
	Path   string `json:"path"`
	ID     int64  `json:"id"`
	Dangle int    `json:"dangle"`
	Hold   int    `json:"hold"` // ms: pause frames while the page talks to the keyboard
}

var stream struct {
	sync.Mutex
	cfg     streamCfg
	gen     int
	levels  []int
	rgb     [3]int
	frames  int64
	errs    int64
	lastErr string
	okAt    time.Time
	holdTil time.Time
	audio   string
	vuRef   float64
	vuPeak  float64
	posted  bool // страница хотя бы раз сообщила режим (живая подсветка включена или выключена)
	closed  bool // окно закрыто: поток передан фоновому процессу, запросы страницы его не меняют
}

func streamSetCfg(c streamCfg) {
	stream.Lock()
	defer stream.Unlock()
	old := stream.cfg
	stream.cfg = c
	if c.Mode != old.Mode || c.ID != old.ID {
		stream.gen++
		stream.frames, stream.errs, stream.lastErr = 0, 0, ""
		stream.levels = nil
		if c.Mode == "music" || c.Mode == "screen" {
			go streamRun(stream.gen, c.Mode)
		}
	}
}

func streamRun(gen int, mode string) {
	cur := func() (streamCfg, bool) {
		stream.Lock()
		defer stream.Unlock()
		return stream.cfg, stream.gen == gen
	}
	var ac *audioCapture
	var an *analyser
	var sg *screenGrab
	stop := make(chan struct{})
	defer close(stop)
	period := 40 * time.Millisecond
	if mode == "music" {
		ac = &audioCapture{status: "запуск"}
		an = newAnalyser()
		go ac.run(stop)
		period = 30 * time.Millisecond
	} else {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		sg = newScreenGrab()
		defer sg.close()
	}
	var lastResolve time.Time
	failSince := time.Time{}
	nativePath := ""
	lastStop := time.Time{}
	meter := &vu{ref: vuFloor - 8}
	if mode == "music" {
		defer func() {
			_ = nativePath
		}()
	}
	for {
		t0 := time.Now()
		cfg, ok := cur()
		if !ok {
			return
		}
		stream.Lock()
		held := time.Now().Before(stream.holdTil)
		stream.Unlock()
		if held {
			time.Sleep(20 * time.Millisecond)
			continue
		}
		var pkt []byte
		if cfg.Path == nativePath && time.Since(lastStop) > 3*time.Second {
			// iot_driver may switch its own music stream back on (re-plug, driver restart):
			// keep telling it to stay off, otherwise both streams fight and the keyboard flashes
			lastStop = time.Now()
			_ = drvLightType(cfg.Path, 2, cfg.Dangle)
		}
		if cfg.Path != nativePath {
			// Q75 takes host frames (music 0x0D, screen 0x0E) only while iot_driver's own stream is off
			if e := drvLightType(cfg.Path, 2, cfg.Dangle); e == nil {
				nativePath = cfg.Path
				lastStop = time.Now()
			} else {
				stream.Lock()
				stream.errs++
				stream.lastErr = e.Error()
				stream.Unlock()
				time.Sleep(500 * time.Millisecond)
				continue
			}
		}
		if ac != nil {
			lv := an.levels(ac, meter)
			stream.Lock()
			stream.vuRef, stream.vuPeak = meter.ref, meter.peak
			stream.Unlock()
			pkt = []byte{0x0D, 0, 0, 0, 0, 0, 0, 0} // FEA_CMD_SET_AUDIO = 13 on Q75
			for _, v := range lv {
				pkt = append(pkt, byte(v))
			}
			ac.mu.Lock()
			as := ac.status
			ac.mu.Unlock()
			stream.Lock()
			stream.levels, stream.audio = lv, as
			stream.Unlock()
		} else {
			c, ok := sg.color()
			if !ok { // e.g. secure desktop (UAC/lock screen): reopen DCs
				sg.close()
				sg = newScreenGrab()
				time.Sleep(200 * time.Millisecond)
				continue
			}
			pkt = []byte{0x0E, byte(c[0]), byte(c[1]), byte(c[2]), 255} // FEA_CMD_SET_WINDOS = 14 on Q75
			stream.Lock()
			stream.rgb = c
			stream.Unlock()
		}
		err := drvSend(cfg.Path, pkt, 0, cfg.Dangle) // checksum BIT7
		stream.Lock()
		if err == nil {
			stream.frames++
			stream.okAt = time.Now()
			stream.lastErr = ""
		} else {
			stream.errs++
			stream.lastErr = err.Error()
		}
		stream.Unlock()
		if err != nil {
			if failSince.IsZero() {
				failSince = time.Now()
			}
			// keyboard re-plugs itself after a mode change: look up its new path
			if time.Since(failSince) > time.Second && time.Since(lastResolve) > time.Second && cfg.ID != 0 {
				lastResolve = time.Now()
				if ds, e := drvDevices(); e == nil {
					pick := ""
					for _, d := range ds {
						if d.id == cfg.ID && (pick == "" || d.path == cfg.Path || strings.HasSuffix(strings.ToUpper(d.path), "KBD")) {
							pick = d.path
							if d.path == cfg.Path {
								break
							}
						}
					}
					if pick != "" && pick != cfg.Path {
						stream.Lock()
						if stream.gen == gen {
							stream.cfg.Path = pick
						}
						stream.Unlock()
					}
				}
			}
			time.Sleep(300 * time.Millisecond)
			continue
		}
		failSince = time.Time{}
		if d := period - time.Since(t0); d > 0 {
			time.Sleep(d)
		}
	}
}

func streamHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method == "POST" {
		var c streamCfg
		if err := json.NewDecoder(io.LimitReader(r.Body, 8192)).Decode(&c); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		if c.Hold > 0 {
			if c.Hold > 5000 {
				c.Hold = 5000
			}
			stream.Lock()
			stream.holdTil = time.Now().Add(time.Duration(c.Hold) * time.Millisecond)
			stream.Unlock()
			time.Sleep(40 * time.Millisecond) // let an in-flight frame finish
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{"held":true}`))
			return
		}
		stream.Lock()
		if stream.closed {
			stream.Unlock()
			http.Error(w, "closed", 409)
			return
		}
		stream.posted = true
		samePathOnly := c.Mode == stream.cfg.Mode && c.ID == stream.cfg.ID
		stream.Unlock()
		if samePathOnly {
			stream.Lock()
			if c.Path != "" {
				stream.cfg.Path = c.Path
			}
			stream.cfg.Dangle = c.Dangle
			stream.Unlock()
		} else {
			streamSetCfg(c)
		}
	}
	stream.Lock()
	st := map[string]any{
		"mode": stream.cfg.Mode, "frames": stream.frames, "errors": stream.errs, "lastError": stream.lastErr,
		"live": !stream.okAt.IsZero() && time.Since(stream.okAt) < 1500*time.Millisecond,
		"levels": stream.levels, "rgb": stream.rgb, "audio": stream.audio,
		"vuRef": math.Round(stream.vuRef*10) / 10, "vuPeak": math.Round(stream.vuPeak*10) / 10,
	}
	stream.Unlock()
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(st)
}
