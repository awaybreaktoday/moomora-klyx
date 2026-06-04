package main

import (
	"context"
	"embed"
	"log"
	"os"
	"time"

	"github.com/moomora/klyx/internal/appbridge"
	"github.com/moomora/klyx/internal/clock"
	"github.com/moomora/klyx/internal/config"
	"github.com/moomora/klyx/internal/fleet"
	"github.com/wailsapp/wails/v3/pkg/application"
)

// assets embeds the Vite-built frontend. At build time, wails3 build
// compiles frontend/dist and this embed directive picks it up.
//
//go:embed all:frontend/dist
var assets embed.FS

func configPath() string {
	if p := os.Getenv("KLYX_CONFIG"); p != "" {
		return p
	}
	home, _ := os.UserHomeDir()
	return home + "/.config/klyx/fleet.yaml"
}

func main() {
	cfg, err := config.Load(configPath())
	if err != nil {
		log.Printf("warn: could not load fleet config (%v); starting with empty fleet", err)
		cfg = &config.Config{}
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	reg := fleet.NewRegistry(cfg, fleet.DefaultConnFactory(clock.Real{}))
	reg.Start(ctx)

	svc := appbridge.NewFleetService(reg, cfg, time.Now)

	em := &emitterAdapter{}

	gitopsSvc := appbridge.NewGitOpsService(
		func(name string) (appbridge.GitOpsConn, bool) {
			c, ok := reg.Conn(name)
			if !ok {
				return nil, false
			}
			return c, true
		},
		em, time.Now, time.Second,
	)

	app := application.New(application.Options{
		Name:        "Klyx",
		Description: "Platform-engineer-grade Kubernetes desktop client",
		Services: []application.Service{
			application.NewService(svc),
			application.NewService(gitopsSvc),
		},
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
		},
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
	})

	em.app = app

	go svc.Run(ctx, em, time.Second)

	app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title: "Klyx",
		Mac: application.MacWindow{
			InvisibleTitleBarHeight: 0,
			Backdrop:                application.MacBackdropTranslucent,
			TitleBar:                application.MacTitleBarHiddenInset,
		},
		BackgroundColour: application.NewRGB(15, 20, 30),
		URL:              "/",
	})

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}

// emitterAdapter adapts the Wails app event API to appbridge.Emitter.
type emitterAdapter struct{ app *application.App }

func (e *emitterAdapter) Emit(name string, data any) {
	e.app.Event.Emit(name, data)
}
