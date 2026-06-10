package appbridge

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os/exec"
	"sync"
	"sync/atomic"
	"time"
)

// NodeOpsConn is the per-cluster surface NodeOpsService needs.
type NodeOpsConn interface {
	SetCordon(ctx context.Context, nodeName string, cordon bool) error
	DrainNodeCmd(nodeName string) (*exec.Cmd, error)
}

// drainStream is one live drain process.
type drainStream struct {
	cancel context.CancelFunc // cancels the supervisor goroutine
	cmd    *exec.Cmd          // the running kubectl drain process
	done   chan struct{}      // closed when the reader goroutine has fully exited
}

const (
	// maxConcurrentDrains caps simultaneous drain processes. A drain holds a
	// process open for up to 120s; more than 2 at once is unusual.
	maxConcurrentDrains = 2
)

// NodeOpsService is bound to JS and handles cordon/uncordon and drain.
//
// Drain lifecycle mirrors LogsService: supervisor goroutine kills the process
// on context cancel; reader goroutine owns the pipe, batches lines to the
// "nodedrain:<streamID>" event, and emits a terminal EOF chunk on exit.
type NodeOpsService struct {
	lookup func(string) (NodeOpsConn, bool)
	em     Emitter

	seq atomic.Uint64

	mu     sync.Mutex
	drains map[string]*drainStream
	order  []string // insertion order, for oldest-first eviction
}

// NewNodeOpsService wires the cluster lookup and event emitter.
func NewNodeOpsService(lookup func(string) (NodeOpsConn, bool), em Emitter) *NodeOpsService {
	return &NodeOpsService{
		lookup: lookup,
		em:     em,
		drains: map[string]*drainStream{},
	}
}

// Cordon cordons (unschedulable=true) or uncordons (unschedulable=false) a node.
func (s *NodeOpsService) Cordon(cluster, node string, cordon bool) ActionResultDTO {
	conn, ok := s.lookup(cluster)
	if !ok {
		return ActionResultDTO{Error: "cluster not connected: " + cluster}
	}
	ctx, cancel := context.WithTimeout(context.Background(), actionTimeout)
	defer cancel()
	if err := conn.SetCordon(ctx, node, cordon); err != nil {
		return ActionResultDTO{Error: err.Error()}
	}
	return ActionResultDTO{OK: true}
}

// drainPipe wraps a PipeReader; its Close also closes the write end so the
// supervisor kill + pipe close truly unblocks the reader in all paths.
type drainPipe struct {
	*io.PipeReader
	pw *io.PipeWriter
}

func (p *drainPipe) Close() error {
	_ = p.pw.Close()
	return p.PipeReader.Close()
}

// StartDrain starts a kubectl drain process for the given node and returns a
// streamID. The frontend subscribes to "nodedrain:<streamID>" for LogChunkDTO
// events. The terminal chunk has EOF=true; Error is set if kubectl exited
// non-zero or was killed.
//
// Cap: if maxConcurrentDrains drains are already running, the oldest is
// evicted (process killed) before registering the new one.
func (s *NodeOpsService) StartDrain(cluster, node string) OpenLogStreamResultDTO {
	conn, ok := s.lookup(cluster)
	if !ok {
		return OpenLogStreamResultDTO{Error: "cluster not connected: " + cluster}
	}

	cmd, err := conn.DrainNodeCmd(node)
	if err != nil {
		return OpenLogStreamResultDTO{Error: err.Error()}
	}

	// Combine stdout+stderr into a single io.Pipe. The write end is owned by the
	// subprocess via cmd.Stdout/Stderr; the read end is owned by the reader goroutine.
	// The supervisor closes the read end (via drainPipe.Close) on cancel, which
	// also closes the write end, so the scanner unblocks in all paths.
	pr, pw := io.Pipe()
	cmd.Stdout = pw
	cmd.Stderr = pw
	rc := &drainPipe{PipeReader: pr, pw: pw}

	if err := cmd.Start(); err != nil {
		_ = rc.Close()
		return OpenLogStreamResultDTO{Error: "start drain: " + err.Error()}
	}

	// Close the write end after the process exits. This is the normal EOF path;
	// the supervisor close handles the cancel path. Both are idempotent.
	waitDone := make(chan struct{})
	go func() {
		_ = cmd.Wait()
		_ = pw.Close()
		close(waitDone)
	}()

	streamID := fmt.Sprintf("drain/%s/%s#%d", cluster, node, s.seq.Add(1))
	ctx, cancel := context.WithCancel(context.Background())
	ds := &drainStream{cancel: cancel, cmd: cmd, done: make(chan struct{})}

	s.mu.Lock()
	// Evict oldest if at cap (same invariant as LogsService).
	for len(s.order) >= maxConcurrentDrains {
		oldest := s.order[0]
		s.order = s.order[1:]
		if ev := s.drains[oldest]; ev != nil {
			delete(s.drains, oldest)
			ev.cancel()
			if ev.cmd.Process != nil {
				_ = ev.cmd.Process.Kill()
			}
		}
	}
	s.drains[streamID] = ds
	s.order = append(s.order, streamID)
	s.mu.Unlock()

	// Supervisor: kill process and close the pipe on cancel so the reader
	// goroutine unblocks. rc.Close is idempotent with the wait goroutine close.
	go func() {
		<-ctx.Done()
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		_ = rc.Close()
	}()

	go s.readDrain(ctx, streamID, rc, waitDone)

	return OpenLogStreamResultDTO{StreamID: streamID}
}

// CancelAll cancels every running drain (app shutdown: child kubectl
// processes must not outlive the app). Idempotent.
func (s *NodeOpsService) CancelAll() {
	s.mu.Lock()
	ids := make([]string, 0, len(s.drains))
	for id := range s.drains {
		ids = append(ids, id)
	}
	s.mu.Unlock()
	for _, id := range ids {
		s.CancelDrain(id)
	}
}

// CancelDrain kills the running drain process and waits briefly for the reader
// to exit. Idempotent: unknown or already-finished ids are no-ops.
func (s *NodeOpsService) CancelDrain(streamID string) {
	s.mu.Lock()
	ds := s.drains[streamID]
	s.mu.Unlock()
	if ds == nil {
		return
	}
	ds.cancel()
	select {
	case <-ds.done:
	case <-time.After(closeWaitTimeout):
	}
}

// readDrain is the single reader goroutine for one drain stream. It mirrors
// the batched-emit discipline of LogsService.read exactly.
func (s *NodeOpsService) readDrain(ctx context.Context, streamID string, rc io.ReadCloser, waitDone <-chan struct{}) {
	scanner := bufio.NewScanner(rc)
	scanner.Buffer(make([]byte, logScanInitial), logScanMax)

	ticker := time.NewTicker(logBatchInterval)
	defer ticker.Stop()

	var batch []string
	flush := func() {
		if len(batch) == 0 {
			return
		}
		s.em.Emit("nodedrain:"+streamID, LogChunkDTO{Lines: batch})
		batch = nil
	}

	lines := make(chan string)
	go func() {
		defer close(lines)
		for scanner.Scan() {
			select {
			case lines <- scanner.Text():
			case <-ctx.Done():
				return
			}
		}
	}()

	for {
		select {
		case <-ctx.Done():
			flush()
			s.finishDrain(streamID, rc, "")
			return
		case <-ticker.C:
			flush()
		case line, ok := <-lines:
			if !ok {
				flush()
				// Wait for cmd.Wait() to complete so ProcessState is populated.
				<-waitDone
				errMsg := ""
				if ps := s.drainExitMsg(streamID); ps != "" {
					errMsg = ps
				}
				s.finishDrain(streamID, rc, errMsg)
				return
			}
			batch = append(batch, line)
			if len(batch) >= logBatchMaxLines {
				flush()
			}
		}
	}
}

// drainExitMsg returns a non-empty string if the process for this streamID
// exited with a non-zero status. It reads ProcessState under the stream's cmd.
func (s *NodeOpsService) drainExitMsg(streamID string) string {
	s.mu.Lock()
	ds := s.drains[streamID]
	s.mu.Unlock()
	if ds == nil {
		return ""
	}
	if ps := ds.cmd.ProcessState; ps != nil && !ps.Success() {
		return fmt.Sprintf("exit status %d", ps.ExitCode())
	}
	return ""
}

func (s *NodeOpsService) finishDrain(streamID string, rc io.ReadCloser, errMsg string) {
	s.em.Emit("nodedrain:"+streamID, LogChunkDTO{Lines: []string{}, EOF: true, Error: errMsg})
	_ = rc.Close()

	s.mu.Lock()
	ds := s.drains[streamID]
	delete(s.drains, streamID)
	for i, id := range s.order {
		if id == streamID {
			s.order = append(s.order[:i], s.order[i+1:]...)
			break
		}
	}
	s.mu.Unlock()

	if ds != nil {
		ds.cancel() // idempotent; release context
		close(ds.done)
	}
}
