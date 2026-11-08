// Встроенный веб-сервер: отдаёт интерфейс и проксирует gRPC-web к службе iot_driver.
package main

import (
	_ "embed"
	"fmt"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"sync/atomic"
	"time"
)

//go:embed ui/FLEsportsStudio.html
var page []byte

//go:embed icon.ico
var favicon []byte

const (
	driverAddr = "127.0.0.1:3814"
	uiPort     = 38475 // постоянный порт: настройки интерфейса (свои цвета, имена макросов) сохраняются между запусками
)

var lastPing atomic.Int64

func portOpen(addr string) bool {
	c, err := net.DialTimeout("tcp", addr, 400*time.Millisecond)
	if err != nil {
		return false
	}
	c.Close()
	return true
}

func serveUI() (string, error) {
	target, _ := url.Parse("http://" + driverAddr)
	proxy := httputil.NewSingleHostReverseProxy(target)
	proxy.FlushInterval = -1 // потоковые ответы (список устройств) отдаются сразу
	mux := http.NewServeMux()
	mux.Handle("/driver.DriverGrpc/", proxy)
	mux.HandleFunc("/api/stream", streamHandler)
	mux.HandleFunc("/__alive", func(w http.ResponseWriter, r *http.Request) {
		lastPing.Store(time.Now().Unix())
		w.WriteHeader(204)
	})
	mux.HandleFunc("/favicon.ico", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/x-icon")
		w.Write(favicon)
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.Write(page)
	})
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", uiPort))
	if err != nil {
		ln, err = net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			return "", err
		}
	}
	go http.Serve(ln, mux)
	return "http://" + ln.Addr().String() + "/", nil
}
