package main

import (
	"embed"
	"log"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// assets embeds the Vite-built frontend. At build time, wails3 build
// compiles frontend/dist and this embed directive picks it up.
//
//go:embed all:frontend/dist
var assets embed.FS

func init() {
	// Register typed events so the binding generator emits strongly-typed TS.
	application.RegisterEvent[string]("klyx:ping")
}

func main() {
	app := application.New(application.Options{
		Name:        "Klyx",
		Description: "Platform-engineer-grade Kubernetes desktop client",
		Services: []application.Service{
			application.NewService(&KlyxService{}),
		},
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
		},
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
	})

	app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title: "Klyx",
		Mac: application.MacWindow{
			InvisibleTitleBarHeight: 50,
			Backdrop:                application.MacBackdropTranslucent,
			TitleBar:                application.MacTitleBarHiddenInset,
		},
		BackgroundColour: application.NewRGB(15, 20, 30),
		URL:              "/",
	})

	// Emit klyx:ping once per second so the frontend can prove the Go->JS event bridge works.
	go func() {
		for {
			app.Event.Emit("klyx:ping", "ping from Go at "+time.Now().Format(time.RFC3339))
			time.Sleep(time.Second)
		}
	}()

	err := app.Run()
	if err != nil {
		log.Fatal(err)
	}
}
