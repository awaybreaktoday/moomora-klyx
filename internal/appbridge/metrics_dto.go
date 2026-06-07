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
