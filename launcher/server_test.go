package main

import (
	"os"
	"testing"
	"time"
)

// Запускает только веб-сервер (для сквозного теста через прокси). Адрес пишется в файл.
func TestServeForE2E(t *testing.T) {
	if os.Getenv("Q75_E2E") == "" {
		t.Skip()
	}
	u, err := serveUI()
	if err != nil {
		t.Fatal(err)
	}
	os.WriteFile(os.Getenv("Q75_E2E"), []byte(u), 0o644)
	time.Sleep(150 * time.Second)
}
