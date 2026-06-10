package appbridge

import (
	"fmt"
	"net/url"
)

// WindowOpener abstracts native window creation so WindowsService is testable
// without a running Wails app. main.go supplies the real implementation backed
// by app.Window.NewWithOptions; tests supply a fake that records calls.
type WindowOpener interface {
	OpenWindow(title, url string, width, height int)
}

const (
	// logsWindowWidth / logsWindowHeight size a pop-out log window. Wide enough
	// for unwrapped log lines, tall enough for a useful tail.
	logsWindowWidth  = 980
	logsWindowHeight = 560
)

// WindowsService opens native auxiliary windows (currently: pop-out log tails).
// It is the first multi-window surface in Klyx. Window creation is delegated to
// a WindowOpener so the URL/title/size logic stays unit-testable.
type WindowsService struct {
	opener WindowOpener
}

// NewWindowsService wires the window opener.
func NewWindowsService(opener WindowOpener) *WindowsService {
	return &WindowsService{opener: opener}
}

// OpenLogsWindow opens a native window that tails one container's logs. The new
// window boots the SAME SPA with a `logswin=1` query flag, which the frontend
// detects to render only the log pane (no fleet subscriptions, no sidebar). The
// popout opens its own log stream and closes it best-effort on window unload;
// the per-stream cap and the app-quit CloseAll drain are the backstops if that
// best-effort close is missed.
//
// Validation: cluster, namespace and pod must be non-empty. container may be
// empty (the pane then picks the pod's first container) but the dock always
// passes the currently-selected one.
func (s *WindowsService) OpenLogsWindow(cluster, namespace, pod, container string) ActionResultDTO {
	if cluster == "" || namespace == "" || pod == "" {
		return ActionResultDTO{Error: "cluster, namespace and pod are required"}
	}

	q := url.Values{}
	q.Set("logswin", "1")
	q.Set("cluster", cluster)
	q.Set("ns", namespace)
	q.Set("pod", pod)
	q.Set("container", container)

	target := "/?" + q.Encode()
	title := fmt.Sprintf("logs · %s/%s", namespace, pod)

	s.opener.OpenWindow(title, target, logsWindowWidth, logsWindowHeight)
	return ActionResultDTO{OK: true}
}
