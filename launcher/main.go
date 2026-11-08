//go:build windows

// FL Esports Studio — Windows-приложение.
// Открывает интерфейс в собственном окне (WebView2), запускает и останавливает
// фоновую службу iot_driver.exe, проксирует к ней запросы на том же адресе.
// После закрытия окна живую подсветку продолжает фоновый процесс (tray_windows.go).
package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"syscall"
	"time"
	"unsafe"

	webview2 "github.com/jchv/go-webview2"
)

const appTitle = "FL Esports Studio"

var (
	user32         = syscall.NewLazyDLL("user32.dll")
	procMessageBox = user32.NewProc("MessageBoxW")
	shell32        = syscall.NewLazyDLL("shell32.dll")
	procShellExec  = shell32.NewProc("ShellExecuteW")
	dwmapi         = syscall.NewLazyDLL("dwmapi.dll")
	procDwmSetAttr = dwmapi.NewProc("DwmSetWindowAttribute")
	procSetWinPos  = user32.NewProc("SetWindowPos")
)

func msgBox(text string, icon uint32) {
	t, _ := syscall.UTF16PtrFromString(text)
	c, _ := syscall.UTF16PtrFromString(appTitle)
	procMessageBox.Call(0, uintptr(unsafe.Pointer(t)), uintptr(unsafe.Pointer(c)), uintptr(icon))
}

// Поиск iot_driver.exe: рядом с программой, в папке оригинального драйвера, в его копиях в AppData.
// Тёмная рамка окна в цветах программы (Windows 10 1809+ и Windows 11).
func darkTitleBar(hwnd uintptr) {
	if hwnd == 0 || procDwmSetAttr.Find() != nil {
		return
	}
	set := func(attr uint32, val uint32) uintptr {
		r, _, _ := procDwmSetAttr.Call(hwnd, uintptr(attr), uintptr(unsafe.Pointer(&val)), 4)
		return r
	}
	if set(20, 1) != 0 { // DWMWA_USE_IMMERSIVE_DARK_MODE
		set(19, 1) // старые сборки Windows 10
	}
	set(35, 0x00131212) // DWMWA_CAPTION_COLOR = #050506 (как фон программы), только Windows 11
	set(36, 0x00EDEDED) // DWMWA_TEXT_COLOR
	set(34, 0x00131212) // DWMWA_BORDER_COLOR
	// перерисовать рамку
	procSetWinPos.Call(hwnd, 0, 0, 0, 0, 0, 0x0001|0x0002|0x0004|0x0020) // NOSIZE|NOMOVE|NOZORDER|FRAMECHANGED
}

func findDriver() string {
	exe, _ := os.Executable()
	dir := filepath.Dir(exe)
	env := os.Getenv
	cands := []string{
		filepath.Join(dir, "iot_driver.exe"),
		filepath.Join(dir, "F. L Driver", "resources", "app", "iot_driver.exe"),
		filepath.Join(env("LOCALAPPDATA"), "Programs", "F. L Driver", "resources", "app", "iot_driver.exe"),
		filepath.Join(env("ProgramFiles"), "F. L Driver", "resources", "app", "iot_driver.exe"),
		filepath.Join(env("ProgramFiles(x86)"), "F. L Driver", "resources", "app", "iot_driver.exe"),
	}
	for _, c := range cands {
		if st, err := os.Stat(c); err == nil && !st.IsDir() {
			return c
		}
	}
	m, _ := filepath.Glob(filepath.Join(env("APPDATA"), "F. L Driver", "iot_driver_*.exe"))
	if len(m) > 0 {
		sort.Strings(m)
		return m[len(m)-1]
	}
	return ""
}

func startDriver() (*exec.Cmd, string) {
	if portOpen(driverAddr) {
		return nil, "" // служба уже работает (например, запущена оригинальным драйвером)
	}
	path := findDriver()
	if path == "" {
		return nil, "Не найден iot_driver.exe — служба доступа к клавиатуре.\n\n" +
			"Скопируйте файл iot_driver.exe из папки оригинального драйвера\n" +
			"«F. L Driver\\resources\\app\\» в папку с FL Esports Studio.exe и запустите программу ещё раз.\n\n" +
			"Сейчас программа откроется в демо-режиме."
	}
	cmd := exec.Command(path)
	work := filepath.Join(os.Getenv("LOCALAPPDATA"), "Q75Studio")
	os.MkdirAll(work, 0o755)
	cmd.Dir = work                                                                      // служба создаёт рядом папку iot_db — кладём её в доступное для записи место
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000} // CREATE_NO_WINDOW
	if err := cmd.Start(); err != nil {
		return nil, "Не удалось запустить " + path + ":\n" + err.Error()
	}
	for i := 0; i < 50 && !portOpen(driverAddr); i++ {
		time.Sleep(100 * time.Millisecond)
	}
	return cmd, ""
}

func openInBrowser(u string) {
	// Edge в режиме приложения, иначе браузер по умолчанию
	if err := exec.Command("cmd", "/c", "start", "", "msedge", "--app="+u, "--window-size=1440,900").Run(); err == nil {
		return
	}
	verb, _ := syscall.UTF16PtrFromString("open")
	file, _ := syscall.UTF16PtrFromString(u)
	procShellExec.Call(0, uintptr(unsafe.Pointer(verb)), uintptr(unsafe.Pointer(file)), 0, 0, 1)
}

func main() {
	if hasArg("--background") {
		runBackground(hasArg("--handover")) // без окна: поток живой подсветки и значок у часов
		return
	}
	// Окно открывают снова: фоновый процесс (если он есть) отдаёт поток окну и завершается.
	drvProc := stopBackground()
	drv, warn := startDriver()
	if drv != nil {
		drvProc = drv.Process
	}
	keepDriver := false
	defer func() {
		if drvProc != nil && !keepDriver {
			drvProc.Kill() // останавливаем службу, только если её запускала программа и фону она не нужна
		}
	}()

	u, err := serveUI()
	if err != nil {
		msgBox("Не удалось запустить интерфейс: "+err.Error(), 0x10)
		return
	}
	if warn != "" {
		go msgBox(warn, 0x30)
	}

	dataDir := filepath.Join(os.Getenv("LOCALAPPDATA"), "Q75Studio", "WebView2")
	os.Setenv("WEBVIEW2_DEFAULT_BACKGROUND_COLOR", "FF121213") // без белой вспышки до загрузки страницы
	w := webview2.NewWithOptions(webview2.WebViewOptions{
		Debug:     false,
		AutoFocus: true,
		DataPath:  dataDir,
		WindowOptions: webview2.WindowOptions{
			Title:  appTitle,
			Width:  1440,
			Height: 900,
			IconId: 2, // ресурс: 1 — манифест, 2 — иконка
			Center: true,
		},
	})
	if w == nil {
		// Нет WebView2 Runtime — открываем в браузере и работаем, пока открыта вкладка.
		openInBrowser(u)
		lastPing.Store(time.Now().Unix() + 60)
		for time.Now().Unix()-lastPing.Load() < 20 {
			time.Sleep(2 * time.Second)
		}
		keepDriver = handOverToBackground(drvProc)
		return
	}
	defer w.Destroy()
	darkTitleBar(uintptr(w.Window()))
	w.SetTitle(appTitle)
	w.SetSize(1440, 900, webview2.HintNone)
	w.Navigate(u)
	w.Run()
	// Окно закрыли: если включены «Под музыку» или «Цвет экрана», поток продолжает фоновый процесс.
	keepDriver = handOverToBackground(drvProc)
}
