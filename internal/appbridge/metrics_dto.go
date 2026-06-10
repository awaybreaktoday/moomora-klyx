package appbridge

// MetricsDTO is the on-demand cluster metrics payload. Nil fractions serialize
// as JSON null (the UI renders "—"), never 0.
type MetricsDTO struct {
	Available   bool     `json:"available"`
	Mode        string   `json:"mode"`
	Source      string   `json:"source"`
	Warning     string   `json:"warning"`
	Reason      string   `json:"reason"`
	CPUFraction *float64 `json:"cpuFraction"`
	MemFraction *float64 `json:"memFraction"`
}

// PointDTO is one timestamped sample (unix seconds). Consecutive points may be
// more than one step apart — Prometheus omits empty steps and the UI renders
// the gap, never interpolates across it.
type PointDTO struct {
	T int64   `json:"t"`
	V float64 `json:"v"`
}

// SparklinesDTO carries a 30m cpu/mem series pair. Available=false means no
// usable data (Message says why); empty slices with Available=true mean "no
// samples in the window", which is real information, not an error.
type SparklinesDTO struct {
	Available bool       `json:"available"`
	Message   string     `json:"message,omitempty"`
	CPU       []PointDTO `json:"cpu"`
	Mem       []PointDTO `json:"mem"`
}
