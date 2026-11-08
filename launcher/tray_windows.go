//go:build windows

// Фоновый режим. Окно закрыли, а на клавиатуре включены «Под музыку» или «Цвет экрана» —
// поток кадров продолжает тот же exe, запущенный с ключом --background: без окна и без
// WebView2 (около 15–20 МБ памяти), со значком у часов. Щелчок по значку или новый запуск
// программы открывает окно: оно забирает поток себе, а фоновый процесс завершается.
// В меню значка включается автозапуск вместе с Windows (тот же ключ --background).
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"
)

const (
	trayClass = "Q75StudioTray"              // невидимое окно фонового процесса: по нему его находит окно программы
	bgMutex   = "Local\\Q75StudioBackground" // не больше одного фонового процесса
	runKey    = "Software\\Microsoft\\Windows\\CurrentVersion\\Run"
	runName   = appTitle // имя записи автозапуска

	wmTray   = 0x8000 + 1 // WM_APP+1: события значка
	wmBgQuit = 0x8000 + 2 // WM_APP+2: окно забирает поток; ответ — PID службы iot_driver, если её запускала программа

	menuOpen = 1
	menuAuto = 2
	menuExit = 3
)

var (
	kernel32         = syscall.NewLazyDLL("kernel32.dll")
	procGetModuleH   = kernel32.NewProc("GetModuleHandleW")
	procCreateMutexW = kernel32.NewProc("CreateMutexW")
	procCloseHandle  = kernel32.NewProc("CloseHandle")
	advapi32         = syscall.NewLazyDLL("advapi32.dll")
	procRegOpenKey   = advapi32.NewProc("RegOpenKeyExW")
	procRegQuery     = advapi32.NewProc("RegQueryValueExW")
	procRegSet       = advapi32.NewProc("RegSetValueExW")
	procRegDelete    = advapi32.NewProc("RegDeleteValueW")
	procRegClose     = advapi32.NewProc("RegCloseKey")
	procNotifyIcon   = shell32.NewProc("Shell_NotifyIconW")
	procExtractIcon  = shell32.NewProc("ExtractIconExW")
	procRegClass     = user32.NewProc("RegisterClassExW")
	procCreateWin    = user32.NewProc("CreateWindowExW")
	procDefWinProc   = user32.NewProc("DefWindowProcW")
	procDestroyWin   = user32.NewProc("DestroyWindow")
	procGetMsg       = user32.NewProc("GetMessageW")
	procTranslateMsg = user32.NewProc("TranslateMessage")
	procDispatchMsg  = user32.NewProc("DispatchMessageW")
	procPostQuit     = user32.NewProc("PostQuitMessage")
	procPostMsg      = user32.NewProc("PostMessageW")
	procSendMsgTO    = user32.NewProc("SendMessageTimeoutW")
	procFindWin      = user32.NewProc("FindWindowW")
	procLoadImage    = user32.NewProc("LoadImageW")
	procNewPopup     = user32.NewProc("CreatePopupMenu")
	procAppendMenu   = user32.NewProc("AppendMenuW")
	procMenuDefault  = user32.NewProc("SetMenuDefaultItem")
	procTrackMenu    = user32.NewProc("TrackPopupMenu")
	procDestroyMenu  = user32.NewProc("DestroyMenu")
	procCursorPos    = user32.NewProc("GetCursorPos")
	procSetFg        = user32.NewProc("SetForegroundWindow")
	procAllowFg      = user32.NewProc("AllowSetForegroundWindow")
	procRegWinMsg    = user32.NewProc("RegisterWindowMessageW")
	procSetTimer     = user32.NewProc("SetTimer")
	procKillTimer    = user32.NewProc("KillTimer")
)

type wndClassEx struct { // WNDCLASSEXW
	size       uint32
	style      uint32
	wndProc    uintptr
	clsExtra   int32
	wndExtra   int32
	instance   uintptr
	icon       uintptr
	cursor     uintptr
	background uintptr
	menuName   *uint16
	className  *uint16
	iconSm     uintptr
}

type winMsg struct { // MSG
	hwnd    uintptr
	message uint32
	wParam  uintptr
	lParam  uintptr
	time    uint32
	ptX     int32
	ptY     int32
	private uint32
}

type notifyIconData struct { // NOTIFYICONDATAW, 976 байт в 64-битной программе
	size        uint32
	hwnd        uintptr
	id          uint32
	flags       uint32
	callbackMsg uint32
	icon        uintptr
	tip         [128]uint16
	state       uint32
	stateMask   uint32
	info        [256]uint16
	version     uint32
	infoTitle   [64]uint16
	infoFlags   uint32
	guidItem    [16]byte
	balloonIcon uintptr
}

/* ---------- запомненный выбор живой подсветки ---------- */

// live.json: что держать в фоне и при автозапуске.
type liveState struct {
	Mode   string `json:"mode"` // "music" | "screen" | "" — обычный эффект, держать нечего
	Path   string `json:"path"`
	ID     int64  `json:"id"`
	Dangle int    `json:"dangle"`
	Hinted bool   `json:"hinted,omitempty"` // подсказку о значке у часов уже показывали
}

func liveFile() string {
	return filepath.Join(os.Getenv("LOCALAPPDATA"), "Q75Studio", "live.json")
}

func loadLive() liveState {
	var s liveState
	if b, err := os.ReadFile(liveFile()); err == nil {
		json.Unmarshal(b, &s)
	}
	return s
}

func saveLive(s liveState) {
	p := liveFile()
	os.MkdirAll(filepath.Dir(p), 0o755)
	b, _ := json.Marshal(s)
	if os.WriteFile(p+".tmp", b, 0o644) == nil {
		os.Rename(p+".tmp", p)
	}
}

func isLive(mode string) bool { return mode == "music" || mode == "screen" }

func hasArg(a string) bool {
	for _, x := range os.Args[1:] {
		if x == a {
			return true
		}
	}
	return false
}

func argValue(prefix string) string {
	for _, x := range os.Args[1:] {
		if strings.HasPrefix(x, prefix) {
			return x[len(prefix):]
		}
	}
	return ""
}

/* ---------- окно программы ---------- */

// handOverToBackground: окно закрыли. Запоминает выбор и, если включена живая подсветка,
// запускает фоновый процесс. true — служба iot_driver теперь нужна фону, её не останавливать.
func handOverToBackground(drv *os.Process) bool {
	stream.Lock()
	stream.closed = true // запросы страницы больше не меняют поток
	cfg, posted := stream.cfg, stream.posted
	stream.Unlock()
	if !posted {
		return false // страница не успела узнать режим клавиатуры — прошлый выбор не трогаем
	}
	s := loadLive()
	s.Mode, s.Path, s.ID, s.Dangle = "", cfg.Path, cfg.ID, cfg.Dangle
	if isLive(cfg.Mode) {
		s.Mode = cfg.Mode
	}
	saveLive(s)
	if s.Mode == "" {
		return false
	}
	streamSetCfg(streamCfg{})          // свой поток останавливаем: два потока мешали бы друг другу
	time.Sleep(150 * time.Millisecond) // даём завершиться кадру «в пути»
	exe, err := os.Executable()
	if err != nil {
		return false
	}
	args := []string{"--background", "--handover"}
	if drv != nil {
		args = append(args, "--driver="+strconv.Itoa(drv.Pid))
	}
	cmd := exec.Command(exe, args...)
	if cmd.Start() != nil {
		return false
	}
	cmd.Process.Release()
	return true
}

// stopBackground: окно открывают снова — фоновый процесс отдаёт поток окну и завершается.
// Возвращает службу iot_driver, если её запускала программа: теперь за неё отвечает окно.
func stopBackground() *os.Process {
	cls, _ := syscall.UTF16PtrFromString(trayClass)
	find := func() uintptr {
		h, _, _ := procFindWin.Call(uintptr(unsafe.Pointer(cls)), 0)
		return h
	}
	h := find()
	if h == 0 {
		return nil
	}
	var pid uintptr
	procSendMsgTO.Call(h, wmBgQuit, 0, 0, 0x0002, 3000, uintptr(unsafe.Pointer(&pid))) // SMTO_ABORTIFHUNG
	for i := 0; i < 30 && find() != 0; i++ {
		time.Sleep(100 * time.Millisecond)
	}
	if pid != 0 {
		if p, err := os.FindProcess(int(pid)); err == nil {
			return p
		}
	}
	return nil
}

/* ---------- фоновый процесс ---------- */

var (
	bgDriver  *os.Process // служба iot_driver, если её запускала программа
	bgOpening atomic.Bool
	trayHwnd  uintptr
	trayNid   notifyIconData
	trayShown bool
	trayReAdd uint32 // сообщение TaskbarCreated: Проводник перезапустился, значок нужно добавить заново
)

// runBackground — процесс без окна: держит поток живой подсветки и значок у часов.
// handover — запущен закрывшимся окном; иначе — автозапуском вместе с Windows.
func runBackground(handover bool) {
	runtime.LockOSThread() // окно значка и его сообщения — в одном системном потоке
	name, _ := syscall.UTF16PtrFromString(bgMutex)
	var mu uintptr
	for i := 0; ; i++ {
		h, _, e := procCreateMutexW.Call(0, 0, uintptr(unsafe.Pointer(name)))
		if h != 0 && e != syscall.ERROR_ALREADY_EXISTS {
			mu = h
			break
		}
		if h != 0 {
			procCloseHandle.Call(h)
		}
		if i >= 15 {
			return // фоновый процесс уже работает
		}
		time.Sleep(200 * time.Millisecond)
	}
	defer procCloseHandle.Call(mu)
	if !handover && portOpen(fmt.Sprintf("127.0.0.1:%d", uiPort)) {
		return // окно программы открыто — поток держит оно
	}
	s := loadLive()
	if !isLive(s.Mode) {
		return // в последний раз был выбран обычный эффект: держать нечего
	}
	if pid, _ := strconv.Atoi(argValue("--driver=")); pid > 0 {
		bgDriver, _ = os.FindProcess(pid)
	}
	if drv, _ := startDriver(); drv != nil {
		bgDriver = drv.Process
	}
	if autostartEnabled() {
		setAutostart(true) // программу могли перенести в другую папку — обновляем путь
	}
	streamSetCfg(streamCfg{Mode: s.Mode, Path: s.Path, ID: s.ID, Dangle: s.Dangle})
	trayLoop(s, handover && !s.Hinted)
	streamSetCfg(streamCfg{})
	time.Sleep(150 * time.Millisecond)
}

func trayLoop(s liveState, hint bool) {
	inst, _, _ := procGetModuleH.Call(0)
	cls, _ := syscall.UTF16PtrFromString(trayClass)
	wc := wndClassEx{wndProc: syscall.NewCallback(trayWndProc), instance: inst, className: cls}
	wc.size = uint32(unsafe.Sizeof(wc))
	procRegClass.Call(uintptr(unsafe.Pointer(&wc)))
	title, _ := syscall.UTF16PtrFromString(appTitle)
	// невидимое окно: WS_POPUP без WS_VISIBLE, WS_EX_TOOLWINDOW — не попадает в Alt+Tab
	trayHwnd, _, _ = procCreateWin.Call(0x80, uintptr(unsafe.Pointer(cls)), uintptr(unsafe.Pointer(title)), 0x80000000, 0, 0, 0, 0, 0, 0, inst, 0)
	if trayHwnd == 0 {
		return
	}
	tc, _ := syscall.UTF16PtrFromString("TaskbarCreated")
	m, _, _ := procRegWinMsg.Call(uintptr(unsafe.Pointer(tc)))
	trayReAdd = uint32(m)
	var icon uintptr // значок программы — тот же, что у exe в Проводнике
	if exe, err := os.Executable(); err == nil {
		p, _ := syscall.UTF16PtrFromString(exe)
		procExtractIcon.Call(uintptr(unsafe.Pointer(p)), 0, 0, uintptr(unsafe.Pointer(&icon)), 1)
	}
	if icon == 0 {
		icon, _, _ = procLoadImage.Call(0, 32512, 1, 0, 0, 0x8040) // IDI_APPLICATION, LR_SHARED|LR_DEFAULTSIZE
	}
	trayNid = notifyIconData{hwnd: trayHwnd, id: 1, flags: 0x1 | 0x2 | 0x4, callbackMsg: wmTray, icon: icon} // NIF_MESSAGE|NIF_ICON|NIF_TIP
	trayNid.size = uint32(unsafe.Sizeof(trayNid))
	what := "подсветка под музыку"
	if s.Mode == "screen" {
		what = "«Цвет экрана»"
	}
	putUTF16(trayNid.tip[:], appTitle+": "+what+" работает в фоне")
	if hint {
		trayNid.flags |= 0x10          // NIF_INFO: один раз объясняем, куда делось окно
		trayNid.infoFlags = 0x1 | 0x10 // NIIF_INFO | NIIF_NOSOUND
		putUTF16(trayNid.infoTitle[:], "Подсветка работает в фоне")
		putUTF16(trayNid.info[:], "Окно закрыто, а подсветка продолжает работать. Щелчок по значку FL Esports Studio открывает окно, правая кнопка — автозапуск с Windows и выход.")
	}
	if !trayAdd() {
		procSetTimer.Call(trayHwnd, 1, 3000, 0) // сразу после входа в Windows панель задач может быть ещё не готова
	}
	var msg winMsg
	for {
		r, _, _ := procGetMsg.Call(uintptr(unsafe.Pointer(&msg)), 0, 0, 0)
		if int32(r) <= 0 {
			return
		}
		procTranslateMsg.Call(uintptr(unsafe.Pointer(&msg)))
		procDispatchMsg.Call(uintptr(unsafe.Pointer(&msg)))
	}
}

func trayAdd() bool {
	r, _, _ := procNotifyIcon.Call(0, uintptr(unsafe.Pointer(&trayNid))) // NIM_ADD
	trayShown = r != 0
	if trayShown && trayNid.flags&0x10 != 0 {
		trayNid.flags &^= 0x10 // подсказку показали — при повторном добавлении значка не повторяем
		s := loadLive()
		s.Hinted = true
		saveLive(s)
	}
	return trayShown
}

func trayWndProc(hwnd, msg, wp, lp uintptr) uintptr {
	switch m := uint32(msg); {
	case m == wmTray:
		switch uint32(lp) {
		case 0x0202: // WM_LBUTTONUP: открыть окно
			bgOpenWindow()
		case 0x0205: // WM_RBUTTONUP: меню
			trayMenu(hwnd)
		}
		return 0
	case m == wmBgQuit:
		pid := uintptr(0)
		if bgDriver != nil {
			pid = uintptr(bgDriver.Pid)
		}
		trayQuit(false)
		return pid
	case m == 0x0113: // WM_TIMER: ещё одна попытка показать значок
		if trayShown || trayAdd() {
			procKillTimer.Call(hwnd, 1)
		}
		return 0
	case m == 0x0002: // WM_DESTROY
		procPostQuit.Call(0)
		return 0
	case trayReAdd != 0 && m == trayReAdd: // Проводник перезапустился — значок пропал
		trayShown = false
		if !trayAdd() {
			procSetTimer.Call(hwnd, 1, 3000, 0)
		}
		return 0
	}
	r, _, _ := procDefWinProc.Call(hwnd, msg, wp, lp)
	return r
}

func trayMenu(hwnd uintptr) {
	menu, _, _ := procNewPopup.Call()
	if menu == 0 {
		return
	}
	defer procDestroyMenu.Call(menu)
	add := func(flags, id uintptr, text string) {
		t, _ := syscall.UTF16PtrFromString(text)
		procAppendMenu.Call(menu, flags, id, uintptr(unsafe.Pointer(t)))
	}
	auto := uintptr(0)
	if autostartEnabled() {
		auto = 0x8 // MF_CHECKED
	}
	add(0, menuOpen, "Открыть FL Esports Studio")
	add(auto, menuAuto, "Запускать вместе с Windows")
	add(0x800, 0, "") // MF_SEPARATOR
	add(0, menuExit, "Выход (подсветка остановится)")
	procMenuDefault.Call(menu, menuOpen, 0)
	var pt [2]int32
	procCursorPos.Call(uintptr(unsafe.Pointer(&pt[0])))
	procSetFg.Call(hwnd) // иначе меню не закрывается щелчком мимо
	cmd, _, _ := procTrackMenu.Call(menu, 0x0100|0x0020, uintptr(pt[0]), uintptr(pt[1]), 0, hwnd, 0) // TPM_RETURNCMD|TPM_RIGHTBUTTON
	procPostMsg.Call(hwnd, 0, 0, 0)
	switch cmd {
	case menuOpen:
		bgOpenWindow()
	case menuAuto:
		setAutostart(auto == 0)
	case menuExit:
		trayQuit(true)
	}
}

// bgOpenWindow запускает окно программы; оно само заберёт поток у фонового процесса.
func bgOpenWindow() {
	if !bgOpening.CompareAndSwap(false, true) {
		return
	}
	exe, err := os.Executable()
	if err != nil {
		bgOpening.Store(false)
		return
	}
	procAllowFg.Call(0xFFFFFFFF) // ASFW_ANY: новое окно может выйти на передний план
	c := exec.Command(exe)
	if c.Start() != nil {
		bgOpening.Store(false)
		return
	}
	c.Process.Release()
	go func() { // окно так и не открылось — разрешаем ещё попытку
		time.Sleep(20 * time.Second)
		bgOpening.Store(false)
	}()
}

// trayQuit останавливает поток и закрывает фоновый процесс. byUser — «Выход» в меню значка:
// тогда останавливаем и службу iot_driver, если её запускала программа.
func trayQuit(byUser bool) {
	streamSetCfg(streamCfg{})
	if trayShown {
		procNotifyIcon.Call(2, uintptr(unsafe.Pointer(&trayNid))) // NIM_DELETE
		trayShown = false
	}
	if byUser && bgDriver != nil {
		bgDriver.Kill()
	}
	procDestroyWin.Call(trayHwnd)
}

/* ---------- автозапуск: HKCU\Software\Microsoft\Windows\CurrentVersion\Run ---------- */

func regRun(access uintptr) (uintptr, bool) {
	k, _ := syscall.UTF16PtrFromString(runKey)
	var h uintptr
	r, _, _ := procRegOpenKey.Call(0x80000001, uintptr(unsafe.Pointer(k)), 0, access, uintptr(unsafe.Pointer(&h))) // HKEY_CURRENT_USER
	return h, r == 0
}

func autostartEnabled() bool {
	h, ok := regRun(0x0001) // KEY_QUERY_VALUE
	if !ok {
		return false
	}
	defer procRegClose.Call(h)
	n, _ := syscall.UTF16PtrFromString(runName)
	r, _, _ := procRegQuery.Call(h, uintptr(unsafe.Pointer(n)), 0, 0, 0, 0)
	return r == 0
}

func setAutostart(on bool) {
	h, ok := regRun(0x0002) // KEY_SET_VALUE
	if !ok {
		return
	}
	defer procRegClose.Call(h)
	n, _ := syscall.UTF16PtrFromString(runName)
	if !on {
		procRegDelete.Call(h, uintptr(unsafe.Pointer(n)))
		return
	}
	exe, err := os.Executable()
	if err != nil {
		return
	}
	v, _ := syscall.UTF16FromString("\"" + exe + "\" --background")
	procRegSet.Call(h, uintptr(unsafe.Pointer(n)), 0, 1, uintptr(unsafe.Pointer(&v[0])), uintptr(len(v)*2)) // REG_SZ
}

func putUTF16(dst []uint16, s string) {
	u, _ := syscall.UTF16FromString(s)
	if len(u) > len(dst) {
		u = u[:len(dst)]
		u[len(u)-1] = 0
	}
	copy(dst, u)
}
