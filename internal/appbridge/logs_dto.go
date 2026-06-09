package appbridge

// LogChunkDTO is one batched emission on the podlogs:<streamID> event. Lines is
// a batch of log lines (never per-line; the reader coalesces). EOF marks the
// stream's end (pod gone, or previous-container logs fully drained). Error
// carries a terminal message and is "" on a clean end.
type LogChunkDTO struct {
	Lines []string `json:"lines"`
	EOF   bool     `json:"eof"`
	Error string   `json:"error,omitempty"`
}

// OpenLogStreamResultDTO is returned synchronously from OpenLogStream. On
// success StreamID is set and Error is ""; on failure StreamID is "" and Error
// explains. The frontend subscribes to "podlogs:"+StreamID for the stream.
type OpenLogStreamResultDTO struct {
	StreamID string `json:"streamId"`
	Error    string `json:"error,omitempty"`
}
