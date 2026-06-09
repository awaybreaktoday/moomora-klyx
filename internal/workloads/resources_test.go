package workloads

import (
	"testing"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
)

func ctr(name string, reqCPU, limCPU, reqMem, limMem string) corev1.Container {
	c := corev1.Container{Name: name, Resources: corev1.ResourceRequirements{
		Requests: corev1.ResourceList{}, Limits: corev1.ResourceList{},
	}}
	if reqCPU != "" {
		c.Resources.Requests[corev1.ResourceCPU] = resource.MustParse(reqCPU)
	}
	if limCPU != "" {
		c.Resources.Limits[corev1.ResourceCPU] = resource.MustParse(limCPU)
	}
	if reqMem != "" {
		c.Resources.Requests[corev1.ResourceMemory] = resource.MustParse(reqMem)
	}
	if limMem != "" {
		c.Resources.Limits[corev1.ResourceMemory] = resource.MustParse(limMem)
	}
	return c
}

func podWith(containers ...corev1.Container) *corev1.Pod {
	return &corev1.Pod{Spec: corev1.PodSpec{Containers: containers}}
}

func TestAggregateResourcesAllCapped(t *testing.T) {
	pods := []*corev1.Pod{podWith(ctr("app", "250m", "500m", "256Mi", "512Mi"))}
	r := aggregateResources(pods)
	if r.CPU.Limit == nil || *r.CPU.Limit != 0.5 {
		t.Fatalf("cpu limit: got %v want 0.5", r.CPU.Limit)
	}
	if r.CPU.Request == nil || *r.CPU.Request != 0.25 {
		t.Fatalf("cpu request: got %v want 0.25", r.CPU.Request)
	}
	if r.Mem.Limit == nil || *r.Mem.Limit != 512*1024*1024 {
		t.Fatalf("mem limit: got %v want 536870912", r.Mem.Limit)
	}
	if r.Mem.Usage != nil {
		t.Fatalf("usage must be nil (filled later), got %v", r.Mem.Usage)
	}
}

func TestAggregateResourcesAnyUncappedMeansNilLimit(t *testing.T) {
	pods := []*corev1.Pod{podWith(
		ctr("app", "250m", "500m", "256Mi", "512Mi"),
		ctr("sidecar", "50m", "100m", "64Mi", ""), // no mem limit
	)}
	r := aggregateResources(pods)
	if r.Mem.Limit != nil {
		t.Fatalf("mem limit must be nil when any container uncapped, got %v", *r.Mem.Limit)
	}
	if r.CPU.Limit == nil || *r.CPU.Limit != 0.6 {
		t.Fatalf("cpu limit: got %v want 0.6 (0.5+0.1)", r.CPU.Limit)
	}
}

func TestAggregateResourcesMissingRequestMeansNil(t *testing.T) {
	pods := []*corev1.Pod{podWith(ctr("app", "", "500m", "256Mi", "512Mi"))} // no cpu request
	r := aggregateResources(pods)
	if r.CPU.Request != nil {
		t.Fatalf("cpu request must be nil when any container lacks it, got %v", *r.CPU.Request)
	}
	if r.CPU.Limit == nil || *r.CPU.Limit != 0.5 {
		t.Fatalf("cpu limit should still be 0.5, got %v", r.CPU.Limit)
	}
}

func TestAggregateResourcesNoPodsAllNil(t *testing.T) {
	r := aggregateResources(nil)
	if r.CPU.Limit != nil || r.CPU.Request != nil || r.Mem.Limit != nil || r.Mem.Request != nil {
		t.Fatalf("no pods must yield all-nil cells, got %+v", r)
	}
}

func TestAggregateResourcesInitContainersExcluded(t *testing.T) {
	p := podWith(ctr("app", "250m", "500m", "256Mi", "512Mi"))
	p.Spec.InitContainers = []corev1.Container{ctr("init", "", "", "", "")}
	r := aggregateResources([]*corev1.Pod{p})
	if r.Mem.Limit == nil || *r.Mem.Limit != 512*1024*1024 {
		t.Fatalf("init container must be excluded; mem limit should be 512Mi, got %v", r.Mem.Limit)
	}
}
