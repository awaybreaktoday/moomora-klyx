package fleet

import (
	"context"
	"fmt"
	"sort"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/fields"
	"k8s.io/apimachinery/pkg/runtime/schema"

	"github.com/moomora/klyx/internal/crd"
)

// ListCRDs lists the cluster's CustomResourceDefinitions and parses them. A
// single cheap dynamic list; no watch.
func (c *ClusterConn) ListCRDs(ctx context.Context) ([]crd.Info, error) {
	list, err := c.dyn.Resource(crd.GVR).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	out := make([]crd.Info, 0, len(list.Items))
	for i := range list.Items {
		u := &unstructured.Unstructured{Object: list.Items[i].Object}
		if info, ok := crd.ParseCRD(u); ok {
			out = append(out, info)
		}
	}
	return out, nil
}

// CountResource returns a hybrid instance count for a kind via a single
// metadata-only list page (Limit=crd.Cap). count is exact below the cap; at the
// cap with a continue token it is the cap and capped=true.
func (c *ClusterConn) CountResource(ctx context.Context, group, version, plural string) (int, bool, error) {
	gvr := schema.GroupVersionResource{Group: group, Version: version, Resource: plural}
	list, err := c.meta.Resource(gvr).List(ctx, metav1.ListOptions{Limit: crd.Cap})
	if err != nil {
		return 0, false, err
	}
	count, capped := crd.CountDisplay(len(list.Items), list.GetContinue())
	return count, capped, nil
}

// ListInstances returns one metadata-only page of instances of a kind plus the
// next continue token ("" on the last page). A single list page; no watch.
func (c *ClusterConn) ListInstances(ctx context.Context, group, version, plural string, limit int64, continueToken string) ([]crd.InstanceMeta, string, error) {
	gvr := schema.GroupVersionResource{Group: group, Version: version, Resource: plural}
	list, err := c.meta.Resource(gvr).List(ctx, metav1.ListOptions{Limit: limit, Continue: continueToken})
	if err != nil {
		return nil, "", err
	}
	out := make([]crd.InstanceMeta, 0, len(list.Items))
	for i := range list.Items {
		m := &list.Items[i]
		out = append(out, crd.InstanceMeta{
			Namespace: m.GetNamespace(),
			Name:      m.GetName(),
			Created:   m.GetCreationTimestamp().Time,
		})
	}
	return out, list.GetContinue(), nil
}

// GetInstanceDetail fetches one object (full YAML + conditions + header) plus its
// describe-style Events (filtered by involvedObject.uid). Snapshot; no watch.
func (c *ClusterConn) GetInstanceDetail(ctx context.Context, group, version, plural, ns, name string) (crd.InstanceDetail, error) {
	gvr := schema.GroupVersionResource{Group: group, Version: version, Resource: plural}
	var (
		u   *unstructured.Unstructured
		err error
	)
	if ns == "" {
		u, err = c.dyn.Resource(gvr).Get(ctx, name, metav1.GetOptions{})
	} else {
		u, err = c.dyn.Resource(gvr).Namespace(ns).Get(ctx, name, metav1.GetOptions{})
	}
	if err != nil {
		return crd.InstanceDetail{}, err
	}

	// Mask secret values before producing YAML and building the DTO. The masking
	// happens at the unstructured level so the raw object is never passed to
	// ToYAML with live data, and secret key info travels separately.
	obj := u.Object
	var secretKeys []crd.SecretKeyInfo
	if group == "" && version == "v1" && plural == "secrets" {
		obj, secretKeys = crd.MaskSecretData(obj)
	}

	y, _ := crd.ToYAML(obj)
	d := crd.InstanceDetail{
		Kind:       u.GetKind(),
		Namespace:  ns,
		Name:       name,
		Created:    u.GetCreationTimestamp().Time,
		Labels:     u.GetLabels(),
		Conditions: crd.ParseConditions(u.Object),
		YAML:       y,
		SecretKeys: secretKeys,
	}
	d.Events = c.instanceEvents(ctx, string(u.GetUID()))
	return d, nil
}

// RevealSecretKey fetches the decoded value of one key from a Secret.
// secret.Data is already []byte (client-go decodes base64 transparently).
// Returns an error for missing key or missing secret. The value is returned
// as a string and is NEVER logged.
func (c *ClusterConn) RevealSecretKey(ctx context.Context, ns, name, key string) (string, error) {
	secret, err := c.typed.CoreV1().Secrets(ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return "", err
	}
	b, ok := secret.Data[key]
	if !ok {
		return "", fmt.Errorf("key %q not found in secret %s/%s", key, ns, name)
	}
	return string(b), nil
}

// instanceEvents lists core Events for an object's uid, newest first. A list
// error degrades to no events (the detail still renders).
func (c *ClusterConn) instanceEvents(ctx context.Context, uid string) []crd.Event {
	if uid == "" {
		return nil
	}
	sel := fields.OneTermEqualSelector("involvedObject.uid", uid).String()
	list, err := c.typed.CoreV1().Events("").List(ctx, metav1.ListOptions{FieldSelector: sel, Limit: 50})
	if err != nil || list == nil {
		return nil
	}
	out := make([]crd.Event, 0, len(list.Items))
	for i := range list.Items {
		e := &list.Items[i]
		last := e.LastTimestamp.Time
		if last.IsZero() {
			last = e.EventTime.Time
		}
		out = append(out, crd.Event{Type: e.Type, Reason: e.Reason, Message: e.Message, Count: e.Count, Last: last})
	}
	sort.Slice(out, func(a, b int) bool { return out[a].Last.After(out[b].Last) })
	return out
}
