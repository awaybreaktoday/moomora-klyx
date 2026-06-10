package fleet

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"

	corev1 "k8s.io/api/core/v1"
	discoveryv1 "k8s.io/api/discovery/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/intstr"
	"k8s.io/client-go/tools/portforward"
	"k8s.io/client-go/transport/spdy"
)

// portForwardReadyTimeout bounds the wait for the SPDY tunnel to come up. A
// dead apiserver or an unreachable pod must surface as an error, not a hang.
const portForwardReadyTimeout = 10 * time.Second

// PortForward starts forwarding localPort -> the pod's targetPort over a SPDY
// tunnel through the apiserver. localPort 0 requests an ephemeral local port.
//
// Returns:
//   - stop: idempotent; closes the SPDY stopCh so the tunnel tears down and the
//     ForwardPorts goroutine exits. Safe to call multiple times (sync.Once).
//   - actualLocal: the bound local port (resolved even when localPort was 0).
//   - done: closed-with-error when the forward dies on its own (tunnel drops,
//     apiserver closes the stream). nil error means a clean stop via stop(); a
//     non-nil error is the failure that killed the tunnel. The appbridge
//     supervisor reads this to flip the forward to "broken".
//   - err: a synchronous failure to establish the tunnel (no transport, never
//     became ready). On err != nil, stop is a no-op, actualLocal 0, done nil.
//
// NOTE: this function is NOT exercisable with a fake clientset - SPDY needs a
// real *rest.Config and a live apiserver. It is kept deliberately thin so the
// untested surface is minimal; ResolveServicePod (the resolution logic) is
// fake-tested, and PortForward itself is covered by native verification.
func (c *ClusterConn) PortForward(ctx context.Context, namespace, pod string, localPort, targetPort int) (stop func(), actualLocal int, done <-chan error, err error) {
	if c.restConfig == nil {
		return nil, 0, nil, fmt.Errorf("port-forward unavailable: no REST config on connection %q", c.name)
	}

	roundTripper, upgrader, err := spdy.RoundTripperFor(c.restConfig)
	if err != nil {
		return nil, 0, nil, fmt.Errorf("spdy transport: %w", err)
	}

	// The portforward subresource URL: POST .../namespaces/<ns>/pods/<pod>/portforward.
	req := c.typed.CoreV1().RESTClient().Post().
		Resource("pods").
		Namespace(namespace).
		Name(pod).
		SubResource("portforward")

	dialer := spdy.NewDialer(upgrader, &http.Client{Transport: roundTripper}, http.MethodPost, req.URL())

	stopCh := make(chan struct{})
	readyCh := make(chan struct{})

	fw, err := portforward.New(
		dialer,
		[]string{fmt.Sprintf("%d:%d", localPort, targetPort)},
		stopCh,
		readyCh,
		io.Discard, // out: per-line "Forwarding from ..." noise, dropped
		io.Discard, // errOut: dropped; the ForwardPorts return value carries the real error
	)
	if err != nil {
		return nil, 0, nil, fmt.Errorf("build port-forwarder: %w", err)
	}

	// stop() must close stopCh exactly once. A double close panics, so guard it.
	var once sync.Once
	stopFn := func() { once.Do(func() { close(stopCh) }) }

	// done carries the forward's eventual exit. ForwardPorts blocks until the
	// tunnel is torn down (stopCh closed) or it errors out; we relay that single
	// value and close done so exactly one read observes the outcome.
	doneCh := make(chan error, 1)
	go func() {
		defer close(doneCh)
		doneCh <- fw.ForwardPorts()
	}()

	// Wait for ready, a self-inflicted early death, the caller's ctx, or timeout.
	timer := time.NewTimer(portForwardReadyTimeout)
	defer timer.Stop()
	select {
	case <-readyCh:
		// Tunnel up.
	case ferr := <-doneCh:
		// ForwardPorts returned before ready: a hard establishment failure.
		stopFn()
		if ferr == nil {
			ferr = fmt.Errorf("port-forward closed before becoming ready")
		}
		return nil, 0, nil, ferr
	case <-ctx.Done():
		stopFn()
		return nil, 0, nil, ctx.Err()
	case <-timer.C:
		stopFn()
		return nil, 0, nil, fmt.Errorf("port-forward to %s/%s did not become ready within %s", namespace, pod, portForwardReadyTimeout)
	}

	ports, err := fw.GetPorts()
	if err != nil || len(ports) == 0 {
		stopFn()
		if err == nil {
			err = fmt.Errorf("port-forward returned no bound ports")
		}
		return nil, 0, nil, err
	}

	return stopFn, int(ports[0].Local), doneCh, nil
}

// ResolveServicePod resolves a Service target to a concrete ready backing pod
// and the numeric container port to forward to. It is the Service->Pod step the
// appbridge runs before calling PortForward (fleet's PortForward stays pod-only).
//
// Resolution:
//  1. GET the Service; find the ServicePort matching `port` (or the sole port).
//  2. List EndpointSlices labelled for the service; pick the first endpoint that
//     is Ready and has a Pod targetRef.
//  3. Resolve the targetPort: a numeric targetPort is used directly; a named
//     targetPort is looked up by name in the chosen pod's container ports.
//
// Errors are honest: no matching service port, no ready endpoints, named port
// not found on the pod.
func (c *ClusterConn) ResolveServicePod(ctx context.Context, namespace, service string, port int) (pod string, targetPort int, err error) {
	svc, err := c.typed.CoreV1().Services(namespace).Get(ctx, service, metav1.GetOptions{})
	if err != nil {
		return "", 0, fmt.Errorf("get service %s/%s: %w", namespace, service, err)
	}

	sp, err := pickServicePort(svc.Spec.Ports, port)
	if err != nil {
		return "", 0, err
	}

	slices, err := c.typed.DiscoveryV1().EndpointSlices(namespace).List(ctx, metav1.ListOptions{
		LabelSelector: discoveryv1.LabelServiceName + "=" + service,
	})
	if err != nil {
		return "", 0, fmt.Errorf("list endpointslices for service %s/%s: %w", namespace, service, err)
	}

	podName, ok := firstReadyPod(slices.Items)
	if !ok {
		return "", 0, fmt.Errorf("no ready endpoints for service %s/%s", namespace, service)
	}

	tp, err := c.resolveTargetPort(ctx, namespace, podName, sp.TargetPort)
	if err != nil {
		return "", 0, err
	}
	return podName, tp, nil
}

// pickServicePort selects the ServicePort matching the requested port. If the
// service has exactly one port, that one is used regardless of `port` (the
// "just forward the service" convenience). Otherwise `port` must match a
// declared service port.
func pickServicePort(ports []corev1.ServicePort, port int) (corev1.ServicePort, error) {
	if len(ports) == 0 {
		return corev1.ServicePort{}, fmt.Errorf("service exposes no ports")
	}
	if len(ports) == 1 {
		return ports[0], nil
	}
	for _, sp := range ports {
		if int(sp.Port) == port {
			return sp, nil
		}
	}
	return corev1.ServicePort{}, fmt.Errorf("port %d not found on service (declared ports vary)", port)
}

// firstReadyPod returns the name of the first endpoint that is Ready (or has no
// Ready condition set, which the EndpointSlice spec treats as ready) and is
// backed by a Pod. Endpoints without a Pod targetRef are skipped - we can only
// port-forward to a pod.
func firstReadyPod(slices []discoveryv1.EndpointSlice) (string, bool) {
	for _, es := range slices {
		for _, ep := range es.Endpoints {
			if ep.Conditions.Ready != nil && !*ep.Conditions.Ready {
				continue
			}
			if ep.TargetRef == nil || ep.TargetRef.Kind != "Pod" || ep.TargetRef.Name == "" {
				continue
			}
			return ep.TargetRef.Name, true
		}
	}
	return "", false
}

// resolveTargetPort turns a ServicePort.TargetPort into a numeric container
// port. A numeric target port is used as-is. A named target port is resolved by
// looking up the containerPort with that name in the chosen pod's spec (a typed
// pod GET).
func (c *ClusterConn) resolveTargetPort(ctx context.Context, namespace, podName string, target intstr.IntOrString) (int, error) {
	if target.Type == intstr.Int {
		if target.IntValue() > 0 {
			return target.IntValue(), nil
		}
		return 0, fmt.Errorf("invalid numeric target port %d", target.IntValue())
	}

	named := target.String()
	p, err := c.typed.CoreV1().Pods(namespace).Get(ctx, podName, metav1.GetOptions{})
	if err != nil {
		return 0, fmt.Errorf("get pod %s/%s to resolve named port %q: %w", namespace, podName, named, err)
	}
	for _, ctr := range p.Spec.Containers {
		for _, cp := range ctr.Ports {
			if cp.Name == named {
				return int(cp.ContainerPort), nil
			}
		}
	}
	return 0, fmt.Errorf("named target port %q not found on any container of pod %s/%s", named, namespace, podName)
}
